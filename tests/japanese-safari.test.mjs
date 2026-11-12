import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/japanese/safari/background.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
function harness() {
  let listener; let stored = {}; const requests = [];
  const browser = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { get: async () => structuredClone(stored), set: async (values) => { stored = { ...stored, ...structuredClone(values) }; } } }
  };
  const context = vm.createContext({ browser, console, URL, URLSearchParams, AbortSignal, crypto: globalThis.crypto, Intl, fetch: async (url) => {
    requests.push(String(url));
    return { ok: true, headers: { get: () => '100' }, text: async () => 'WEBVTT\n\n00:01.000 --> 00:03.000\nそれは何ですか。', json: async () => [[['What is that?']]] };
  } });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return { requests, send: (message) => new Promise((resolve) => { assert.equal(listener(message, {}, resolve), true); }) };
}
test('standalone Safari background saves and grades using browser APIs without Chrome or Userscripts', async () => {
  const app = harness();
  const saved = await app.send({ type: 'JAPANESE_SAVE', card: { text: 'それは何ですか。', meaning: 'What is that?', start: 1, end: 3, url: 'https://www.youtube.com/watch?v=a', title: 'Test' } });
  const graded = await app.send({ type: 'JAPANESE_GRADE', id: saved.cards[0].id, remembered: true });
  assert.equal(graded.cards[0].interval, 1);
  assert.equal((await app.send({ type: 'JAPANESE_LIST' })).cards.length, 1);
  assert.equal(app.requests.length, 0);
});
test('Safari fetches captions and translations and rejects non-caption source URLs', async () => {
  const app = harness();
  assert.match((await app.send({ type: 'JAPANESE_FETCH_CAPTIONS', url: 'https://cdn.example.com/ja.vtt' })).body, /それは/);
  assert.equal((await app.send({ type: 'TRANSLATE_TEXT', text: 'それは何ですか。' })).translatedText, 'What is that?');
  const rejected = await app.send({ type: 'JAPANESE_FETCH_CAPTIONS', url: 'https://account.example.com/settings' });
  assert.match(rejected.error, /Unsupported/);
  assert.equal(app.requests.length, 2);
});
test('Safari manifest contains only the learning extension and packaged local resources', async () => {
  const manifest = JSON.parse(await readFile('safari/web/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.background.persistent, false);
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.chrome_url_overrides, undefined);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].js[0], 'content.js');
});
