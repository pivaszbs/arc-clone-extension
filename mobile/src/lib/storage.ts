import { Directory, File, Paths } from 'expo-file-system';

import type { Episode, Series } from './library';
import { skipRanges } from './theme-sidecar';
import { canonicalEpisodeKey, registerSeriesAlias, setLocal } from './replica';

export const DEFAULT_TV_SERVER_URL = 'http://10.131.140.3:46158/cf7f1d1d391d8231/';

export type Progress = { position: number; duration: number; watchedAt: number; finished: boolean };
export type Settings = { autoSkip: boolean; subtitles: boolean; tvServerUrl: string;
  /** The tab to reopen on. */
  tab?: 'watch' | 'download' | 'pipelines';
  /** The library to reopen on: the Mac's or this device's. */
  source?: 'server' | 'local';
};
type State = { progress: Record<string, Progress>; settings: Settings };

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'state.json');
let state: State = {
  progress: {},
  settings: { autoSkip: true, subtitles: true, tvServerUrl: DEFAULT_TV_SERVER_URL },
};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;

function load() {
  if (loaded) return state;
  loaded = true;
  try {
    if (file.exists) {
      const saved = JSON.parse(file.textSync()) as Partial<State>;
      state = { progress: saved.progress ?? {}, settings: { ...state.settings, ...saved.settings } };
    }
  } catch { /* A damaged state file starts fresh. */ }
  return state;
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      file.write(JSON.stringify(state));
    } catch { /* Progress is best effort. */ }
  }, 300);
}

export const progressFor = (key: string): Progress | undefined => load().progress[key];
export const allProgress = () => load().progress;
export function saveProgress(key: string, progress: Progress) {
  load().progress[key] = progress;
  persist();
  // Shared with the Mac (replica.ts); the watch time decides which device's progress wins.
  const shared = key.includes('/') ? canonicalEpisodeKey(key) : '';
  // Skip catalog-id keys the catalog hasn't resolved to a folder name yet; the Mac wouldn't know them.
  if (shared && !/^[0-9a-f]{16}\//.test(shared)) setLocal(`ep/${shared}/progress`, progress, progress.watchedAt);
}

/** Progress that arrived from the Mac through replication: stored without being re-recorded. */
export function applyReplicatedProgress(key: string, remote: Partial<Progress>) {
  if (typeof remote.position !== 'number' || typeof remote.watchedAt !== 'number' || typeof remote.finished !== 'boolean') return false;
  const map = load().progress;
  const existing = map[key];
  if (existing && existing.watchedAt > remote.watchedAt) return false;
  map[key] = {
    position: remote.position,
    duration: (typeof remote.duration === 'number' && remote.duration > 0 ? remote.duration : existing?.duration) ?? 0,
    watchedAt: remote.watchedAt,
    finished: remote.finished,
  };
  persist();
  return true;
}
export function mergeProgress(entries: Record<string, Progress>) {
  const map = load().progress;
  let changed = false;
  for (const [key, remote] of Object.entries(entries)) {
    const existing = map[key];
    if (!existing || remote.watchedAt >= existing.watchedAt) {
      map[key] = {
        position: remote.position,
        duration: remote.duration || existing?.duration || 0,
        watchedAt: remote.watchedAt,
        finished: remote.finished,
      };
      changed = true;
    }
  }
  if (changed) persist();
}
export const settings = () => load().settings;
export function saveSettings(next: Partial<Settings>) {
  load().settings = { ...state.settings, ...next };
  persist();
}

// ----- The Mac's catalog as last seen -----

const catalogFile = new File(folder, 'catalog.json');

/**
 * The Mac's library as it was last loaded, so the app opens on covers at once (and offline, where
 * downloaded episodes still play) instead of an empty screen until the Mac answers.
 */
export function cachedCatalog(): Series[] {
  try {
    if (!catalogFile.exists) return [];
    const saved = JSON.parse(catalogFile.textSync()) as unknown;
    if (!Array.isArray(saved)) return [];
    // Keep only what this app wrote: a cache in another shape (the Mac's raw catalog, an older
    // build) has no keys, URLs or skip ranges, and rendering it would crash the app at launch.
    const series = (saved as Series[])
      .filter(item => item && typeof item.folder === 'string' && typeof item.title === 'string' && Array.isArray(item.episodes))
      .map(item => ({
        ...item,
        episodes: item.episodes
          .filter((ep: Partial<Episode> | null) => !!ep && typeof ep.key === 'string' && typeof ep.videoUri === 'string' && typeof ep.video === 'string')
          .map(ep => ({ ...ep, frames: skipRanges(ep.frames) })),
      }))
      .filter(item => item.episodes.length > 0);
    for (const item of series) {
      // Episode keys start with the Mac's series id; progress saved offline still needs its folder name.
      const key = item.episodes[0]?.key ?? '';
      const slash = key.indexOf('/');
      if (slash > 0) registerSeriesAlias(key.slice(0, slash), item.folder);
    }
    return series;
  } catch { return []; }
}

/** `text` is the catalog already serialised (the caller compares it to spot changes). */
export function saveCatalog(text: string) {
  try {
    if (!folder.exists) folder.create({ intermediates: true });
    catalogFile.write(text);
  } catch { /* Best effort: the next launch just waits for the Mac. */ }
}
