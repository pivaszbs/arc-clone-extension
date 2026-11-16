import { seriesFiles, seriesRoot, type SeriesPlan } from '../japanese/series';

const key = 'arc_series_downloads';
const alarm = 'arc-series-downloads';
type FileJob = { url: string; filename: string; id?: number; state: 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'; error?: string };
export type SeriesQueue = { title: string; folder: string; paused: boolean; files: FileJob[] };
let running: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>) {
  const next = running.then(work);
  running = next.catch(() => {});
  return next;
}

async function load(): Promise<SeriesQueue | undefined> {
  return (await chrome.storage.local.get(key))[key];
}

async function save(queue: SeriesQueue) {
  await chrome.storage.local.set({ [key]: queue });
}

function createQueue(plan: SeriesPlan, selectedPages: string[], existingFolder?: string): SeriesQueue {
  const { folder: defaultFolder, files } = seriesFiles(plan, selectedPages);
  const folder = `Arc Anime/${existingFolder ?? defaultFolder}`;
  return {
    title: plan.title,
    folder,
    paused: false,
    files: files.map(file => ({ url: file.url, filename: `${folder}/${file.name}`, state: 'queued' as const }))
  };
}

function appendEpisodes(queue: SeriesQueue | undefined, next: SeriesQueue) {
  const sameFolder = queue?.folder === next.folder;
  if (!sameFolder) {
    if (queue?.files.some(file => file.state === 'queued' || file.state === 'downloading')) {
      throw new Error('Another series is downloading. Finish or stop it in Downloads, then try again.');
    }
    return next;
  }
  const episode = (file: FileJob) => file.filename.split('/').at(-1)?.match(/^Episode (\d+) - /)?.[1];
  const pendingOrDone = new Set(queue.files
    .filter(file => file.filename.endsWith('.mp4') && (file.state === 'done' || file.state === 'queued' || file.state === 'downloading'))
    .map(episode));
  const added = next.files.filter(file => !pendingOrDone.has(episode(file)));
  const newEpisodes = new Set(added.map(episode));
  const existing = queue.files.filter(file => !newEpisodes.has(episode(file)) || (file.state !== 'failed' && file.state !== 'canceled'));
  const kept = new Set(existing.map(file => file.filename));
  return {
    ...queue,
    paused: queue.paused && existing.some(file => file.state === 'queued' || file.state === 'downloading'),
    files: [...existing, ...added.filter(file => !kept.has(file.filename))]
  };
}

function isCompletedFile(download?: chrome.downloads.DownloadItem) {
  return download?.state === 'complete' && download.exists !== false
    && !/^(text\/html|application\/json)(?:;|$)/i.test(download.mime || '');
}

async function cancelTransfer(queue: SeriesQueue, file: FileJob) {
  queue.paused = true;
  await save(queue);
  if (file.id !== undefined) {
    await chrome.downloads.cancel(file.id);
    const [download] = await chrome.downloads.search({ id: file.id });
    if (download?.state === 'in_progress') throw new Error('The queue is paused. Try stopping the active file again.');
    file.state = isCompletedFile(download) ? 'done' : 'canceled';
  } else file.state = 'canceled';
}

async function applySelection(queue: SeriesQueue, next: SeriesQueue) {
  if (queue.folder !== next.folder) throw new Error('Stop the current batch before starting another edition.');
  next.paused = queue.paused;
  for (const file of queue.files) {
    if (file.state !== 'done' && file.state !== 'downloading') continue;
    const index = next.files.findIndex(candidate => candidate.filename === file.filename && candidate.url === file.url);
    if (index >= 0) next.files[index] = file;
    else if (file.state === 'downloading') await cancelTransfer(queue, file);
  }
  return next;
}

async function pump() {
  const queue = await load();
  if (!queue || !chrome.downloads) return queue;
  const current = queue.files.find(file => file.state === 'downloading');
  if (current) {
    const [download] = await chrome.downloads.search({ id: current.id });
    if (download?.state === 'in_progress') return queue;
    const webpage = /^(text\/html|application\/json)(?:;|$)/i.test(download?.mime || '');
    current.state = isCompletedFile(download) ? 'done' : 'failed';
    current.error = current.state === 'failed' ? (download?.error || (webpage ? 'Site returned a webpage' : 'Download missing')) : undefined;
    await save(queue);
  }

  const next = queue.paused ? undefined : queue.files.find(file => file.state === 'queued');
  if (!next) {
    await chrome.alarms.clear(alarm);
    return queue;
  }
  try {
    // Chrome owns the bytes and the resumable transfer. A stable filename also
    // lets the next service worker find a transfer started just before a restart.
    const suffix = next.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[/\\\\]');
    const previous = await chrome.downloads.search({ url: next.url, filenameRegex: suffix + '$', orderBy: ['-startTime'] });
    const existing = previous.find(item => item.byExtensionId === chrome.runtime.id && (item.state === 'in_progress' ||
      (item.state === 'complete' && item.exists && !/^(text\/html|application\/json)(?:;|$)/i.test(item.mime))));
    next.id = existing?.id ?? await chrome.downloads.download({
      url: next.url, filename: next.filename, conflictAction: 'uniquify', saveAs: false
    });
    next.state = 'downloading';
  } catch (error) {
    next.state = 'failed';
    next.error = error instanceof Error ? error.message : 'Could not start download';
  }
  await save(queue);
  return queue;
}

const wake = () => { void serialize(pump).catch(() => {}); };
chrome.alarms?.onAlarm.addListener(event => { if (event.name === alarm) wake(); });
const fileChanged = (event: chrome.downloads.DownloadDelta) => { if (event.state) wake(); };
function watchDownloads() {
  const changed = chrome.downloads?.onChanged;
  if (changed && !changed.hasListener(fileChanged)) changed.addListener(fileChanged);
}
watchDownloads();
chrome.runtime.onStartup.addListener(() => {
  void serialize(async () => {
    const queue = await load();
    if (!chrome.downloads || !queue?.files.some(file => file.state === 'downloading' || (!queue.paused && file.state === 'queued'))) return;
    await chrome.alarms.create(alarm, { periodInMinutes: 0.5 });
    await pump();
  }).catch(() => {});
});

export function seriesDownloadRequest(message: { type: string; plan?: SeriesPlan; selectedPages?: string[]; folder?: string }, sender: chrome.runtime.MessageSender) {
  return serialize(async () => {
    if (sender.url !== chrome.runtime.getURL('offline.html') && !sender.url?.startsWith(chrome.runtime.getURL('offline.html') + '?')) {
      throw new Error('Open Offline study to manage series downloads.');
    }
    if (message.type === 'SERIES_DOWNLOAD_STATUS') return { queue: await load() };
    if (!chrome.downloads) throw new Error('Allow Chrome downloads to start the queue.');
    watchDownloads();
    let queue = await load();
    const adding = message.type === 'SERIES_DOWNLOAD_ADD';
    if (adding || message.type === 'SERIES_DOWNLOAD_START' || message.type === 'SERIES_DOWNLOAD_APPLY') {
      const applying = message.type === 'SERIES_DOWNLOAD_APPLY';
      if (!adding && !applying && queue?.files.some(file => file.state === 'queued' || file.state === 'downloading')) {
        throw new Error('Apply your selection to the current queue or stop it first.');
      }
      if (!message.plan) throw new Error('Check a series before downloading.');
      if (!Array.isArray(message.selectedPages) || !message.selectedPages.length) {
        throw new Error('Select at least one episode.');
      }
      let folder: string | undefined;
      if (adding) {
        const id = seriesRoot(message.plan.series).pathname.match(/\d+$/)![0];
        folder = message.folder;
        if (typeof folder !== 'string' || /[/\\:*?"<>|\p{Cc}]/u.test(folder) || folder.startsWith('.')
            || folder.match(/^.+? - (\d+)(?: - .+)?$/)?.[1] !== id) {
          throw new Error('Choose the downloaded folder for this series.');
        }
      }
      const next = createQueue(message.plan, message.selectedPages, folder);
      queue = adding ? appendEpisodes(queue, next) : applying && queue ? await applySelection(queue, next) : next;
    }
    if (!queue) return { queue: null };
    if (message.type === 'SERIES_DOWNLOAD_STOP') {
      queue.paused = true;
      const active = queue.files.find(file => file.state === 'downloading');
      if (active) await cancelTransfer(queue, active);
      for (const file of queue.files) {
        if (file.state === 'queued' || file.state === 'failed') file.state = 'canceled';
      }
    }
    if (message.type === 'SERIES_DOWNLOAD_PAUSE') queue.paused = true;
    if (message.type === 'SERIES_DOWNLOAD_RESUME') queue.paused = false;
    if (message.type === 'SERIES_DOWNLOAD_RETRY') {
      queue.paused = false;
      for (const file of queue.files) if (file.state === 'failed') { file.state = 'queued'; delete file.error; }
    }
    await save(queue);
    await chrome.alarms.create(alarm, { periodInMinutes: 0.5 });
    return { queue: await pump() };
  });
}

/** The current Chrome queue, for the Mac's download requests. */
export function seriesQueueStatus() {
  return serialize(load);
}

/**
 * Start a queue for a download requested from another device (see remote-downloads.ts).
 * Returns false when Chrome is already busy with another queue, so the request waits.
 */
export function startRequestedSeries(plan: SeriesPlan, selectedPages: string[]) {
  return serialize(async () => {
    if (!chrome.downloads) throw new Error('Allow Chrome downloads to start the queue.');
    const queue = await load();
    if (queue?.files.some(file => file.state === 'queued' || file.state === 'downloading')) return false;
    watchDownloads();
    await save(createQueue(plan, selectedPages));
    await chrome.alarms.create(alarm, { periodInMinutes: 0.5 });
    await pump();
    return true;
  });
}
