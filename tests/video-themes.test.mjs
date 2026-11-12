import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/japanese/video-themes.ts'], bundle: true, write: false, format: 'esm' });
const { matchVideoThemes } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

function frames(length, makeFrame) {
  return Array.from({ length }, (_, time) => ({ time, pixels: makeFrame(time) }));
}

function frame(seed) {
  return Uint8ClampedArray.from({ length: 384 }, (_, index) => (Math.imul(seed, index * 773 + 2833) >>> (index % 13)) % 256);
}

test('finds a theme that starts an odd number of seconds later in another episode', () => {
  const episode = (start, seed) => frames(155, time => frame(time >= start && time < start + 86 ? time - start + 123 : time + seed));
  const current = { op: episode(32, 700), ed: [] };
  const reference = { op: episode(57, 9800), ed: [] };
  // Frames 32–117 belong to the theme, so its edges lie halfway to the neighbouring samples.
  assert.deepEqual(matchVideoThemes(current, reference), { op: { start: 31.5, end: 117.5 }, ed: undefined });
});

test('places theme edges to the second even when the coarse pass samples every other frame', () => {
  const episode = (start, seed) => frames(170, time => frame(time >= start && time < start + 89 ? time - start + 123 : time + seed));
  const current = { op: episode(33, 700), ed: [] };
  const reference = { op: episode(10, 9800), ed: [] };
  assert.deepEqual(matchVideoThemes(current, reference).op, { start: 32.5, end: 121.5 });
});

test('does not treat a long static sequence as a theme', () => {
  const staticFrames = frames(100, () => new Uint8ClampedArray(384));
  assert.deepEqual(matchVideoThemes({ op: [], ed: staticFrames }, { op: [], ed: staticFrames }), { op: undefined, ed: undefined });
});

test('does not offer to skip a brief repeated prologue', () => {
  const episode = seed => frames(150, time => frame(time < 62 ? time + 123 : time + seed));
  assert.equal(matchVideoThemes({ op: episode(700), ed: [] }, { op: episode(9800), ed: [] }).op, undefined);
});
