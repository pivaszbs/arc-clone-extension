import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ stdin: { contents: "export { AutoSubtitles } from './src/japanese/auto-subtitles.ts'; export { setStudyTransport } from './src/japanese/client.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { AutoSubtitles, setStudyTransport } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
async function environment(run) {
  const keys = ['location', 'document', 'performance'];
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const resources = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://www.youtube.com/watch?v=a', hostname: 'www.youtube.com' } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { scripts: [], querySelectorAll: () => [] } });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => 0, getEntriesByType: () => resources } });
  try { await run(resources); }
  finally { keys.forEach((key, i) => originals[i] ? Object.defineProperty(globalThis, key, originals[i]) : delete globalThis[key]); }
}
test('finds Japanese native tracks without making the viewer enable visible captions', async () => {
  await environment(async () => {
    const track = { language: 'ja', label: 'Japanese', mode: 'disabled', cues: [{ startTime: 1, endTime: 3, text: 'それは何ですか。' }] };
    const source = new AutoSubtitles();
    await source.scan({ currentSrc: 'blob:video-a', textTracks: [track] });
    assert.equal(track.mode, 'hidden');
    assert.equal(source.cues[0].text, 'それは何ですか。');
    source.reset();
    assert.equal(track.mode, 'disabled');
  });
});
test('loads player caption requests automatically and drops a response after navigation', async () => {
  await environment(async (resources) => {
    resources.push({ name: 'https://cdn.example.com/current.ja.vtt', startTime: 1 });
    const source = new AutoSubtitles(); const requested = [];
    const video = { currentSrc: 'blob:video-a', textTracks: [], querySelectorAll: () => [] };
    setStudyTransport(async (message) => { requested.push(message); return { body: 'WEBVTT\n\n00:01.000 --> 00:03.000\nそれは何ですか。' }; });
    await source.scan(video);
    assert.equal(requested[0].type, 'JAPANESE_FETCH_CAPTIONS');
    assert.equal(source.cues.length, 1);
    const next = new AutoSubtitles(); let finish;
    setStudyTransport(() => new Promise((resolve) => { finish = resolve; }));
    const loading = next.scan(video);
    next.reset('new-video');
    finish({ body: 'WEBVTT\n\n00:01.000 --> 00:03.000\n古い字幕です。' });
    await loading;
    assert.equal(next.cues.length, 0);
  });
});
