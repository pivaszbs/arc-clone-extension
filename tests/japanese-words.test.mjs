import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';

const load = async (entry) => {
  const compiled = await build({ stdin: { contents: entry, resolveDir: 'src/japanese', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};
const { loadDictionary, tokenize, romaji, tokenRomaji, segmentRomaji, spell, analyseEpisode, episodeTargets, coverage, wordStop, wordChoices, wordId, scheduleWord, applyWordMessage, createStudyStore, WORDS_KEY } =
  await load("export * from './dictionary'; export * from './episode-words'; export * from './word-cards'; export * from './storage';");
loadDictionary(JSON.parse(readFileSync('src/japanese/dictionary-data.json', 'utf8')).entries);

const bases = (text) => tokenize(text).filter((token) => token.entry).map((token) => token.base);
const cue = (text, start = 0) => ({ start, end: start + 2, text });

test('brings conjugated words back to their dictionary form', () => {
  assert.deepEqual(bases('昨日、友達と映画を見ました。'), ['昨日', '友達', 'と', '映画', 'を', '見る']);
  assert.deepEqual(bases('食べさせられませんでした'), ['食べる']);
  assert.deepEqual(bases('何してるの？'), ['何', 'する', 'の']);
  assert.deepEqual(bases('お前はもう死んでいる'), ['お前', 'は', 'もう', '死ぬ']);
  assert.deepEqual(bases('行かなきゃ'), ['行く']);
  assert.deepEqual(bases('今日は暑かったです'), ['今日', 'は', '暑い', 'です']);
  assert.deepEqual(bases('早く来て！'), ['早く', '来る']);
});

test('splits words into kanji groups, each with its own reading', () => {
  const segments = (text) => tokenize(text).filter((token) => token.entry).map((token) => token.segments.map((part) => part.reading ? `${part.text}:${part.reading}` : part.text).join(' '));
  assert.deepEqual(segments('泥棒のお母さん'), ['泥:どろ 棒:ぼう', 'の', 'お 母:かあ さん']);
  assert.deepEqual(segments('食べさせられませんでした'), ['食:た べさせられませんでした']);
  assert.deepEqual(segments('来ない'), ['来:こ ない']);
  assert.deepEqual(segments('今日'), ['今日:きょう']);
  assert.deepEqual(spell('日本語', 'にほんご'), [{ text: '日本', reading: 'にほん' }, { text: '語', reading: 'ご' }]);
});

test('prefers a split that lets the rest of the line make sense', () => {
  assert.deepEqual(bases('それは何ですか。').slice(0, 3), ['それ', 'は', '何']);
});

test('leaves names and unknown text as plain tokens', () => {
  const tokens = tokenize('ルフィは Luffy だ');
  assert.equal(tokens[0].entry, undefined);
  assert.equal(tokens[0].surface, 'ルフィ');
  assert.ok(tokens.some((token) => token.surface.includes('Luffy') && !token.entry));
});

test('reads words in romaji for learners without kana', () => {
  const [school] = tokenize('学校');
  assert.deepEqual(school.segments, [{ text: '学', reading: 'がっ' }, { text: '校', reading: 'こう' }]);
  assert.deepEqual(segmentRomaji(school.segments), ['gak', 'kou']);
  assert.deepEqual(['きょう', 'がっこう', 'ちょっと', 'しんぶん', 'きんえん', 'コーヒー', 'まっちゃ', 'じゃあ'].map(romaji),
    ['kyou', 'gakkou', 'chotto', 'shinbun', "kin'en", 'koohii', 'matcha', 'jaa']);
  const [watashi, wa, , desu] = tokenize('私は学生です');
  assert.equal(tokenRomaji(watashi), 'watashi');
  assert.equal(tokenRomaji(wa), 'wa');
  assert.equal(tokenRomaji(desu), 'desu');
  assert.equal(tokenRomaji(tokenize('見ました')[0]), 'mimashita');
  assert.equal(tokenRomaji(tokenize('来ない')[0]), 'konai');
});

const episode = analyseEpisode([cue('友達と映画を見ました', 0), cue('友達は学生です', 10), cue('映画を見る', 20), cue('友達だよ', 30), cue('猫がいる', 40)]);
const friend = [...episode.words.values()].find((word) => word.word === '友達');

test('picks the episode’s most frequent unseen words and skips particles', () => {
  assert.equal(friend.count, 3);
  assert.equal(friend.first.start, 0);
  assert.ok(![...episode.words.values()].some((word) => ['は', 'を', 'と', 'だ', 'です'].includes(word.word)));
  const { fresh, learning } = episodeTargets(episode, new Map(), 2);
  assert.deepEqual(fresh.map((word) => word.word), ['友達', '映画']);
  assert.equal(learning.length, 0);
  // A word heard once is never picked: it cannot be practised again in this episode.
  assert.ok(!episodeTargets(episode, new Map(), 20).fresh.some((word) => word.word === '猫'));
});

test('words still being learned use up the slots for new ones', () => {
  const card = { id: friend.id, word: '友達', reading: 'ともだち', gloss: 'friend', step: 0, interval: 0, due: 0 };
  const targets = episodeTargets(episode, new Map([[card.id, card]]), 2);
  assert.deepEqual(targets.learning.map((word) => word.word), ['友達']);
  assert.equal(targets.fresh.length, 1);
  assert.equal(coverage(episode, new Map([[card.id, { ...card, interval: 1 }]])).knownWords, 1);
  assert.ok(coverage(episode, new Map([[card.id, { ...card, known: true }]])).share > 0.2);
});

test('teaches a new word first, then asks it once it is due', () => {
  const tokens = tokenize('友達と映画を見ました');
  const fresh = (id) => id === friend.id;
  assert.deepEqual(wordStop(tokens, new Map(), fresh), { id: friend.id, index: 0, action: 'teach' });
  assert.equal(wordStop(tokens, new Map(), () => false), null);
  const card = { id: friend.id, word: '友達', reading: 'ともだち', gloss: 'friend', step: 0, interval: 0, due: 1000 };
  assert.equal(wordStop(tokens, new Map([[card.id, card]]), () => false, 500), null);
  assert.equal(wordStop(tokens, new Map([[card.id, card]]), () => false, 2000).action, 'quiz');
  assert.equal(wordStop(tokens, new Map([[card.id, { ...card, known: true }]]), () => false, 2000), null);
});

test('new words repeat within the episode before moving to day-based reviews', () => {
  const card = { id: 'a', word: '猫', reading: 'ねこ', gloss: 'cat', step: 0, interval: 0, due: 0 };
  const once = scheduleWord(card, true, 0);
  assert.deepEqual([once.interval, once.due], [0, 600000]);
  const twice = scheduleWord(once, true, 0);
  assert.deepEqual([twice.interval, twice.due], [1, 86400000]);
  assert.equal(scheduleWord(twice, true, 0).interval, 2);
  assert.deepEqual(scheduleWord(twice, false, 0), { ...card, due: 60000 });
});

test('offers the right meaning among four distinct choices', () => {
  const options = wordChoices('friend', ['cat', 'friend', 'dog', 'cat', 'bird', 'fish']);
  assert.equal(options.length, 4);
  assert.equal(new Set(options).size, 4);
  assert.ok(options.includes('friend'));
});

test('saves, marks and grades words alongside phrases', async () => {
  let stored = {};
  const store = createStudyStore({ get: async () => stored, set: async (values) => { stored = { ...stored, ...values }; } });
  const word = { id: wordId(friend.entry), word: '友達', reading: 'ともだち', gloss: 'friend; companion', example: { text: '友達だよ', url: 'https://example.com', title: 'Episode 1', start: 1, end: 2 } };
  let response = await store({ type: 'JAPANESE_WORD_SAVE', word });
  assert.equal(response.words.length, 1);
  assert.equal(response.words[0].example.text, '友達だよ');
  response = await store({ type: 'JAPANESE_WORD_SAVE', word });
  assert.equal(response.words.length, 1);
  response = await store({ type: 'JAPANESE_WORD_GRADE', id: word.id, remembered: true });
  assert.equal(response.words[0].step, 1);
  response = await store({ type: 'JAPANESE_WORD_SAVE', word: { ...word, known: true } });
  assert.equal(response.words[0].known, true);
  assert.equal((await store({ type: 'JAPANESE_LIST' })).words.length, 1);
  assert.equal(stored[WORDS_KEY].length, 1);
  await assert.rejects(store({ type: 'JAPANESE_WORD_SAVE', word: { id: 'x' } }));
  await assert.rejects(store({ type: 'JAPANESE_WORD_GRADE', id: 'missing', remembered: true }));
  assert.equal(applyWordMessage([], { type: 'JAPANESE_LIST' }), null);
  const settings = (await store({ type: 'JAPANESE_QUIZ_SETTINGS', settings: { chance: 0, wordsInPlay: 3, reading: 'kana', junk: 1 } })).settings;
  assert.deepEqual(settings, { chance: 0, wordsInPlay: 3, reading: 'kana' });
});

test('beginner list levels and pace labels', async () => {
  const { levelOf, describePace } = await load("export * from './beginner-anime';");
  assert.equal(levelOf(0, 280).key, 'start');
  assert.equal(levelOf(20, 280).key, 'next');
  assert.equal(levelOf(39, 280).key, 'later');
  assert.equal(describePace(90), 'Slow speech');
  assert.equal(describePace(130), 'Moderate speech');
  assert.equal(describePace(170), 'Fast speech');
});

test('bundled beginner list is ordered, linked and keyed by word ids', () => {
  const list = JSON.parse(readFileSync('src/japanese/beginner-anime.json', 'utf8'));
  assert.ok(list.series.length >= 10 && list.series.length <= list.ranked);
  for (const [index, item] of list.series.entries()) {
    assert.match(item.url, /^https:\/\/smotret-anime\.com\/catalog\/[\w-]+-\d+$/);
    if (item.firstEpisode) assert.match(item.firstEpisode, /^https:\/\/smotret-anime\.com\/catalog\//);
    assert.ok(item.topWords.length > 0 && item.topWords.every((id) => /^[^|]+\|[^|]+$/.test(id)));
    if (index) assert.ok(item.difficulty >= list.series[index - 1].difficulty);
  }
});
