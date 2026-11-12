import { fingerprintVideo, matchVideoThemes, refineThemeEdges, type VideoThemes } from './video-themes';

type Fingerprint = Awaited<ReturnType<typeof fingerprintVideo>>;
export type ScanFile = { id: string; file: File };
export type ScanStatus = { active: string; total: number; scanned: number; failed: number };

async function fingerprintCache(id: string, frames?: Fingerprint): Promise<Fingerprint | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('arc-video-fingerprints', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('frames');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('frames', frames ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('frames');
      const request = frames ? store.put(frames, id) : store.get(id);
      transaction.oncomplete = () => { db.close(); resolve(frames ? undefined : request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

export class VideoThemeQueue {
  private files: ScanFile[] = [];
  private frames = new Map<string, Fingerprint>();
  private cacheChecked = new Set<string>();
  private failed = new Set<string>();
  private compared = new Map<string, Set<string>>();
  private controller = new AbortController();
  private active = '';
  private running = false;
  private paused = false;

  constructor(
    private onStatus: (status: ScanStatus) => void,
    private onMatch: (id: string, themes: VideoThemes) => void
  ) {}

  update(files: ScanFile[]) {
    this.files = files;
    this.report();
    void this.run();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) {
      this.failed.clear();
      this.report();
      void this.run();
    }
  }

  stop() {
    this.controller.abort();
  }

  private report() {
    this.onStatus({ active: this.active, total: this.files.length,
      scanned: this.files.filter(item => this.frames.has(item.id)).length,
      failed: this.files.filter(item => this.failed.has(item.id)).length });
  }

  private async compareReadyFiles() {
    for (const [index, current] of this.files.entries()) {
      const frames = this.frames.get(current.id);
      if (!frames) continue;
      for (const other of this.files.slice(index + 1, index + 3)) {
        const reference = this.frames.get(other.id);
        if (!reference) continue;
        const compared = this.compared.get(current.id) || new Set<string>();
        if (compared.has(other.id)) continue;
        compared.add(other.id);
        this.compared.set(current.id, compared);
        for (const [item, mine, theirs] of [[current, frames, reference], [other, reference, frames]] as const) {
          const themes = matchVideoThemes(mine, theirs);
          if (!themes.op && !themes.ed) continue;
          // Snap the edges to the picture cut so skips land on the first frame after the theme.
          const refined = await refineThemeEdges(item.file, themes, this.controller.signal);
          this.controller.signal.throwIfAborted();
          this.onMatch(item.id, refined);
        }
      }
    }
  }

  private async run() {
    if (this.running || this.controller.signal.aborted) return;
    this.running = true;
    try {
      await this.compareReadyFiles().catch(() => {});
      while (!this.controller.signal.aborted) {
        const next = this.files.find(item => !this.frames.has(item.id) && !this.failed.has(item.id)
          && (!this.paused || !this.cacheChecked.has(item.id)));
        if (!next) break;
        try {
          const cached = this.cacheChecked.has(next.id) ? undefined : await fingerprintCache(next.id).catch(() => undefined);
          this.cacheChecked.add(next.id);
          this.controller.signal.throwIfAborted();
          if (cached) this.frames.set(next.id, cached);
          else {
            if (this.paused) continue;
            this.active = next.file.name;
            this.report();
            const frames = await fingerprintVideo(next.file, this.controller.signal);
            this.frames.set(next.id, frames);
            await fingerprintCache(next.id, frames).catch(() => {});
            this.controller.signal.throwIfAborted();
          }
          await this.compareReadyFiles();
        } catch {
          if (!this.controller.signal.aborted) this.failed.add(next.id);
        }
        this.active = '';
        this.report();
      }
    } finally {
      this.running = false;
    }
  }
}
