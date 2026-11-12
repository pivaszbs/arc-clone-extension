import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/japanese/study.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { parseSubtitles, schedule, supportedSite, sourceUrl } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('loads multiline SRT and VTT timing without treating markup as HTML', () => {
  assert.deepEqual(parseSubtitles('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n<b>それは</b>\r\n何ですか。\r\n\r\n2\r\n00:00:05,000 --> 00:00:04,000\r\ninvalid'), [{ start: 1.25, end: 3.5, text: 'それは\n何ですか。' }]);
  assert.deepEqual(parseSubtitles('WEBVTT\n\nline-1\n01:02.000 --> 01:04.100 align:start\nこんにちは'), [{ start: 62, end: 64.1, text: 'こんにちは' }]);
});
test('failed recalls return in ten minutes; success intervals grow with a cap', () => {
  const card = { interval: 0 };
  assert.equal(schedule(card, false, 0).due, 600000);
  const first = schedule(card, true, 0);
  assert.equal(first.due, 86400000);
  assert.equal(schedule(first, true, 0).interval, 2);
  assert.equal(schedule({ interval: 20 }, true, 0).interval, 30);
});
test('site matching and source links reject misleading domains and script URLs', () => {
  assert.equal(supportedSite('www.youtube.com'), true);
  assert.equal(supportedSite('smotret-anime.com'), true);
  assert.equal(supportedSite('youtube.com.evil.test'), false);
  assert.equal(sourceUrl('javascript:alert(1)', 5), '');
  assert.equal(sourceUrl('https://www.youtube.com/watch?v=abc&t=3', 12.9), 'https://www.youtube.com/watch?v=abc&t=12');
});
