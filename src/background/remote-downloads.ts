import { AUTO_FALLBACK, planSeries, resolveSeriesTeam, seriesFiles, type SeriesPlan } from '../japanese/series';
import { DEFAULT_TV_SERVER_URL } from '../japanese/tv-sync';
import { seriesQueueStatus, startRequestedSeries } from './series-downloads';

/**
 * Series downloads asked for on the phone or iPad. They post an Anime365 link to the Mac's library
 * server; Chrome (signed in to Anime365) checks the server every half minute, plans the series with
 * the same rules as Offline Study, and downloads it into ~/Downloads/Arc Anime, which the server
 * serves. Progress goes back to the server so the device can show it, and the device's auto sync
 * then copies the first episodes over.
 */

type RemoteRequest = { id: string; url: string; title?: string; state: string };

const alarm = 'arc-remote-downloads';
const activeKey = 'arc_remote_download';
let running: Promise<unknown> = Promise.resolve();

async function serverUrl() {
  const saved = (await chrome.storage.local.get('arc-tv-server-url'))['arc-tv-server-url'];
  const url = typeof saved === 'string' && /^https?:\/\//.test(saved) ? saved : DEFAULT_TV_SERVER_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

async function report(base: string, update: Record<string, unknown>): Promise<{ existing?: string[] }> {
  const response = await fetch(`${base}downloads/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(8000)
  });
  return response.ok ? await response.json() : {};
}

/** Dubbed editions often miss episodes for the chosen team; fill gaps with the most common one. */
async function completePlan(plan: SeriesPlan) {
  const gaps = plan.episodes.some(episode => !episode.video && episode.variants?.length);
  return gaps ? resolveSeriesTeam(plan, AUTO_FALLBACK) : plan;
}

async function claim(base: string, request: RemoteRequest) {
  const current = await seriesQueueStatus();
  if (current?.files.some(file => file.state === 'queued' || file.state === 'downloading')) {
    if (request.state !== 'pending') await report(base, { id: request.id, state: 'pending', detail: 'Waiting for the current Chrome download to finish' });
    return;
  }
  await report(base, { id: request.id, state: 'planning', detail: 'Chrome is reading the series' });
  try {
    const plan = await completePlan(await planSeries(request.url, () => {}));
    const pages = plan.episodes.filter(episode => episode.video).map(episode => episode.page);
    if (!pages.length) throw new Error('No downloadable episodes in this edition. Are you signed in to Anime365 in Chrome?');
    const { folder, files } = seriesFiles(plan, pages);
    const { existing = [] } = await report(base, {
      id: request.id, state: 'planning', title: plan.title, folder, files: files.map(file => file.name)
    });
    const have = new Set(existing);
    // Keep an episode only if its video isn't in the library yet.
    const wanted = pages.filter(page => {
      const one = seriesFiles(plan, [page]).files.find(file => file.kind === 'video');
      return one && !have.has(one.name);
    });
    if (!wanted.length) {
      await report(base, { id: request.id, state: 'done', detail: 'Already in the library', done: 0, total: 0 });
      return;
    }
    if (!await startRequestedSeries(plan, wanted)) {
      await report(base, { id: request.id, state: 'pending', detail: 'Waiting for the current Chrome download to finish' });
      return;
    }
    await chrome.storage.local.set({ [activeKey]: { id: request.id, folder: `Arc Anime/${folder}` } });
    await report(base, { id: request.id, state: 'downloading', detail: `Downloading ${wanted.length} episodes`, done: 0, total: wanted.length });
  } catch (error) {
    await report(base, { id: request.id, state: 'failed', detail: error instanceof Error ? error.message : String(error) });
  }
}

/** Report how the claimed request's Chrome queue is doing; true while it is still downloading. */
async function follow(base: string, active: { id: string; folder: string }) {
  const queue = await seriesQueueStatus();
  if (!queue || queue.folder !== active.folder) {
    await report(base, { id: active.id, state: 'failed', detail: 'The Chrome download was replaced or cleared' });
    return false;
  }
  const videos = queue.files.filter(file => file.filename.endsWith('.mp4'));
  const done = videos.filter(file => file.state === 'done').length;
  const failed = queue.files.filter(file => file.state === 'failed' || file.state === 'canceled');
  const busy = queue.files.some(file => file.state === 'queued' || file.state === 'downloading');
  if (busy && !queue.paused) {
    await report(base, { id: active.id, state: 'downloading', detail: `Downloaded ${done} of ${videos.length}`, done, total: videos.length });
    return true;
  }
  const state = !busy && !failed.length ? 'done' : 'failed';
  const detail = state === 'done' ? `Downloaded ${done} episodes`
    : queue.paused ? 'Paused in Chrome' : `${failed.length} files failed: ${failed[0]?.error || 'see Offline Study in Chrome'}`;
  await report(base, { id: active.id, state, detail, done, total: videos.length });
  return false;
}

async function check() {
  const base = await serverUrl();
  const active = (await chrome.storage.local.get(activeKey))[activeKey] as { id: string; folder: string } | undefined;
  if (active) {
    if (await follow(base, active)) return;
    await chrome.storage.local.remove(activeKey);
  }
  const response = await fetch(`${base}downloads`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return;
  const { requests = [] } = await response.json() as { requests?: RemoteRequest[] };
  // A request left in "planning" by a service worker that stopped mid-way is picked up again.
  const next = requests.find(item => item.state === 'pending' || item.state === 'planning');
  if (next) await claim(base, next);
}

export function checkRemoteDownloads() {
  const next = running.then(check);
  running = next.catch(() => { /* The Mac is away; try again on the next alarm. */ });
  return next;
}

chrome.alarms?.onAlarm.addListener(event => { if (event.name === alarm) void checkRemoteDownloads().catch(() => {}); });
void chrome.alarms?.create(alarm, { periodInMinutes: 0.5 });
