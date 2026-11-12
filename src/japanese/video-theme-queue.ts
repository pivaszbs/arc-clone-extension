import { confirmLateOpening, fingerprintVideo, matchEarlySparseOpening, matchLateOpening, matchRecap, matchVideoThemes, overlapsRecap, refineThemeEdges, type VideoThemes } from './video-themes';

type Fingerprint = Awaited<ReturnType<typeof fingerprintVideo>>;
type Comparison = {
  recap?: VideoThemes['recap'];
  earlyOpeningsChecked?: boolean;
  episodes: { themes: VideoThemes; lateOpening?: VideoThemes['op']; earlyOpening?: VideoThemes['op'] }[];
};
export type ScanFile = { id: string; file: File };
export type ScanStatus = { active: string; total: number; scanned: number; failed: number; restoring: boolean };

function scanCache<T>(storeName: 'frames' | 'comparisons', id: string, value?: T): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('arc-video-fingerprints', 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames');
      db.createObjectStore('comparisons');
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      const transaction = db.transaction(storeName, value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = value === undefined ? store.get(id) : store.put(value, id);
      transaction.oncomplete = () => { db.close(); resolve(value === undefined ? request.result : undefined); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

export class VideoThemeQueue {
  private files: ScanFile[] = [];
  private frames = new Map<string, Fingerprint>();
  private cachedFrames = new Map<string, Fingerprint | undefined>();
  private failed = new Set<string>();
  private compared = new Map<string, Set<string>>();
  private sparseOpenings = new Map<string, NonNullable<VideoThemes['op']>[]>();
  private recaps = new Map<string, NonNullable<VideoThemes['recap']>>();
  private controller = new AbortController();
  private active = '';
  private running = false;
  private paused = false;

  constructor(
    private onStatus: (status: ScanStatus) => void,
    private onMatch: (id: string, themes: VideoThemes) => void,
    private savedThemes: (id: string) => VideoThemes
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
      restoring: this.files.some(item => !this.cachedFrames.has(item.id)),
      scanned: this.files.filter(item => this.frames.has(item.id)).length,
      failed: this.files.filter(item => this.failed.has(item.id)).length });
  }

  private async refineNewThemes(item: ScanFile, themes: VideoThemes) {
    const saved = this.savedThemes(item.id);
    const pending = { ...themes };
    if (saved.op && !overlapsRecap(saved.op, this.recaps.get(item.id) ?? saved.recap)) delete pending.op;
    if (saved.ed) delete pending.ed;
    if (saved.recap) delete pending.recap;
    if (!pending.op && !pending.ed && !pending.recap) return;
    const refined = await refineThemeEdges(item.file, pending, this.controller.signal);
    this.controller.signal.throwIfAborted();
    this.onMatch(item.id, refined);
  }

  private async compareReadyFiles() {
    for (const [index, current] of this.files.entries()) {
      const frames = this.frames.get(current.id);
      if (!frames) continue;
      for (const other of this.files.slice(index + 1, index + 3)) {
        if (this.paused) return;
        this.controller.signal.throwIfAborted();
        const reference = this.frames.get(other.id);
        if (!reference) continue;
        const compared = this.compared.get(current.id) ?? new Set<string>();
        if (compared.has(other.id)) continue;

        const key = JSON.stringify([current.id, other.id]);
        let comparison = await scanCache<Comparison>('comparisons', key).catch(() => undefined);
        this.controller.signal.throwIfAborted();
        if (this.paused) return;
        const directions = [[frames, reference], [reference, frames]] as const;
        if (!comparison) {
          const previousNumber = current.file.name.match(/^Episode\s+(\d+)\b/i)?.[1];
          const nextNumber = other.file.name.match(/^Episode\s+(\d+)\b/i)?.[1];
          comparison = {
            recap: previousNumber && nextNumber && Number(nextNumber) === Number(previousNumber) + 1
              ? matchRecap(reference, frames) : undefined,
            episodes: directions.map(([mine, theirs]) => ({
              themes: matchVideoThemes(mine, theirs),
              lateOpening: matchLateOpening(mine, theirs)
            }))
          };
        }
        if (!comparison.earlyOpeningsChecked) {
          for (const [side, [mine, theirs]] of directions.entries()) {
            const result = comparison.episodes[side];
            if (!result.themes.op && !result.lateOpening) result.earlyOpening = matchEarlySparseOpening(mine, theirs);
          }
          comparison.earlyOpeningsChecked = true;
          await scanCache('comparisons', key, comparison).catch(() => {});
        }
        this.controller.signal.throwIfAborted();

        if (comparison.recap) {
          await this.refineNewThemes(other, { recap: comparison.recap });
          this.recaps.set(other.id, this.savedThemes(other.id).recap ?? comparison.recap);
        }
        for (const [side, item] of [current, other].entries()) {
          const { themes, lateOpening, earlyOpening } = comparison.episodes[side];
          const candidate = lateOpening ?? earlyOpening;
          const recap = this.recaps.get(item.id) ?? this.savedThemes(item.id).recap;
          const matched = { ...themes };
          if (overlapsRecap(matched.op, recap)) matched.op = undefined;
          if (!matched.op && candidate && !overlapsRecap(candidate, recap)) {
            const previous = this.sparseOpenings.get(item.id) ?? [];
            matched.op = confirmLateOpening(candidate, previous);
            this.sparseOpenings.set(item.id, [...previous, candidate]);
          }
          await this.refineNewThemes(item, matched);
        }
        compared.add(other.id);
        this.compared.set(current.id, compared);
      }
    }
  }

  private async restoreFingerprints() {
    const unchecked = this.files.filter(item => !this.cachedFrames.has(item.id));
    await Promise.all(unchecked.map(async item => {
      const cached = await scanCache<Fingerprint>('frames', item.id).catch(() => undefined);
      this.cachedFrames.set(item.id, cached);
      if (cached?.openingScanEnd !== undefined) this.frames.set(item.id, cached);
    }));
    if (unchecked.length) this.report();
  }

  private async run() {
    if (this.running || this.controller.signal.aborted) return;
    this.running = true;
    try {
      while (!this.controller.signal.aborted) {
        await this.restoreFingerprints();
        if (this.controller.signal.aborted) break;
        if (!this.paused) await this.compareReadyFiles();
        // A folder refresh can add files while cached results are loading.
        if (this.files.some(item => !this.cachedFrames.has(item.id))) continue;
        if (this.paused) break;
        const next = this.files.find(item => !this.frames.has(item.id) && !this.failed.has(item.id));
        if (!next) break;
        this.active = next.file.name;
        this.report();
        try {
          const frames = await fingerprintVideo(next.file, this.controller.signal, this.cachedFrames.get(next.id));
          await scanCache('frames', next.id, frames).catch(() => {});
          this.controller.signal.throwIfAborted();
          this.frames.set(next.id, frames);
        } catch {
          if (!this.controller.signal.aborted) this.failed.add(next.id);
        }
        this.active = '';
        this.report();
      }
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    } finally {
      this.running = false;
    }
  }
}
