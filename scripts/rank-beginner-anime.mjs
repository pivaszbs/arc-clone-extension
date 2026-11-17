// Ranks candidate anime on smotret-anime by how hard their Japanese subtitles are for a beginner,
// and writes the beginner list bundled with the extension.
// Usage: node scripts/rank-beginner-anime.mjs [cache-directory]
// Downloads up to three episodes of Japanese subtitles per series, politely, one request at a time.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cacheDir = process.argv[2] || join(process.env.TMPDIR || '/tmp', 'beginner-anime-cache');
await mkdir(cacheDir, { recursive: true });
const SITE = 'https://smotret-anime.com';
const EPISODES = 3;

const compiled = await build({
  stdin: { contents: "export * from './dictionary'; export * from './episode-words'; export { parseCaptionResponse, japaneseCaptions, detectAnimeOpEdIntervals } from './captions';", resolveDir: 'src/japanese', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node'
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
lib.loadDictionary(JSON.parse(await readFile('src/japanese/dictionary-data.json', 'utf8')).entries);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(SITE + path, { headers: { 'user-agent': 'anime-study-ranker' } });
    if (response.ok) return (await response.json()).data;
    await pause(2000 * (attempt + 1));
  }
  throw new Error(`Request failed: ${path}`);
}
async function subtitle(id) {
  const file = join(cacheDir, `${id}.ass`);
  try { return await readFile(file, 'utf8'); } catch { /* Not cached yet. */ }
  await pause(600);
  const response = await fetch(`${SITE}/translations/ass/${id}?download=1`, { headers: { 'user-agent': 'anime-study-ranker' } });
  if (!response.ok) return '';
  const body = await response.text();
  await writeFile(file, body);
  return body;
}

const MIN_EPISODES = 6;
/** How many of the easiest series are bundled with the extension. */
const LIST_SIZE = 40;
const genreNames = {
  'Повседневность': 'Slice of life', 'Комедия': 'Comedy', 'Романтика': 'Romance', 'Школа': 'School', 'Драма': 'Drama', 'Фэнтези': 'Fantasy',
  'Приключения': 'Adventure', 'Экшен': 'Action', 'Детское': 'Kids', 'Ияшикей': 'Healing', 'Музыка': 'Music', 'Спорт': 'Sports',
  'Фантастика': 'Sci-fi', 'Мистика': 'Mystery', 'Детектив': 'Detective', 'Гурман': 'Food', 'Работа': 'Work', 'Сёнэн': 'Shounen',
  'Сёдзё': 'Shoujo', 'Сэйнэн': 'Seinen', 'Дзёсей': 'Josei', 'Сверхъестественное': 'Supernatural', 'Исэкай': 'Isekai', 'Пародия': 'Parody',
  'Магия': 'Magic', 'Исторический': 'Historical', 'Психологическое': 'Psychological', 'Триллер': 'Thriller', 'Меха': 'Mecha', 'Самураи': 'Samurai',
  'Антропоморфизм': 'Animals', 'CGDCT': 'Cute girls', 'Идолы': 'Idols', 'Космос': 'Space', 'Военное': 'Military', 'Игры': 'Games'
};
// Not shown to learners however easy their dialogue is.
const excludedGenres = new Set(['Хентай', 'Эччи', 'Яой', 'Юри', 'Ужасы']);

/** Every series with Japanese subtitles on at least MIN_EPISODES episodes. */
async function subtitledSeries() {
  const episodes = new Map();
  for (let offset = 0; ; offset += 1000) {
    const page = await json(`/api/translations?type=subJa&limit=1000&offset=${offset}&fields=seriesId,episodeId,isActive`);
    for (const item of page) if (item.isActive) (episodes.get(item.seriesId) || episodes.set(item.seriesId, new Set()).get(item.seriesId)).add(item.episodeId);
    if (page.length < 1000) break;
    await pause(400);
  }
  return [...episodes].filter(([, set]) => set.size >= MIN_EPISODES).map(([id]) => id);
}

/** First few episodes that have Japanese subtitles, one subtitle file per episode. */
async function japaneseEpisodes(series) {
  const translations = await json(`/api/translations?type=subJa&seriesId=${series.id}&limit=200`);
  const byEpisode = new Map();
  for (const translation of translations.filter((item) => item.isActive)) {
    const existing = byEpisode.get(translation.episodeId);
    if (!existing || translation.priority > existing.priority) byEpisode.set(translation.episodeId, translation);
  }
  const order = new Map((series.episodes || []).map((episode, index) => [episode.id, index]));
  return { count: byEpisode.size, sample: [...byEpisode.values()].sort((a, b) => (order.get(a.episodeId) ?? 1e9) - (order.get(b.episodeId) ?? 1e9)).slice(0, EPISODES) };
}

const results = [];
const ids = await subtitledSeries();
console.log(`${ids.length} series with Japanese subtitles on ${MIN_EPISODES}+ episodes`);
for (const id of ids) {
  try {
    await pause(300);
    const series = await json(`/api/series/${id}`);
    const genres = (series.genres || []).map((genre) => genre.title);
    const title = series.titles?.romaji || series.title;
    if (series.isHentai || genres.some((genre) => excludedGenres.has(genre))) { console.log(`- ${title}: excluded genre`); continue; }
    // Chinese shows with Japanese subtitles: the audio is not Japanese, so they are no use for listening.
    if (!/[\u3040-\u30ff]/u.test(series.titles?.ja || 'か') && /zh|x|q|ong|ian|iao|uan/i.test(series.titles?.romaji || '')) { console.log(`- ${title}: not Japanese audio`); continue; }
    const { count, sample } = await japaneseEpisodes(series);
    const cues = [];
    let minutes = 0;
    for (const translation of sample) {
      const body = await subtitle(translation.id);
      const parsed = lib.parseCaptionResponse(body).filter((cue) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(cue.text) && cue.end - cue.start < 15);
      if (!lib.japaneseCaptions(parsed)) continue;
      // Drop song lyrics: openings and endings are not everyday speech.
      const segments = lib.detectAnimeOpEdIntervals(body, parsed, translation.duration || 0);
      const speech = parsed.filter((cue) => !['op', 'ed'].some((part) => segments[part] && cue.start >= segments[part].start && cue.end <= segments[part].end));
      cues.push(...speech);
      minutes += (translation.duration || (parsed.at(-1)?.end ?? 0)) / 60;
    }
    if (cues.length < 100 || minutes < 10) { console.log(`- ${title}: too little readable dialogue`); continue; }
    results.push({ title, genres, series, count, cues, minutes, first: sample[0]?.url });
    console.log(`✓ ${title}: ${count} episodes, ${cues.length} lines sampled`);
  } catch (error) { console.log(`- ${id}: ${error.message}`); }
}

// Shared anime vocabulary: how often each word appears across every sampled series.
const corpus = new Map();
const analysed = results.map((result) => {
  const episode = lib.analyseEpisode(result.cues);
  for (const word of episode.words.values()) corpus.set(word.id, (corpus.get(word.id) || 0) + word.count);
  return { ...result, episode };
});
const core = new Set([...corpus].sort((a, b) => b[1] - a[1]).slice(0, 1500).map(([id]) => id));

function spokenSeconds(cues) {
  let total = 0;
  let until = 0;
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const start = Math.max(cue.start, until);
    if (cue.end > start) total += cue.end - start;
    until = Math.max(until, cue.end);
  }
  return Math.max(total, 60);
}

const scored = analysed.map(({ title, genres, series, count, cues, minutes, episode, first }) => {
  let plain = 0;
  let japanese = 0;
  for (const cue of cues) for (const token of lib.tokenize(cue.text)) {
    const chars = (token.surface.match(/[぀-ヿ㐀-鿿]/gu) || []).length;
    japanese += chars;
    if (!token.entry) plain += chars;
  }
  const words = [...episode.words.values()].sort((a, b) => b.count - a.count);
  // Distinct words needed to follow 90% of what is said: the smaller, the sooner Learn pays off.
  let covered = 0;
  let needed = 0;
  for (const word of words) { if (covered >= episode.total * 0.9) break; covered += word.count; needed++; }
  let coreTokens = 0;
  for (const word of words) if (core.has(word.id)) coreTokens += word.count;
  return {
    id: series.id,
    title: series.titles?.romaji || title,
    titleJa: series.titles?.ja || '',
    titleEn: series.titles?.en || '',
    url: `${SITE}/catalog/${series.url.split('/catalog/')[1] || ''}`.replace(/\/$/, ''),
    type: series.type,
    poster: series.posterUrlSmall || series.posterUrl || '',
    year: series.year,
    episodes: series.numberOfEpisodes,
    japaneseEpisodes: count,
    genres: genres.map((genre) => genreNames[genre]).filter(Boolean).slice(0, 4),
    firstEpisode: first ? SITE + new URL(first).pathname : '',
    topWords: words.slice(0, 50).map((word) => word.id),
    // Pace while someone is talking: quiet fight scenes must not make a series look slow.
    wordsPerMinute: Math.round(episode.total / (spokenSeconds(cues) / 60)),
    wordsFor90: Math.round(needed / (minutes / 24)),
    coreShare: episode.total ? coreTokens / episode.total : 0,
    unknownShare: japanese ? plain / japanese : 0
  };
});

// Lower is easier on every measure except core vocabulary; average the ranks.
const rank = (key, descending = false) => {
  const order = [...scored].sort((a, b) => descending ? b[key] - a[key] : a[key] - b[key]);
  return new Map(order.map((item, index) => [item.id, index / Math.max(1, order.length - 1)]));
};
const ranks = [rank('wordsPerMinute'), rank('wordsFor90'), rank('coreShare', true), rank('unknownShare')];
const weights = [0.3, 0.35, 0.2, 0.15];
for (const item of scored) item.difficulty = Math.round(100 * ranks.reduce((sum, ranks, index) => sum + weights[index] * ranks.get(item.id), 0));
scored.sort((a, b) => a.difficulty - b.difficulty);

const output = scored.slice(0, LIST_SIZE).map(({ coreShare, unknownShare, ...item }) => ({ ...item, coreShare: Math.round(coreShare * 100), unknownShare: Math.round(unknownShare * 100) }));
await writeFile('src/japanese/beginner-anime.json', JSON.stringify({ generated: new Date().toISOString().slice(0, 10), sampleEpisodes: EPISODES, ranked: scored.length, series: output }, null, 1) + '\n');
console.table(scored.map(({ title, difficulty, wordsPerMinute, wordsFor90, coreShare, unknownShare, japaneseEpisodes }) => ({ title, difficulty, wordsPerMinute, wordsFor90, coreShare, unknownShare, japaneseEpisodes })));
