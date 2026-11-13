import { Directory, File, Paths } from 'expo-file-system';

import * as replica from './replica';
import { syncSoon } from './remote';

export type Progress = { position: number; duration: number; watchedAt: number; finished: boolean };
export type Settings = { autoSkip: boolean; subtitles: boolean };
type State = { progress: Record<string, Progress>; settings: Settings };

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'state.json');
let state: State = { progress: {}, settings: { autoSkip: true, subtitles: true } };
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

// Progress for "<series folder>/<video>" is shared with the Mac (and through it the TV) as
// ep/<series folder>/<video>/progress. The most recently watched position wins.
const replicaKey = (key: string) => (key.includes('/') ? `ep/${key}/progress` : undefined);

function newest(key: string): Progress | undefined {
  const local = load().progress[key];
  const id = replicaKey(key);
  const shared = id ? replica.get<Progress>(id) : undefined;
  if (!shared || typeof shared.position !== 'number' || typeof shared.watchedAt !== 'number') return local;
  return !local || shared.watchedAt > local.watchedAt ? { position: shared.position, watchedAt: shared.watchedAt, duration: shared.duration ?? 0, finished: !!shared.finished } : local;
}

export const progressFor = (key: string): Progress | undefined => newest(key);
export function allProgress(): Record<string, Progress> {
  const merged: Record<string, Progress> = { ...load().progress };
  for (const key of Object.keys(merged)) merged[key] = newest(key)!;
  return merged;
}
/** Progress for any key, including episodes only the Mac has watched so far. */
export const sharedProgressFor = (key: string) => newest(key);

export function saveProgress(key: string, progress: Progress) {
  load().progress[key] = progress;
  persist();
  const id = replicaKey(key);
  if (id && replica.setLocal(id, progress, progress.watchedAt)) syncSoon();
}
export const settings = () => load().settings;
export function saveSettings(next: Partial<Settings>) {
  load().settings = { ...state.settings, ...next };
  persist();
}
