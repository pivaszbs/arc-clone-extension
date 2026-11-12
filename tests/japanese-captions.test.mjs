import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/japanese/captions.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { parseCaptionResponse, subtitleUrl, japaneseCaptions, youtubeTracks } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test('reads Japanese timed text from player responses in VTT, XML, JSON3, ASS, and TTML', () => {
  assert.equal(parseCaptionResponse('WEBVTT\n\n00:01.000 --> 00:03.000\nそれは何ですか。')[0].start, 1);
  assert.deepEqual(parseCaptionResponse('<transcript><text start="1.2" dur="2">それは何ですか。</text></transcript>'), [{ start: 1.2, end: 3.2, text: 'それは何ですか。' }]);
  assert.deepEqual(parseCaptionResponse(JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: '日本語' }, { utf8: 'です。' }] }] })), [{ start: 1, end: 3.5, text: '日本語です。' }]);
  assert.deepEqual(parseCaptionResponse('[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,{\\an8}日本語,です。'), [{ start: 1, end: 3.5, text: '日本語,です。' }]);
  assert.deepEqual(parseCaptionResponse('<tt><p begin="00:00:01.000" end="00:00:03.000">やさしい<br/>日本語</p></tt>'), [{ start: 1, end: 3, text: 'やさしい\n日本語' }]);
});
test('only fetches caption-shaped public HTTPS URLs and rejects translated or English tracks', () => {
  assert.equal(subtitleUrl('https://cdn.example.com/ep1/ja.ass?signature=abc'), true);
  assert.equal(subtitleUrl('https://www.youtube.com/api/timedtext?v=abc&lang=ja'), true);
  for (const url of ['https://www.youtube.com/api/timedtext?lang=en&tlang=ja', 'https://cdn.example.com/sub.vtt?lang=en', 'http://localhost/sub.vtt', 'https://192.168.1.1/private.vtt', 'https://account.example.com/settings', 'javascript:alert(1)']) assert.equal(subtitleUrl(url), false);
});
test('discovers Japanese YouTube caption metadata without executing page code', () => {
  const tracks = [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en' }, { languageCode: 'ja', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=ja' }];
  const response = youtubeTracks('window.data={"captionTracks":' + JSON.stringify(tracks) + ',"other":"ignored"}');
  assert.equal(response.length, 1);
  assert.equal(response[0].label, 'Japanese auto-captions');
  assert.equal(youtubeTracks('"captionTracks":' + JSON.stringify(tracks), 'another-video').length, 0);
  assert.deepEqual(youtubeTracks('"captionTracks":[window.secret]'), []);
});
test('does not mistake English or Chinese subtitle files for Japanese', () => {
  assert.equal(japaneseCaptions([{ start: 1, end: 2, text: 'What is that?' }]), false);
  assert.equal(japaneseCaptions([{ start: 1, end: 2, text: '這是什麼' }]), false);
  assert.equal(japaneseCaptions([{ start: 1, end: 2, text: 'それは何ですか。' }]), true);
});
