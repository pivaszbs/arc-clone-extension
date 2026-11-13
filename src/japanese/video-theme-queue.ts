import { detectAnimeOpEdIntervals, parseCaptionResponse } from './captions';
import { confirmLateOpening, fingerprintVideo, matchAudioEndings, matchEarlySparseOpening, matchKnownEnding, matchKnownOpening, matchLateOpening, matchRecap, matchVideoThemes, overlapsRecap, refineThemeEdges, type VideoThemes } from './video-themes';

type Fingerprint = Awaited<ReturnType<typeof fingerprintVideo>>;
type Comparison = {
  recap?: VideoThemes['recap'];
  earlyOpeningsChecked?: boolean;
  audioEndingsChecked?: boolean;
  episodes: { themes: VideoThemes; lateOpening?: VideoThemes['op']; earlyOpening?: VideoThemes['op']; audioEnding?: VideoThemes['ed'] }[];
};
export type ScanFile = { id: string; file: File; subtitle?: File };
export type ScanStatus = { active: string; total: number; scanned: number; failed: number; restoring: boolean };

function openScanCache(): Promise<IDBDatabase> {
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
      resolve(db);
    };
  });
}

async function scanCache<T>(storeName: 'frames' | 'comparisons', id: string, value?: T): Promise<T | undefined> {
  const db = await openScanCache();
  return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = value === undefined ? store.get(id) : store.put(value, id);
      transaction.oncomplete = () => { db.close(); resolve(value === undefined ? request.result : undefined); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

export async function forgetFrameChecks(ids: Set<string>) {
  const db = await openScanCache();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['frames', 'comparisons'], 'readwrite');
    for (const id of ids) transaction.objectStore('frames').delete(id);
    const request = transaction.objectStore('comparisons').openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string') {
        let pair: unknown;
        try { pair = JSON.parse(cursor.key); } catch { /* Leave unrelated cache records in place. */ }
        if (Array.isArray(pair) && pair.some(key => typeof key === 'string' && ids.has(key))) {
          transaction.objectStore('comparisons').delete(cursor.key);
        }
      }
      cursor.continue();
    };
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

export class VideoThemeQueue {
  private files: ScanFile[] = [];
  private frames = new Map<string, Fingerprint>();
  private cachedFrames = new Map<string, Fingerprint | undefined>();
  private failed = new Set<string>();
  private compared = new Map<string, Set<string>>();
  private sparseOpenings = new Map<string, NonNullable<VideoThemes['op']>[]>();
  private knownOpeningMatches = new Map<string, VideoThemes['op']>();
  private knownEndingMatches = new Map<string, VideoThemes['ed']>();
  private subtitleChecked = new Set<string>();
  private recaps = new Map<string, NonNullable<VideoThemes['recap']>>();
  private controller = new AbortController();
  private active = '';
  private running = false;
  private paused = false;

  constructor(
    private onStatus: (status: ScanStatus) => void,
    private onMatch: (id: string, themes: VideoThemes) => void,
    private savedThemes: (id: string) => VideoThemes,
    private fresh = false,
    private preferredId = ''
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
      restoring: !this.fresh && this.files.some(item => !this.cachedFrames.has(item.id)),
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
        let comparison = this.fresh ? undefined : await scanCache<Comparison>('comparisons', key).catch(() => undefined);
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
        if (!comparison.earlyOpeningsChecked || !comparison.audioEndingsChecked) {
          if (!comparison.earlyOpeningsChecked) {
            for (const [side, [mine, theirs]] of directions.entries()) {
              const result = comparison.episodes[side];
              if (!result.themes.op && !result.lateOpening) result.earlyOpening = matchEarlySparseOpening(mine, theirs);
            }
            comparison.earlyOpeningsChecked = true;
          }
          if (!comparison.audioEndingsChecked) {
            const [mine, theirs] = matchAudioEndings(frames, reference);
            comparison.episodes[0].audioEnding = mine;
            comparison.episodes[1].audioEnding = theirs;
            comparison.audioEndingsChecked = true;
          }
          await scanCache('comparisons', key, comparison).catch(() => {});
        }
        this.controller.signal.throwIfAborted();

        if (comparison.recap) {
          await this.refineNewThemes(other, { recap: comparison.recap });
          this.recaps.set(other.id, this.savedThemes(other.id).recap ?? comparison.recap);
        }
        for (const [side, item] of [current, other].entries()) {
          const { themes, lateOpening, earlyOpening, audioEnding } = comparison.episodes[side];
          const candidate = lateOpening ?? earlyOpening;
          const recap = this.recaps.get(item.id) ?? this.savedThemes(item.id).recap;
          // The shared song marks the ending more reliably than the credits footage.
          const matched = { ...themes, ed: audioEnding ?? themes.ed };
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

  private async checkKnownOpenings() {
    for (const item of this.files) {
      if (this.paused) return;
      this.controller.signal.throwIfAborted();
      const frames = this.frames.get(item.id);
      const saved = this.savedThemes(item.id);
      const recap = this.recaps.get(item.id) ?? saved.recap;
      if (!frames?.op.length || (saved.op && !overlapsRecap(saved.op, recap))) continue;
      const candidates: NonNullable<VideoThemes['op']>[] = [];
      for (const other of this.files) {
        if (other === item) continue;
        const reference = this.frames.get(other.id);
        const referenceThemes = this.savedThemes(other.id);
        const opening = referenceThemes.op;
        if (!reference || !opening || overlapsRecap(opening, this.recaps.get(other.id) ?? referenceThemes.recap)) continue;
        const key = JSON.stringify(['known-opening', item.id, other.id, opening, recap]);
        if (!this.knownOpeningMatches.has(key)) {
          const cached = this.fresh ? undefined : await scanCache<{ opening?: VideoThemes['op'] }>('comparisons', key).catch(() => undefined);
          this.controller.signal.throwIfAborted();
          if (this.paused) return;
          const match = cached ? cached.opening : matchKnownOpening(frames, reference, opening, recap);
          this.knownOpeningMatches.set(key, match);
          if (!cached) await scanCache('comparisons', key, { opening: match }).catch(() => {});
        }
        const candidate = this.knownOpeningMatches.get(key);
        if (!candidate) continue;
        const confirmed = confirmLateOpening(candidate, candidates);
        if (confirmed) {
          if (!this.paused) await this.refineNewThemes(item, { op: confirmed });
          break;
        }
        candidates.push(candidate);
      }
    }
  }

  private async checkKnownEndings() {
    for (const item of this.files) {
      if (this.paused) return;
      this.controller.signal.throwIfAborted();
      const frames = this.frames.get(item.id);
      const saved = this.savedThemes(item.id);
      if (!frames?.ed.length || saved.ed) continue;
      const candidates: NonNullable<VideoThemes['ed']>[] = [];
      for (const other of this.files) {
        if (other === item) continue;
        const reference = this.frames.get(other.id);
        const ending = this.savedThemes(other.id).ed;
        if (!reference?.ed.length || !ending) continue;
        // Separate key from v3, whose cached misses were made without the soundtrack.
        const key = JSON.stringify(['known-ending-audio', item.id, other.id, ending]);
        if (!this.knownEndingMatches.has(key)) {
          const cached = this.fresh ? undefined : await scanCache<{ ending?: VideoThemes['ed'] }>('comparisons', key).catch(() => undefined);
          this.controller.signal.throwIfAborted();
          if (this.paused) return;
          const match = cached ? cached.ending : matchKnownEnding(frames, reference, ending);
          this.knownEndingMatches.set(key, match);
          if (!cached) await scanCache('comparisons', key, { ending: match }).catch(() => {});
        }
        const candidate = this.knownEndingMatches.get(key);
        if (!candidate) continue;
        const confirmed = confirmLateOpening(candidate, candidates);
        if (confirmed) {
          if (!this.paused) await this.refineNewThemes(item, { ed: confirmed });
          break;
        }
        candidates.push(candidate);
      }
    }
  }

  private async checkSubtitleThemes() {
    for (const item of this.files) {
      if (this.paused) return;
      this.controller.signal.throwIfAborted();
      if (this.subtitleChecked.has(item.id)) continue;
      this.subtitleChecked.add(item.id);
      const saved = this.savedThemes(item.id);
      if (saved.op && saved.ed) continue;
      let body = '';
      if (item.subtitle && item.subtitle.size <= 5_000_000) {
        body = await item.subtitle.text().catch(() => '');
      }
      if (!body) {
        try { body = localStorage.getItem(`${item.id}:subtitles`) || ''; } catch { /* ignore */ }
      }
      if (!body) continue;
      const cues = parseCaptionResponse(body);
      if (!cues.length) continue;
      const duration = this.frames.get(item.id)?.ed.at(-1)?.time ?? Math.max(cues.at(-1)?.end ?? 0, 1400);
      const detected = detectAnimeOpEdIntervals(body, cues, duration);
      if (detected.op || detected.ed) {
        await this.refineNewThemes(item, { op: detected.op ?? undefined, ed: detected.ed ?? undefined });
      }
    }
  }

  private async restoreFingerprints() {
    const unchecked = this.files.filter(item => !this.cachedFrames.has(item.id));
    await Promise.all(unchecked.map(async item => {
      const cached = this.fresh ? undefined : await scanCache<Fingerprint>('frames', item.id).catch(() => undefined);
      this.cachedFrames.set(item.id, cached);
      // Older fingerprints without a soundtrack go back through the scan, which only decodes the audio.
      if (cached?.openingScanEnd !== undefined && cached.edAudio !== undefined) this.frames.set(item.id, cached);
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
        if (!this.paused) {
          await this.checkSubtitleThemes();
          await this.compareReadyFiles();
          await this.checkKnownOpenings();
          await this.checkKnownEndings();
        }
        // A folder refresh can add files while cached results are loading.
        if (this.files.some(item => !this.cachedFrames.has(item.id))) continue;
        if (this.paused) break;
        const priority = Math.max(0, this.files.findIndex(item => item.id === this.preferredId));
        const needsScan = (item: ScanFile) => !this.frames.has(item.id) && !this.failed.has(item.id);
        const next = this.files.slice(priority).find(needsScan) ?? this.files.slice(0, priority).find(needsScan);
        if (!next) break;
        this.active = next.file.name;
        this.report();
        try {
          const frames = await fingerprintVideo(next.file, this.controller.signal, this.cachedFrames.get(next.id));
          this.controller.signal.throwIfAborted();
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
