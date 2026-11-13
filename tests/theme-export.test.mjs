import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entry) {
  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
}
const { exportVideoThemes } = await load('src/japanese/theme-export.ts');

test('exports saved predictions keyed by exact filenames and seconds', () => {
  const name = 'Episode 002 日本語 - 123.mp4';
  const themes = { op: { start: 60.5, end: 150 }, ed: { start: 1320, end: 1410 }, recap: { start: 0, end: 40 } };
  const exported = JSON.parse(exportVideoThemes([{ name, themes }, { name: 'Episode 3.mp4', themes: {} }]));
  assert.deepEqual(Object.keys(exported), [name]);
  assert.deepEqual(exported[name], themes);
});

test('invalid ranges and openings overlapping recaps are not exported', () => {
  const exported = JSON.parse(exportVideoThemes([{ name: 'a.mp4', themes: {
    op: { start: 20, end: 100 }, recap: { start: 0, end: 60 }, ed: { start: 100, end: Infinity }
  } }]));
  assert.deepEqual(exported, { 'a.mp4': { recap: { start: 0, end: 60 } } });
  assert.equal(exportVideoThemes([{ name: 'a.mp4', themes: { op: { start: -1, end: 50 } } }]), undefined);
  assert.equal(exportVideoThemes([]), undefined);
});

test('duplicate names fail instead of overwriting another episode', () => {
  assert.throws(() => exportVideoThemes([{ name: 'a.mp4', themes: {} }, { name: 'a.mp4', themes: {} }]), /Duplicate/);
});
