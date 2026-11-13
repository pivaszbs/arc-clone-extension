import { Directory, File, Paths } from 'expo-file-system';

import { canonicalEpisodeKey, setLocal } from './replica';

export const DEFAULT_TV_SERVER_URL = 'http://10.131.140.3:46158/cf7f1d1d391d8231/';

export type Progress = { position: number; duration: number; watchedAt: number; finished: boolean };
export type Settings = { autoSkip: boolean; subtitles: boolean; tvServerUrl: string };
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
