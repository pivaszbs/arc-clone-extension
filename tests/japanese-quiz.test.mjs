import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/japanese/quiz.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { knowledge, classify, choices, ListeningQuiz } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const cue = { start: 1, end: 2, text: 'それは何ですか。' };
const card = { ...cue, id: 'a', meaning: 'What is that?', interval: 1, due: 0 };
test('learns vocabulary from successful answers and respects the due date', () => {
  assert.equal(classify(cue, knowledge([card])).kind, 'known');
  assert.equal(classify(cue, knowledge([{ ...card, due: Date.now() + 86400000 }])), null);
  assert.equal(knowledge([{ ...card, interval: 0 }]).words.size, 0);
  assert.equal(classify({ ...cue, text: '猫' }, knowledge([])).unknown.length, 1);
  assert.equal(classify({ ...cue, text: '猫 犬 鳥 魚' }, knowledge([])), null);
});
test('pauses at the end of a known phrase, once per occurrence', () => {
  const engine = new ListeningQuiz(); const known = knowledge([card]);
  assert.equal(engine.observe(cue, 1, true, known, 0), null);
  assert.equal(engine.observe(cue, 1.8, true, known, 0), null);
  assert.equal(engine.observe(null, 2, true, known, 0).kind, 'known');
  assert.equal(engine.observe(null, 2.1, true, known, 0), null);
  assert.equal(engine.observe(cue, 1, true, known, 0), null);
  assert.equal(engine.observe(null, 2, true, known, 0), null);
});
test('samples unfamiliar lines once, does not pause mid-line, and skips seeks', () => {
  const known = knowledge([]); const short = { start: 1, end: 2, text: '猫' };
  const engine = new ListeningQuiz(); let rolls = 0;
  const random = () => { rolls++; return 0; };
  engine.observe(short, 1, true, known, 0.25, random);
  engine.observe(short, 1.2, true, known, 0.25, random);
  assert.equal(rolls, 1);
  assert.equal(engine.observe(null, 2, true, known, 0.25, random).kind, 'stretch');
  const scrubbed = new ListeningQuiz(); scrubbed.observe(short, 1, true, known, 1);
  assert.equal(scrubbed.observe(null, 20, true, known, 1), null);
  const paused = new ListeningQuiz(); paused.observe(short, 1, true, known, 1);
  assert.equal(paused.observe(null, 2, false, known, 1), null);
});
test('visible YouTube captions finish when the displayed line changes', () => {
  const engine = new ListeningQuiz(); const known = knowledge([card]);
  engine.observe({ ...cue, estimated: true }, 1, true, known, 1);
  assert.equal(engine.observe({ ...cue, end: 1.2, estimated: true }, 1.2, true, known, 1), null);
  assert.equal(engine.observe(null, 2, true, known, 1).cue.text, cue.text);
});
test('quiz includes the expected answer exactly once and four distinct choices', () => {
  const result = choices('What is that?', [card, { ...card, meaning: 'What is that?' }], () => 0.5);
  assert.equal(result.length, 4);
  assert.equal(new Set(result).size, 4);
  assert.equal(result.filter((answer) => answer === card.meaning).length, 1);
});
test('automatic answer results persist and separate quiz preferences from saved cards', async () => {
  const compiledStorage = await build({ entryPoints: ['src/japanese/storage.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { studyRequest } = await import('data:text/javascript;base64,' + Buffer.from(compiledStorage.outputFiles[0].text).toString('base64'));
  let stored = {};
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(stored), set: async (values) => { stored = { ...stored, ...structuredClone(values) }; } } } };
  try {
    const input = { ...card, url: 'https://www.youtube.com/watch?v=test', title: 'Test' };
    const saved = await studyRequest({ type: 'JAPANESE_SAVE', card: input });
    const id = saved.cards[0].id;
    assert.equal(saved.cards[0].interval, 0);
    const correct = await studyRequest({ type: 'JAPANESE_GRADE', id, remembered: true });
    assert.equal(correct.cards[0].interval, 1);
    assert.ok(correct.cards[0].due > Date.now() + 86000000);
    const [preferences, missed] = await Promise.all([
      studyRequest({ type: 'JAPANESE_QUIZ_SETTINGS', settings: { chance: 0.5 } }),
      studyRequest({ type: 'JAPANESE_GRADE', id, remembered: false })
    ]);
    assert.equal(preferences.settings.chance, 0.5);
    assert.equal(missed.cards[0].interval, 0);
    const reloaded = await studyRequest({ type: 'JAPANESE_LIST' });
    assert.equal(reloaded.cards.length, 1);
    assert.equal(reloaded.settings.chance, 0.5);
  } finally { delete globalThis.chrome; }
});
