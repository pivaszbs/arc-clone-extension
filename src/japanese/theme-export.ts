import { overlapsRecap, type VideoThemes } from './video-themes';

/** Export only saved predictions for the selected series, keyed by exact video filename. */
export function exportVideoThemes(episodes: { name: string; themes: VideoThemes }[]): string | undefined {
  const entries = new Map<string, VideoThemes>();
  for (const { name, themes } of episodes) {
    if (entries.has(name)) throw new Error(`Duplicate video filename: ${name}`);
    const valid: VideoThemes = {};
    for (const part of ['op', 'ed', 'recap'] as const) {
      const range = themes?.[part];
      if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start) {
        valid[part] = { start: range.start, end: range.end };
      }
    }
    if (overlapsRecap(valid.op, valid.recap)) delete valid.op;
    entries.set(name, valid);
  }
  const saved = [...entries].filter(([, value]) => Object.keys(value).length);
  return saved.length ? JSON.stringify(Object.fromEntries(saved), null, 2) + '\n' : undefined;
}
