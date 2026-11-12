import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/japanese/userscript-transport.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { createUserscriptTransport } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function api() {
  const stored = new Map(); let requests = 0;
  return {
    get requests() { return requests; },
    async getValue(key, fallback) { return structuredClone(stored.has(key) ? stored.get(key) : fallback); },
    async setValue(key, value) { stored.set(key, structuredClone(value)); },
    async listValues() { return [...stored.keys()]; },
    async xmlHttpRequest(details) {
      requests++; assert.equal(new URL(details.url).hostname, 'translate.googleapis.com');
      return { status: 200, responseText: JSON.stringify([[['What is that?', 'それは何ですか。']]]) };
    }
  };
}
const card = { text: 'それは何ですか。', meaning: 'What is that?', start: 1, end: 5, url: 'https://www.youtube.com/watch?v=test', title: 'Test' };
test('iPad saves and schedules phrases across origins without Chrome APIs', async () => {
  const gm = api(); const youtube = createUserscriptTransport(gm); const anime = createUserscriptTransport(gm);
  const initial = await youtube({ type: 'JAPANESE_SAVE', card });
  const id = initial.cards[0].id;
  assert.equal((await anime({ type: 'JAPANESE_LIST' })).cards[0].id, id);
  await anime({ type: 'JAPANESE_GRADE', id, remembered: true });
  assert.equal((await youtube({ type: 'JAPANESE_LIST' })).cards[0].interval, 1);
  await youtube({ type: 'JAPANESE_QUIZ_SETTINGS', settings: { chance: 0.5 } });
  assert.equal((await anime({ type: 'JAPANESE_LIST' })).settings.chance, 0.5);
  assert.equal(gm.requests, 0);
});
test('concurrent player-frame saves preserve both phrases', async () => {
  const gm = api();
  await Promise.all([
    createUserscriptTransport(gm)({ type: 'JAPANESE_SAVE', card }),
    createUserscriptTransport(gm)({ type: 'JAPANESE_SAVE', card: { ...card, text: '分かりません。', meaning: 'I do not understand.' } })
  ]);
  assert.equal((await createUserscriptTransport(gm)({ type: 'JAPANESE_LIST' })).cards.length, 2);
});
test('translation uses the userscript cross-origin API and failed requests remain retryable', async () => {
  const gm = api(); const request = createUserscriptTransport(gm);
  assert.equal((await request({ type: 'TRANSLATE_TEXT', text: card.text })).translatedText, card.meaning);
  gm.xmlHttpRequest = async () => ({ status: 429, responseText: '' });
  await assert.rejects(request({ type: 'TRANSLATE_TEXT', text: card.text }), /unavailable/);
  assert.equal((await request({ type: 'JAPANESE_LIST' })).cards.length, 0);
});
