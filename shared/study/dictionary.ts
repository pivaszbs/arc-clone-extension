// Word lookup for the study player: longest-match segmentation over a pruned JMdict table,
// with enough de-inflection to bring 食べました back to 食べる.

export type Entry = { written: string[]; reading: string; pos: string[]; gloss: string; usuallyKana: boolean; splits?: Record<string, string> };
/** Part of a written word; `reading` is set when the part contains kanji. */
export type Segment = { text: string; reading?: string };
export type Token = {
  surface: string;
  entry?: Entry;
  /** Dictionary form as written in the line's script, e.g. 食べる for 食べました. */
  base?: string;
  /** Kana reading of the surface form. */
  reading?: string;
  /** False for short kana matches that may be a different word. */
  confident?: boolean;
  /** The surface split into kana and kanji groups, each kanji group with its own reading. */
  segments?: Segment[];
};

const V1 = 1, V5 = 2, ADJ = 4, VK = 8, VS = 16, TE = 32, TERM = 64, ANY = 127;
type Rule = { from: string; to: string; as: number; base: number };

const rows = { u: 'うくぐすつぬぶむる', i: 'いきぎしちにびみり', a: 'わかがさたなばまら', e: 'えけげせてねべめれ', o: 'おこごそとのぼもろ' };
const teForms = ['って', 'いて', 'いで', 'して', 'って', 'んで', 'んで', 'んで', 'って'];
// Endings that follow a verb's ます-stem, with the kind of word each one forms.
const stemEndings: [string, number][] = [
  ['ます', TERM], ['ません', TERM], ['ました', TERM], ['ませんでした', TERM], ['ましょう', TERM], ['まして', TERM],
  ['たい', ADJ], ['ながら', TERM], ['なさい', TERM], ['すぎる', V1], ['やすい', ADJ], ['にくい', ADJ], ['そう', TERM]
];
// Endings that replace the final て / で of a て-form.
const teEndings: [string, string, number][] = [
  ['て', 'で', TE | TERM], ['た', 'だ', TERM], ['たら', 'だら', TERM], ['たり', 'だり', TERM]
];

const rules = new Map<string, Rule[]>();
function rule(from: string, to: string, as: number, base: number) {
  const key = from.at(-1)!;
  const list = rules.get(key);
  if (list) list.push({ from, to, as, base });
  else rules.set(key, [{ from, to, as, base }]);
}

// Ichidan verbs; 来る follows the same pattern after its kanji.
for (const [ending, as] of stemEndings) rule(ending, 'る', as, V1 | VK);
for (const [ending, , as] of teEndings) rule(ending, 'る', as, V1 | VK);
for (const [ending, as] of [['ない', ADJ], ['られる', V1], ['れる', V1], ['させる', V1], ['よう', TERM], ['れば', TERM], ['ろ', TERM]] as [string, number][]) rule(ending, 'る', as, V1 | VK);

// Godan verbs.
for (let index = 0; index < rows.u.length; index++) {
  const plain = rows.u[index];
  for (const [ending, as] of stemEndings) rule(rows.i[index] + ending, plain, as, V5);
  rule(rows.i[index], plain, TERM, V5);
  const te = teForms[index];
  const voiced = te.endsWith('で');
  for (const [ending, voicedEnding, as] of teEndings) rule(te.slice(0, -1) + (voiced ? voicedEnding : ending), plain, as, V5);
  rule(rows.a[index] + 'ない', plain, ADJ, V5);
  rule(rows.a[index] + 'れる', plain, V1, V5);
  rule(rows.a[index] + 'せる', plain, V1, V5);
  rule(rows.a[index] + 'される', plain, V1, V5);
  rule(rows.e[index] + 'る', plain, V1, V5);
  rule(rows.e[index] + 'ば', plain, TERM, V5);
  rule(rows.e[index], plain, TERM, V5);
  rule(rows.o[index] + 'う', plain, TERM, V5);
}
// 行く is the one godan verb with an irregular て-form.
for (const stem of ['行', 'い']) for (const [ending, , as] of teEndings) rule(stem + 'っ' + ending, stem + 'く', as, V5);

// い-adjectives, including the adjective-like ない / たい forms.
// Spoken "must": 行かなきゃ, 行かなくちゃ.
for (const from of ['なきゃ', 'なくちゃ', 'なければ']) rule(from, 'ない', TERM, ADJ);
for (const [ending, as] of [['く', TERM], ['くて', TE | TERM], ['かった', TERM], ['かったら', TERM], ['くない', ADJ], ['ければ', TERM], ['さ', TERM], ['そう', TERM], ['すぎる', V1]] as [string, number][]) rule(ending, 'い', as, ADJ);

// する and くる.
for (const [ending, as] of stemEndings) { rule('し' + ending, 'する', as, VS); rule('き' + ending, 'くる', as, VK); }
for (const [ending, , as] of teEndings) { rule('し' + ending, 'する', as, VS); rule('き' + ending, 'くる', as, VK); }
for (const [from, as] of [['しない', ADJ], ['しよう', TERM], ['すれば', TERM], ['しろ', TERM], ['される', V1], ['させる', V1]] as [string, number][]) rule(from, 'する', as, VS);
for (const [from, as] of [['こない', ADJ], ['こよう', TERM], ['くれば', TERM], ['こい', TERM], ['こられる', V1], ['こさせる', V1]] as [string, number][]) rule(from, 'くる', as, VK);

// Spoken contractions built on the て-form: 食べてる, 食べちゃう, 食べとく.
for (const [from, to, as] of [['ている', 'て', V1], ['てる', 'て', V1], ['てた', 'て', TERM], ['ちゃう', 'て', V5], ['とく', 'て', V5],
  ['でいる', 'で', V1], ['でる', 'で', V1], ['でた', 'で', TERM], ['じゃう', 'で', V5], ['どく', 'で', V5]] as [string, string, number][]) rule(from, to, as, TE);

// Everyday grammar words the common-word list leaves out.
const extras = '\tん\tprt,uk\t(explains or stresses; spoken の)\n\tじゃ\tconj,uk\twell then; (spoken では)\n\tなきゃ\texp,uk\thave to; must (spoken なければ)';

let index = new Map<string, Entry[]>();
let longest = 1;
const cache = new Map<string, Token[]>();
const functionPos = new Set(['prt', 'cop', 'conj', 'aux', 'aux-v', 'aux-adj', 'suf', 'n-suf', 'pref', 'n-pref', 'ctr']);

export const dictionaryReady = () => index.size > 0;
export const isKana = (text: string) => /^[぀-ヿー]+$/u.test(text);
const isHiragana = (text: string) => /^[぀-ゟ]+$/u.test(text);
const japanese = /[぀-ヿ㐀-鿿々ー]/u;
/** Particles, copulas and other glue: shown and explained, but never set as words to learn. */
export const isFunctionWord = (entry: Entry) => functionPos.has(entry.pos[0]);

export function loadDictionary(entries: string) {
  index = new Map();
  longest = 1;
  cache.clear();
  matches.clear();
  for (const line of (entries + '\n' + extras).split('\n')) {
    const [written, reading, pos, gloss] = line.split('\t');
    if (!reading || !gloss) continue;
    const tags = pos.split(',');
    const usuallyKana = tags.includes('uk');
    const forms = written ? written.split('|') : [];
    const entry: Entry = { written: forms.map((form) => form.split('~')[0]), reading, pos: tags.filter((tag) => tag !== 'uk'), gloss, usuallyKana };
    for (const form of forms) {
      const [text, split] = form.split('~');
      if (split) (entry.splits ??= {})[text] = split;
    }
    for (const key of [...entry.written, reading]) {
      const list = index.get(key);
      if (list) list.push(entry);
      else index.set(key, [entry]);
      if (key.length > longest) longest = key.length;
    }
  }
  longest = Math.min(longest, 12);
}

function entryType(entry: Entry) {
  let type = 0;
  for (const pos of entry.pos) {
    if (pos.startsWith('v1')) type |= V1;
    else if (pos.startsWith('v5')) type |= V5;
    else if (pos === 'adj-i' || pos === 'adj-ix') type |= ADJ;
    else if (pos === 'vk') type |= VK;
    else if (pos === 'vs-i' || pos === 'vs-s') type |= VS;
  }
  return type;
}

/** Best entry for a dictionary-form string, optionally limited to conjugation classes. */
function find(word: string, type = ANY): Entry | undefined {
  const entries = index.get(word);
  if (!entries) return;
  let best: Entry | undefined;
  let bestScore = Infinity;
  for (const entry of entries) {
    if (type !== ANY && !(entryType(entry) & type)) continue;
    // A kana spelling most likely means the word that is normally written in kana.
    const score = entry.written.includes(word) ? 0 : (entry.usuallyKana ? 0 : 2) - (isFunctionWord(entry) ? 1 : 0);
    if (score < bestScore) { best = entry; bestScore = score; }
  }
  return best;
}

function deinflect(surface: string): { entry: Entry; base: string } | undefined {
  let candidates = [{ word: surface, type: ANY }];
  const seen = new Set([surface]);
  for (let depth = 0; depth < 4 && candidates.length; depth++) {
    const next: typeof candidates = [];
    for (const candidate of candidates) {
      const options = [...(rules.get(candidate.word.at(-1)!) || [])];
      // A bare ichidan stem: 食べ, 見.
      if (candidate.type & TERM) options.push({ from: '', to: 'る', as: TERM, base: V1 | VK });
      for (const option of options) {
        if (!(candidate.type & option.as) || !candidate.word.endsWith(option.from) || candidate.word.length <= option.from.length - option.to.length) continue;
        const word = candidate.word.slice(0, candidate.word.length - option.from.length) + option.to;
        if (!word || seen.has(word + option.base)) continue;
        seen.add(word + option.base);
        const entry = option.base === TE ? undefined : find(word, option.base);
        if (entry) return { entry, base: word };
        next.push({ word, type: option.base });
      }
    }
    candidates = next;
  }
}

function surfaceReading(surface: string, base: string, entry: Entry) {
  if (isKana(surface)) return surface;
  if (surface === base) return entry.reading;
  let shared = 0;
  while (shared < surface.length && surface[shared] === base[shared]) shared++;
  const tail = surface.slice(shared);
  const baseTail = base.slice(shared);
  if (base === '来る') return (/^[なよらさ]/.test(tail) ? 'こ' : /^[るれ]/.test(tail) ? 'く' : 'き') + tail;
  return entry.reading.endsWith(baseTail) && isKana(tail || 'あ') ? entry.reading.slice(0, entry.reading.length - baseTail.length) + tail : entry.reading;
}

const matches = new Map<string, Token | null>();
function match(surface: string): Token | undefined {
  const known = matches.get(surface);
  if (known !== undefined) return known || undefined;
  const token = lookUp(surface);
  if (matches.size > 20000) matches.clear();
  matches.set(surface, token || null);
  return token;
}

function lookUp(surface: string): Token | undefined {
  let entry = find(surface);
  let base = surface;
  if (!entry && isHiragana(surface.at(-1)!)) {
    const found = deinflect(surface);
    if (found) ({ entry, base } = found);
  }
  if (!entry) return;
  const kana = isKana(surface);
  const inflected = base !== surface;
  // 今日は is far more often 今日 + は than the greeting, which subtitles spell in kana.
  if (!kana && entry.usuallyKana && (entry.pos[0] === 'int' || entry.pos[0] === 'exp')) return;
  // One stray kana is only ever a particle or an interjection.
  if (kana && surface.length === 1 && (inflected || !(isFunctionWord(entry) || entry.pos[0] === 'int'))) return;
  const confident = !kana || surface.length > 2 || entry.usuallyKana || !entry.written.length;
  const reading = surfaceReading(surface, base, entry);
  return { surface, entry, base, reading, confident, segments: segmentsOf(surface, reading, base, entry) };
}

/** Splits a subtitle line into dictionary words; text with no match is returned as plain tokens. */
export function tokenize(text: string): Token[] {
  const cached = cache.get(text);
  if (cached) return cached;
  const tokens: Token[] = [];
  let plain = '';
  const startsWord = (position: number) => {
    if (position >= text.length || !japanese.test(text[position])) return true;
    for (let length = Math.min(longest, text.length - position); length > 0; length--) if (match(text.slice(position, position + length))) return true;
    return false;
  };
  for (let start = 0; start < text.length;) {
    let found: Token | undefined;
    if (japanese.test(text[start])) {
      // Take the longest word, unless a shorter one lets the rest of the line make sense: 何 + です, not 何で + す.
      let fallback: Token | undefined;
      for (let length = Math.min(longest, text.length - start); length > 0 && !found; length--) {
        const token = match(text.slice(start, start + length));
        if (!token) continue;
        fallback ??= token;
        if (startsWord(start + length)) found = token;
      }
      found ??= fallback;
    }
    if (found) {
      if (plain) { tokens.push({ surface: plain }); plain = ''; }
      tokens.push(found);
      start += found.surface.length;
    } else plain += text[start++];
  }
  if (plain) tokens.push({ surface: plain });
  if (cache.size > 4000) cache.clear();
  cache.set(text, tokens);
  return tokens;
}

const syllables: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa'
};
const glides: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o', ぇ: 'e', ぁ: 'a', ぃ: 'i', ぉ: 'o', ぅ: 'u' };

/** Hepburn-style romaji for a kana reading, for learners who cannot read kana yet. */
export function romaji(kana: string): string {
  const text = kana.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
  let output = '';
  let double = false;
  for (let position = 0; position < text.length; position++) {
    const char = text[position];
    const next = text[position + 1];
    if (char === 'っ') { double = true; continue; }
    if (char === 'ー') { output += output.at(-1) && /[aeiou]/.test(output.at(-1)!) ? output.at(-1) : ''; continue; }
    let syllable = syllables[char];
    if (syllable === undefined) { output += char; double = false; continue; }
    if (next && glides[next] && 'ゃゅょ'.includes(next) && syllable.endsWith('i') && syllable.length > 1) {
      // きゃ → kya, しゃ → sha, ちゃ → cha, じゃ → ja.
      syllable = (/^(sh|ch|j)/.test(syllable) ? syllable.slice(0, -1) : syllable.slice(0, -1) + 'y') + glides[next];
      position++;
    } else if (next && glides[next] && !'ゃゅょ'.includes(next) && /[ufe]/.test(syllable.at(-1)!) && syllable.length > 1) {
      // Loanword sounds: ふぁ → fa, てぃ → ti, うぇ → we.
      syllable = (syllable === 'fu' ? 'f' : syllable.slice(0, -1)) + glides[next];
      position++;
    } else if (char === 'ん' && next && /^[aiueoy]/.test(syllables[next] || '')) syllable = "n'";
    if (double) { syllable = (syllable.startsWith('ch') ? 't' : syllable[0]) + syllable; double = false; }
    output += syllable;
  }
  return output;
}

/** Reading shown under a token: particles は / へ are pronounced wa / e. */
const hasKanji = (text: string) => /[\u3400-\u9fff々]/u.test(text);

/** A dictionary form split into kanji groups and kana, e.g. 食べる → 食(た) べる. */
function baseSegments(written: string, entry: Entry): Segment[] {
  const split = entry.splits?.[written];
  if (split) {
    const chars = [...written];
    let position = 0;
    return split.split(',').map((part) => {
      const [count, reading] = part.split(':');
      const text = chars.slice(position, position += Number(count)).join('');
      return reading ? { text, reading } : { text };
    });
  }
  if (!hasKanji(written)) return [{ text: written }];
  // No recorded split: kana at either end matches the reading, the kanji in between share the rest.
  const lead = written.match(/^[\u3040-\u30ff]*/u)![0];
  const tail = written.match(/[\u3040-\u30ff]*$/u)![0];
  const core = written.slice(lead.length, written.length - tail.length);
  if (!entry.reading.startsWith(lead) || !entry.reading.endsWith(tail) || entry.reading.length <= lead.length + tail.length) return [{ text: written, reading: entry.reading }];
  return [...(lead ? [{ text: lead }] : []), { text: core, reading: entry.reading.slice(lead.length, entry.reading.length - tail.length) }, ...(tail ? [{ text: tail }] : [])];
}

/** Splits a word as it appears in a line; conjugated endings are kana and follow the stem's kanji. */
export function segmentsOf(surface: string, reading: string, base: string, entry: Entry): Segment[] {
  if (!hasKanji(surface)) return [{ text: surface }];
  const parts = baseSegments(entry.written.includes(base) ? base : surface, entry);
  const kept: Segment[] = [];
  let used = 0;
  for (const part of parts) {
    if (!surface.startsWith(part.text, used)) break;
    // A kana part of the dictionary form may be the start of a conjugated ending: let the ending take it.
    if (!part.reading && !hasKanji(surface.slice(used + part.text.length))) break;
    kept.push(part);
    used += part.text.length;
  }
  const rest = surface.slice(used);
  if (hasKanji(rest)) return [{ text: surface, reading }];
  const segments = [...kept, ...(rest ? [{ text: rest }] : [])];
  // Check the readings add up; when a conjugation changes the stem's sound (来る → 来ない), give the kanji what is left.
  const spelled = segments.map((part) => part.reading ?? part.text).join('');
  if (spelled !== reading) {
    const kanji = segments.filter((part) => part.reading);
    const kana = segments.filter((part) => !part.reading).map((part) => part.text).join('');
    if (kanji.length !== 1 || !reading.endsWith(kana) || segments.at(-1)!.reading) return [{ text: surface, reading }];
    kanji[0].reading = reading.slice(0, reading.length - kana.length);
  }
  return segments;
}

/** Segments for a saved word (dictionary form and reading), using the bundled splits when loaded. */
export function spell(word: string, reading: string): Segment[] {
  const entry = index.get(word)?.find((item) => item.reading === reading);
  if (entry) return segmentsOf(word, reading, word, entry);
  return hasKanji(word) ? [{ text: word, reading }] : [{ text: word }];
}

/** Romaji for each segment; a small っ ending one part takes the next part's first consonant: 学校 → gak · kou. */
export function segmentRomaji(segments: Segment[], particle = false): string[] {
  if (particle && segments.length === 1 && (segments[0].text === 'は' || segments[0].text === 'へ')) return [segments[0].text === 'は' ? 'wa' : 'e'];
  const kana = segments.map((part) => part.reading ?? part.text);
  const plain = kana.map((text) => romaji(text.replace(/[っッ]$/u, '')));
  return plain.map((text, index) => {
    const next = plain[index + 1];
    return /[っッ]$/u.test(kana[index]) && next ? text + (next.startsWith('ch') ? 't' : next[0]) : text;
  });
}

export function tokenRomaji(token: Token) {
  if (!token.reading) return '';
  if (token.entry?.pos[0] === 'prt' && token.surface === 'は') return 'wa';
  if (token.entry?.pos[0] === 'prt' && token.surface === 'へ') return 'e';
  return romaji(token.reading);
}
