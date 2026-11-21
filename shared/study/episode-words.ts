// Chooses which words to teach from the episode being watched, and when to stop for them.
import { isFunctionWord, tokenize, type Entry, type Token } from './dictionary';
import type { Cue } from './study';
import { isKnown, isLearning, type WordCard } from './word-cards';

export type EpisodeWord = { id: string; entry: Entry; word: string; count: number; first: Cue };
export type EpisodeWords = { words: Map<string, EpisodeWord>; total: number };
export type WordStop = { id: string; index: number; action: 'teach' | 'quiz' };

/** The spelling the subtitles use is kept, so a word normally written in kana stays in kana. */
export const wordId = (entry: Entry) => `${entry.usuallyKana || !entry.written.length ? entry.reading : entry.written[0]}|${entry.reading}`;
export const wordText = (entry: Entry) => entry.usuallyKana || !entry.written.length ? entry.reading : entry.written[0];
/** Words worth learning: real vocabulary the lookup is sure about, not particles or stray kana. */
export const learnable = (token: Token) => !!token.entry && token.confident !== false && !isFunctionWord(token.entry);

export function analyseEpisode(cues: Cue[]): EpisodeWords {
  const words = new Map<string, EpisodeWord>();
  let total = 0;
  for (const cue of cues) {
    for (const token of tokenize(cue.text)) {
      if (!learnable(token)) continue;
      total++;
      const id = wordId(token.entry!);
      const word = words.get(id);
      if (word) word.count++;
      else words.set(id, { id, entry: token.entry!, word: wordText(token.entry!), count: 1, first: cue });
    }
  }
  return { words, total };
}

/** Share of the episode's running words the learner already knows. */
export function coverage(episode: EpisodeWords, cards: Map<string, WordCard>) {
  let known = 0;
  let knownWords = 0;
  for (const word of episode.words.values()) {
    if (isKnown(cards.get(word.id))) { known += word.count; knownWords++; }
  }
  return { knownWords, words: episode.words.size, share: episode.total ? known / episode.total : 0 };
}

/**
 * Words in play for this episode: everything still being learned that appears in it, topped up
 * with the episode's most frequent unseen words until `limit` are in play.
 */
export function episodeTargets(episode: EpisodeWords, cards: Map<string, WordCard>, limit: number) {
  const byCount = [...episode.words.values()].sort((a, b) => b.count - a.count);
  const learning = byCount.filter((word) => isLearning(cards.get(word.id)));
  // A word heard once cannot be practised again in this episode.
  const fresh = byCount.filter((word) => !cards.has(word.id) && word.count >= 2).slice(0, Math.max(0, limit - learning.length));
  return { learning, fresh };
}

export type DeckCard = EpisodeWord & { phrase: boolean };

/**
 * Everything in an episode worth learning before watching it: its words and set phrases (JMdict
 * expressions), the ones heard most first and then in the order they come up, without those
 * already known. Words still being learned stay in, so the deck doubles as their review.
 */
export function episodeDeck(episode: EpisodeWords, cards: Map<string, WordCard>): DeckCard[] {
  return [...episode.words.values()]
    .filter((word) => !isKnown(cards.get(word.id)))
    .sort((a, b) => b.count - a.count || a.first.start - b.first.start)
    .map((word) => ({ ...word, phrase: word.entry.pos.includes('exp') }));
}

/** The word to stop for on a line that has just finished, if any. */
export function wordStop(tokens: Token[], cards: Map<string, WordCard>, fresh: (id: string) => boolean, now = Date.now()): WordStop | null {
  let teach: WordStop | null = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!learnable(token)) continue;
    const id = wordId(token.entry!);
    const card = cards.get(id);
    if (card) {
      // Due words are asked in context whether they are new or already on day-based reviews.
      if (!card.known && card.due <= now) return { id, index, action: 'quiz' };
    } else if (!teach && fresh(id)) teach = { id, index, action: 'teach' };
  }
  return teach;
}

/** Four meanings to choose from; wrong answers come from other words in the same episode first. */
export function wordChoices(correct: string, pool: string[], random = Math.random): string[] {
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    return items;
  };
  const others = shuffle([...new Set(pool)].filter((gloss) => gloss && gloss !== correct)).slice(0, 3);
  return shuffle([correct, ...others]);
}
