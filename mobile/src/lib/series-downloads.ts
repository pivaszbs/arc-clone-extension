import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';

import { seriesFiles, shareSignIn, type SeriesPlan } from './anime365';
import { logAutoSyncError } from './auto-sync';

/**
 * Series downloads started on this device, straight from Anime365 into the library (Documents).
 *
 * One file at a time, in a background URL session so a download keeps going while the app is in
 * the background. The queue is saved, so files that didn't finish start again when the app opens.
 * These are your own downloads: auto sync never deletes them.
 */

export type DownloadJob = {
  series: string;
  folder: string;
  url: string;
  name: string;
  kind: 'video' | 'subtitle';
  state: 'queued' | 'done' | 'failed';
  error?: string;
};

export type DownloadsState = {
  status: 'idle' | 'downloading' | 'paused' | 'waiting' | 'error';
  detail?: string;
  done: number;
  total: number;
  failed: number;
  current?: { series: string; name: string; bytes: number; totalBytes: number };
  /** Series titles in the queue, oldest first, with how many of their files are finished. */
  series: { title: string; done: number; total: number }[];
};

const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** A real episode is far bigger; anything smaller is an error or sign-in page. */
const MIN_VIDEO_BYTES = 1024 ** 2;

const stateDir = new Directory(Paths.document, '.anime-study');
const queueFile = new File(stateDir, 'downloads.json');

/** Folder and file names come from the website; keep them inside Documents. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200);

function readQueue(): DownloadJob[] {
  try {
    if (queueFile.exists) {
      const saved = JSON.parse(queueFile.textSync()) as { jobs?: DownloadJob[] };
      if (Array.isArray(saved.jobs)) return saved.jobs;
    }
  } catch { /* An unreadable queue starts empty; downloaded files stay in the library. */ }
  return [];
}

export class SeriesDownloader {
  private jobs = readQueue();
  private running = false;
  private paused = false;
  private task: DownloadTask | null = null;
  private state: DownloadsState = this.summary('idle');

  constructor(
    private onState: (state: DownloadsState) => void,
    private onLibraryChanged: () => void,
    private log: (kind: string, detail: string) => void,
  ) {}

  private save() {
    try {
      if (!stateDir.exists) stateDir.create({ intermediates: true });
      queueFile.write(JSON.stringify({ jobs: this.jobs }));
    } catch (error) { logAutoSyncError('save downloads', error); }
  }

  private summary(status: DownloadsState['status'], extra: Partial<DownloadsState> = {}): DownloadsState {
    const series: DownloadsState['series'] = [];
    for (const job of this.jobs) {
      let entry = series.find(item => item.title === job.series);
      if (!entry) series.push(entry = { title: job.series, done: 0, total: 0 });
      entry.total++;
      if (job.state === 'done') entry.done++;
    }
    return {
      status,
      done: this.jobs.filter(job => job.state === 'done').length,
      total: this.jobs.length,
      failed: this.jobs.filter(job => job.state === 'failed').length,
      series,
      ...extra,
    };
  }

  private set(status: DownloadsState['status'], extra: Partial<DownloadsState> = {}) {
    this.state = this.summary(status, extra);
    this.onState(this.state);
  }

  /** Current state, for the screen's first render. */
  get current() { return this.state; }

  /** Files of a series already in the library (or queued), so the list can mark them. */
  has(folder: string, name: string) {
    return new File(new Directory(Paths.document, safeName(folder)), safeName(name)).exists
      || this.jobs.some(job => job.folder === folder && job.name === name && job.state !== 'failed');
  }

  /** Queue the chosen episodes of a planned series. Returns how many files were added. */
  add(plan: SeriesPlan, pages: string[]) {
    const { folder, files } = seriesFiles(plan, pages);
    let added = 0;
    for (const file of files) {
      if (this.has(folder, file.name)) continue;
      this.jobs.push({ series: plan.title, folder, url: file.url, name: file.name, kind: file.kind, state: 'queued' });
      added++;
    }
    this.save();
    this.log('Download', `Queued ${added} files of ${plan.title}`);
    this.kick();
    return added;
  }

  kick() {
    if (this.running || this.paused) { this.set(this.paused ? 'paused' : this.state.status, { current: this.state.current }); return; }
    void this.run();
  }

  pause() {
    this.paused = true;
    void this.task?.pauseAsync().catch(() => this.task?.cancel());
    this.set('paused');
  }

  resume() {
    this.paused = false;
    this.kick();
  }

  retryFailed() {
    for (const job of this.jobs) if (job.state === 'failed') { job.state = 'queued'; job.error = undefined; }
    this.save();
    this.resume();
  }

  /** Forget finished and failed entries; files already saved stay in the library. */
  clearFinished() {
    this.jobs = this.jobs.filter(job => job.state === 'queued');
    this.save();
    this.set(this.running ? this.state.status : 'idle', { current: this.state.current });
  }

  private async run() {
    this.running = true;
    try {
      for (;;) {
        if (this.paused) return this.set('paused');
        const job = this.jobs.find(item => item.state === 'queued');
        if (!job) return this.set('idle');
        if (job.kind === 'video' && Paths.availableDiskSpace < MIN_FREE_BYTES) {
          return this.set('waiting', { detail: 'Less than 2 GB free on this device' });
        }
        const dir = new Directory(Paths.document, safeName(job.folder));
        const target = new File(dir, safeName(job.name));
        try {
          if (!dir.exists) dir.create({ intermediates: true });
          const cookie = await shareSignIn(job.url);
          if (job.kind === 'subtitle') {
            const response = await fetch(job.url, { credentials: 'include', headers: cookie ? { Cookie: cookie } : undefined });
            if (!response.ok) throw new Error(`Anime365 answered ${response.status}`);
            target.write(await response.text());
          } else if (!target.exists) {
            this.set('downloading', { current: { series: job.series, name: job.name, bytes: 0, totalBytes: -1 } });
            let lastUpdate = 0;
            this.task = File.createDownloadTask(job.url, target, {
              headers: cookie ? { Cookie: cookie } : undefined,
              sessionType: 'background',
              onProgress: ({ bytesWritten, totalBytes }) => {
                const now = Date.now();
                if (now - lastUpdate < 500) return;
                lastUpdate = now;
                // Native progress can arrive as BigInt; the screen does ordinary arithmetic with it.
                this.set('downloading', { current: { series: job.series, name: job.name, bytes: Number(bytesWritten), totalBytes: Number(totalBytes) } });
              },
            });
            let saved = await this.task.downloadAsync();
            // Paused: wait here so resuming continues the same file instead of starting over.
            while (!saved && this.paused) {
              await new Promise(resolve => setTimeout(resolve, 500));
              if (!this.paused) saved = await this.task.resumeAsync();
            }
            this.task.release();
            this.task = null;
            if (!saved) throw new Error('The download stopped.');
            if (Number(saved.size ?? 0) < MIN_VIDEO_BYTES) {
              saved.delete();
              throw new Error('Anime365 sent a page instead of the video. Sign in to your account in the browser above.');
            }
          }
          job.state = 'done';
          this.save();
          this.log('Download', `Saved ${job.series} · ${job.name}`);
          if (job.kind === 'video') this.onLibraryChanged();
        } catch (error) {
          this.task = null;
          const message = error instanceof Error ? error.message : String(error);
          logAutoSyncError(`download ${job.folder}/${job.name}`, error);
          job.state = 'failed';
          job.error = message;
          this.save();
          this.log('Error', `Download ${job.name}: ${message}`);
          this.set('error', { detail: message });
          // A sign-in problem fails every file the same way; stop so it can be fixed first.
          if (/sign in|401|403/i.test(message)) return;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
