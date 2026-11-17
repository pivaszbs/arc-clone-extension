// Prunes jmdict-simplified's "common words" JSON into the compact table bundled with the study player.
// Usage: node scripts/build-dictionary.mjs path/to/jmdict-eng-common-x.y.z.json path/to/JmdictFurigana.json
// Sources: https://github.com/scriptin/jmdict-simplified (JMdict, EDRDG, CC BY-SA 4.0) and
// https://github.com/Doublevil/JmdictFurigana (which kana of a reading belong to which kanji, CC BY-SA 4.0).
import { readFile, writeFile } from 'node:fs/promises';

const input = process.argv[2];
if (!input) throw new Error('Pass the path to jmdict-eng-common-*.json');
const source = JSON.parse(await readFile(input, 'utf8'));
// "泥棒\tどろぼう" → "1:どろ,1:ぼう": each part is a character count, with the reading when the part has kanji.
const splits = new Map();
if (process.argv[3]) {
  for (const item of JSON.parse((await readFile(process.argv[3], 'utf8')).replace(/^\uFEFF/, ''))) {
    const parts = item.furigana.map((part) => [...part.ruby].length + (part.rt ? ':' + part.rt : ''));
    // A single group covering the whole word is what the app assumes anyway.
    if (parts.length > 1) splits.set(item.text + '\t' + item.reading, parts.join(','));
  }
}
const clean = (text) => text.replace(/[\t\n|]/g, ' ').trim();

const lines = [];
for (const word of source.words) {
  const kana = word.kana.filter((item) => !item.tags.includes('sk'));
  const reading = (kana.find((item) => item.common) || kana[0])?.text;
  if (!reading) continue;
  const kanji = word.kanji.filter((item) => !item.tags.includes('sK') && !item.tags.includes('rK') && !item.tags.includes('iK'));
  const written = [...kanji.filter((item) => item.common), ...kanji.filter((item) => !item.common)].map((item) => item.text).slice(0, 4);
  const senses = word.sense.filter((sense) => sense.gloss.length);
  if (!senses.length) continue;
  const pos = [...new Set(senses.flatMap((sense) => sense.partOfSpeech))];
  // "Usually written in kana": prefer this entry when subtitles spell the word in kana.
  const usuallyKana = !written.length || senses[0].misc.includes('uk');
  const glosses = [];
  for (const sense of senses.slice(0, 2)) {
    for (const gloss of sense.gloss.slice(0, glosses.length ? 1 : 3)) {
      const text = clean(gloss.text);
      if (text && !glosses.includes(text) && glosses.join('; ').length + text.length <= 70) glosses.push(text);
    }
  }
  if (!glosses.length) glosses.push(clean(senses[0].gloss[0].text).slice(0, 70));
  const spelled = written.map((text) => splits.has(text + '\t' + reading) ? `${text}~${splits.get(text + '\t' + reading)}` : text);
  lines.push([spelled.join('|'), reading, pos.join(',') + (usuallyKana ? ',uk' : ''), glosses.join('; ')].join('\t'));
}

const output = new URL('../src/japanese/dictionary-data.json', import.meta.url);
await writeFile(output, JSON.stringify({ version: source.version, date: source.dictDate, entries: lines.join('\n') }));
console.log(`${lines.length} entries, ${(JSON.stringify(lines.join('\n')).length / 1e6).toFixed(2)} MB`);
