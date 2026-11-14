import { Directory, File, Paths } from 'expo-file-system';

import { getDeviceHealth } from '../../modules/device-health/src';
import type { Series } from './library';
import { requestedFolders } from './mac-downloads';
import { fetchRemoteCatalog } from './server';
import { allProgress, type Progress } from './storage';

/**
 * Auto sync keeps copies of what you're watching on this phone, so Local Files plays with the Mac off.
 *
 * For every series with progress (from any device), it keeps the next few unfinished episodes. It only
 * runs while the app is open and the Mac answers, downloads one file at a time, and waits when the
 * phone is hot, on Low Power Mode, low on battery, or short of space. Copies it made are removed once
 * watched; files you imported yourself are never touched.
 */

export type AutoSyncState = {
  status: 'idle' | 'checking' | 'downloading' | 'waiting' | 'error';
  detail?: string;
  /** Episodes kept on this phone by auto sync. */
  kept: number;
  queued: number;
};

const KEEP_AHEAD = 3;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const RECHECK_MS = 10 * 60_000;

const stateDir = new Directory(Paths.document, '.anime-study');
const manifestFile = new File(stateDir, 'auto-sync.json');
const errorFile = new File(stateDir, 'auto-sync-errors.log');

/** Paths (relative to Documents) of files auto sync downloaded, so it only ever deletes its own. */
type Manifest = { files: string[] };

function readManifest(): Manifest {
  try {
    if (manifestFile.exists) {
      const saved = JSON.parse(manifestFile.textSync()) as Manifest;
      if (Array.isArray(saved.files)) return saved;
    }
  } catch { /* Start over; nothing is deleted without a manifest entry. */ }
  return { files: [] };
}

function writeManifest(manifest: Manifest) {
  try {
    if (!stateDir.exists) stateDir.create({ intermediates: true });
    manifestFile.write(JSON.stringify(manifest));
  } catch { /* Best effort. */ }
}

export function logAutoSyncError(context: string, error: unknown) {
  try {
    if (!stateDir.exists) stateDir.create({ intermediates: true });
    const previous = errorFile.exists ? errorFile.textSync().slice(-20_000) : '';
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    errorFile.write(`${previous}[${new Date().toISOString()}] ${context}: ${message}\n`);
  } catch { /* Logging must never throw. */ }
}

/** Folder and file names come from the Mac; keep them inside Documents. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200);

function progressOf(progress: Record<string, Progress>, series: Series, video: string) {
  // Remote keys use the Mac's series id; local copies use the folder name. Take the newest.
  const candidates = [progress[`${series.folder}/${video}`], ...Object.entries(progress)
    .filter(([key]) => key.endsWith(`/${video}`) && key.split('/')[0] !== series.folder && progress[key])
    .map(([, value]) => value)].filter(Boolean) as Progress[];
  return candidates.sort((a, b) => b.watchedAt - a.watchedAt)[0];
}

type Wanted = { series: Series; episodeIndex: number };

/** The next unfinished episodes of every series you've started, or asked the Mac to download from here. */
export function pickEpisodes(remote: Series[], progress: Record<string, Progress>, keepAhead = KEEP_AHEAD, requested = new Set<string>()): Wanted[] {
  const wanted: Wanted[] = [];
  for (const series of remote) {
    let latest = -1;
    let latestAt = 0;
    series.episodes.forEach((episode, index) => {
      const saved = progressOf(progress, series, episode.video);
      if (saved && saved.watchedAt > latestAt) { latestAt = saved.watchedAt; latest = index; }
    });
    if (latest < 0 && requested.has(series.folder)) latest = 0;
    if (latest < 0) continue;
    let added = 0;
    for (let index = latest; index < series.episodes.length && added < keepAhead; index++) {
      if (progressOf(progress, series, series.episodes[index].video)?.finished) continue;
      wanted.push({ series, episodeIndex: index });
      added++;
    }
  }
  return wanted;
}

function subtitleExtension(text: string) {
  const head = text.slice(0, 200).replace(/^﻿/, '');
  if (/^\s*\[Script Info\]/i.test(head)) return '.ass';
  if (/^\s*WEBVTT/.test(head)) return '.vtt';
  return '.srt';
}

export class AutoSync {
  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: AutoSyncState = { status: 'idle', kept: readManifest().files.length, queued: 0 };

  constructor(
    private serverUrl: () => string,
    private onState: (state: AutoSyncState) => void,
    private onLibraryChanged: () => void,
    private log: (kind: string, detail: string) => void,
  ) {}

  private set(next: Partial<AutoSyncState>) {
    this.state = { ...this.state, ...next };
    this.onState(this.state);
  }

  /** Check now (coalesced); called when the app opens and after syncs. Never throws. */
  kick() {
    if (this.stopped || this.running) return;
    void this.run();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => this.kick(), RECHECK_MS);
  }

  private async healthBlock(): Promise<string | null> {
    const health = await getDeviceHealth();
    if (health) {
      if (health.thermal === 'serious' || health.thermal === 'critical') return 'Phone is hot';
      if (health.lowPowerMode) return 'Low Power Mode is on';
      if (health.power === 'battery' && (health.batteryLevel ?? 1) < 0.2) return 'Battery below 20%';
    }
    if (Paths.availableDiskSpace < MIN_FREE_BYTES) return 'Less than 3 GB free';
    return null;
  }

  private async run() {
    this.running = true;
    let changed = false;
    try {
      this.set({ status: 'checking', detail: undefined });
      const { series: remote } = await fetchRemoteCatalog(this.serverUrl());
      const progress = allProgress();
      const wanted = pickEpisodes(remote, progress, KEEP_AHEAD, await requestedFolders(this.serverUrl()));
      const manifest = readManifest();

      // Remove copies auto sync made once they're watched and no longer wanted.
      const keep = new Set(wanted.map(({ series, episodeIndex }) => `${safeName(series.folder)}/${safeName(series.episodes[episodeIndex].video)}`));
      for (const path of [...manifest.files]) {
        const [folderName, ...rest] = path.split('/');
        const video = rest.join('/');
        const series = remote.find(item => safeName(item.folder) === folderName);
        const watched = series ? progressOf(progress, series, video)?.finished : false;
        if (keep.has(path) || !watched) continue;
        try {
          const file = new File(new Directory(Paths.document, folderName), video);
          if (file.exists) file.delete();
          for (const ext of ['.ass', '.srt', '.vtt']) {
            const subtitle = new File(new Directory(Paths.document, folderName), video.replace(/\.[^.]+$/, ext));
            if (subtitle.exists) subtitle.delete();
          }
          manifest.files = manifest.files.filter(item => item !== path);
          writeManifest(manifest);
          changed = true;
          this.log('Auto Sync', `Removed watched ${video}`);
        } catch (error) {
          logAutoSyncError(`remove ${path}`, error);
        }
      }

      const missing = wanted.filter(({ series, episodeIndex }) => {
        const file = new File(new Directory(Paths.document, safeName(series.folder)), safeName(series.episodes[episodeIndex].video));
        return !file.exists;
      });
      this.set({ queued: missing.length, kept: manifest.files.length });

      for (const [position, { series, episodeIndex }] of missing.entries()) {
        if (this.stopped) break;
        const block = await this.healthBlock();
        if (block) {
          this.set({ status: 'waiting', detail: block });
          this.log('Auto Sync', `Waiting: ${block}`);
          return;
        }
        const episode = series.episodes[episodeIndex];
        this.set({ status: 'downloading', detail: `${series.title} · ${episode.label} (${position + 1} of ${missing.length})` });
        const dir = new Directory(Paths.document, safeName(series.folder));
        const relative = `${safeName(series.folder)}/${safeName(episode.video)}`;
        try {
          if (!dir.exists) dir.create({ intermediates: true });
          if (episode.subtitleUri) {
            const response = await fetch(episode.subtitleUri);
            if (response.ok) {
              const text = await response.text();
              const name = safeName(episode.video).replace(/\.[^.]+$/, '') + subtitleExtension(text);
              new File(dir, name).write(text);
            }
          }
          // On iOS the file only appears here once the whole download has succeeded.
          await File.downloadFileAsync(episode.videoUri, new File(dir, safeName(episode.video)), { idempotent: true });
          manifest.files = [...manifest.files.filter(item => item !== relative), relative];
          writeManifest(manifest);
          changed = true;
          this.set({ kept: manifest.files.length, queued: missing.length - position - 1 });
          this.log('Auto Sync', `Saved ${series.title} · ${episode.label}`);
          this.onLibraryChanged();
          changed = false;
        } catch (error) {
          logAutoSyncError(`download ${relative}`, error);
          this.set({ status: 'error', detail: `Couldn't save ${episode.label}: ${error instanceof Error ? error.message : String(error)}` });
          this.log('Error', `Auto sync: ${episode.label} — ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      this.set({ status: 'idle', detail: undefined, queued: 0 });
    } catch (error) {
      // Mac away or catalog unreadable: keep playing from what's here and try again later.
      this.set({ status: 'idle', detail: 'Mac not reachable' });
      if (!/Network request failed|abort|timed? ?out/i.test(String(error))) logAutoSyncError('check', error);
    } finally {
      if (changed) this.onLibraryChanged();
      this.running = false;
      this.schedule();
    }
  }
}

/** Record crashes so their cause can be read from the phone afterwards. */
export function installCrashLog() {
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    logAutoSyncError(fatal ? 'FATAL' : 'error', error);
    previous(error, fatal);
  });
}
