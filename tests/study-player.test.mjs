import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/japanese/study-player.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { PhraseStops } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const first = { start: 1, end: 2, text: '最初の字幕です。' };
const second = { start: 1.6, end: 2, text: '次の字幕です。' };
const timeline = [first, second];

test('random practice samples each completed phrase once, including overlapping subtitles', () => {
  const stops = new PhraseStops();
  const rolls = [0.8, 0.1];
  const random = () => rolls.shift();
  assert.equal(stops.observe(timeline, first, 1, 0.25, random), null);
  assert.equal(stops.observe(timeline, first, 1.9, 0.25, random), null);
  assert.equal(stops.observe(timeline, null, 2, 0.25, random), second);
  assert.equal(stops.observe(timeline, null, 2.1, 0.25, random), null);
  assert.deepEqual(rolls, []);
});

test('every phrase pauses for both lines that finish at the same time and skips jumped-over lines', () => {
  const stops = new PhraseStops();
  stops.observe(timeline, first, 1, 1);
  assert.equal(stops.observe(timeline, null, 2, 1), first);
  assert.equal(stops.observe(timeline, null, 2.1, 1), second);
  stops.reset();
  stops.observe(timeline, first, 1, 1);
  assert.equal(stops.observe(timeline, null, 20, 1), null);
});
