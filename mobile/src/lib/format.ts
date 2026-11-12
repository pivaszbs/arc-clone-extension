export function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Index of the cue on screen at `time` (cues sorted by start). Runs every frame, so it stays in JS. */
export function cueAt<T extends { start: number; end: number }>(cues: T[], time: number) {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid]!.start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  for (let index = found; index >= 0 && index >= found - 8; index--) if (time < cues[index]!.end) return index;
  return -1;
}
