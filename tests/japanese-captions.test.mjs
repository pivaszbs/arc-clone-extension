import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/japanese/captions.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { detectAnimeOpEdIntervals, parseCaptionResponse, subtitleUrl, japaneseCaptions, youtubeTracks } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test('finds opening and ending music in unlabelled ASS and ignores music under dialogue', () => {
  const ass = String.raw`[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:01.00,0:01:15.00,Default,♬
Dialogue: 0,0:00:40.00,0:00:43.00,Default,日本語です。
Dialogue: 0,0:01:30.00,0:02:15.00,Default,{\pos(172,497)}♬～
Dialogue: 0,0:02:15.00,0:03:00.00,Default,{\pos(172,497)}♬～
Dialogue: 0,0:22:00.00,0:22:45.00,Default,♬
Dialogue: 0,0:22:46.00,0:23:30.00,Default,♬`;
  assert.deepEqual(detectAnimeOpEdIntervals(ass, parseCaptionResponse(ass), 1440), {
    op: { start: 90, end: 180, source: 'subtitle-music' },
    ed: { start: 1320, end: 1410, source: 'subtitle-music' }
  });
});
test('reads Japanese timed text from player responses in VTT, XML, JSON3, ASS, and TTML', () => {
  assert.equal(parseCaptionResponse('WEBVTT\n\n00:01.000 --> 00:03.000\nそれは何ですか。')[0].start, 1);
  assert.deepEqual(parseCaptionResponse('<transcript><text start="1.2" dur="2">それは何ですか。</text></transcript>'), [{ start: 1.2, end: 3.2, text: 'それは何ですか。' }]);
  assert.deepEqual(parseCaptionResponse(JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: '日本語' }, { utf8: 'です。' }] }] })), [{ start: 1, end: 3.5, text: '日本語です。' }]);
  assert.deepEqual(parseCaptionResponse('[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,{\\an8}日本語,です。'), [{ start: 1, end: 3.5, text: '日本語,です。' }]);
  assert.deepEqual(parseCaptionResponse('<tt><p begin="00:00:01.000" end="00:00:03.000">やさしい<br/>日本語</p></tt>'), [{ start: 1, end: 3, text: 'やさしい\n日本語' }]);
});
test('detects Japanese theme markers and music cues in WebVTT', () => {
  const vtt = `WEBVTT

00:45.000 --> 02:15.000
【オープニング】

22:15.000 --> 23:45.000
（音楽）`;
  assert.deepEqual(detectAnimeOpEdIntervals(vtt, parseCaptionResponse(vtt), 1440), {
    op: { start: 45, end: 135, source: 'subtitle-label' },
    ed: { start: 1335, end: 1425, source: 'subtitle-music' }
  });
});
test('matches recurring subtitle lines when the themes move between episodes', () => {
  const lyrics = ['夕焼けの向こうへ歩いてゆこう', '長い長い道を渡ってゆこう', '遠く光る星を探しにゆこう',
    '止まらない風の声を聞こう', 'もう一度君とこの空を見よう', '何度でも明日を迎えにゆこう'];
  const theme = (start, lines) => lines.map((text, index) => ({ start: start + index * 15, end: start + index * 15 + 4, text }));
  const ending = lyrics.map(line => 'また会える日まで' + line);
  const episode = [...theme(45, lyrics), ...theme(1320, ending)];
  const reference = [...theme(90, lyrics), ...theme(1332, ending)];
  assert.deepEqual(detectAnimeOpEdIntervals('', episode, 1440, [reference]), {
    op: { start: 45, end: 124, source: 'repeated-subtitles' },
    ed: { start: 1320, end: 1399, source: 'repeated-subtitles' }
  });
});
test('overlapping subtitle cues do not create a fake opening gap', () => {
  const cues = [{ start: 5, end: 120, text: '場面の説明' }, { start: 15, end: 17, text: '本当ですか' }];
  for (let index = 0; index < 15; index++) cues.push({ start: 106 + index * 3, end: 108 + index * 3, text: 'そうです' });
  assert.equal(detectAnimeOpEdIntervals('', cues, 1440).op, null);
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
