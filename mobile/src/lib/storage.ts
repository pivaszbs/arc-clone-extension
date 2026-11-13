import { Directory, File, Paths } from 'expo-file-system';

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

export const progressFor = (key: string): Progress | undefined => load().progress[key];
export const allProgress = () => load().progress;
export function saveProgress(key: string, progress: Progress) {
  load().progress[key] = progress;
  persist();
}
export const settings = () => load().settings;
export function saveSettings(next: Partial<Settings>) {
  load().settings = { ...state.settings, ...next };
  persist();
}
