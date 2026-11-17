// Progress for single words. Kept free of the dictionary so the background worker stays small.

export type WordExample = { text: string; url: string; title: string; start: number; end: number };
export type WordCard = {
  /** Dictionary form and reading, e.g. "友達|ともだち". */
  id: string;
  word: string;
  reading: string;
  gloss: string;
  /** Correct answers in a row while the word is still new. */
  step: number;
  /** Days until the next review once the word has stuck; 0 while it is being learned. */
  interval: number;
  due: number;
  /** Set when the learner says they already know the word. */
  known?: boolean;
  example?: WordExample;
};
export type WordMessage = { type: string; word?: Partial<WordCard>; id?: string; remembered?: boolean };
export const WORDS_KEY = 'arc_japanese_words_v1';
export const WORD_LIMIT = 5000;
const minute = 60000;
const day = 86400000;

/** A word counts as known once it has survived its first day, or the learner marked it. */
export const isKnown = (card: WordCard | undefined) => !!card && (card.known === true || card.interval >= 1);
export const isLearning = (card: WordCard | undefined) => !!card && !isKnown(card);

/**
 * New words are asked again within the same episode: a miss returns after a minute, a first
 * correct answer after ten, and the second one moves the word to day-based reviews.
 */
export function scheduleWord(card: WordCard, remembered: boolean, now = Date.now()): WordCard {
  if (!remembered) return { ...card, step: 0, interval: 0, due: now + minute };
  if (card.interval === 0 && card.step < 1) return { ...card, step: card.step + 1, due: now + 10 * minute };
  const interval = Math.min(60, card.interval ? card.interval * 2 : 1);
  return { ...card, step: 0, interval, due: now + interval * day };
}

const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

/** Applies a word request to the saved list. Returns null when the message is not about words. */
export function applyWordMessage(words: WordCard[], message: WordMessage, now = Date.now()): WordCard[] | null {
  if (message.type === 'JAPANESE_WORD_SAVE') {
    const word = message.word;
    if (!word || !text(word.id, 200) || !text(word.word, 100) || !text(word.reading, 100) || !text(word.gloss, 300)) throw new Error('Check the word.');
    const example = word.example && text(word.example.text, 5000) && Number.isFinite(word.example.start) && Number.isFinite(word.example.end)
      ? { text: word.example.text, url: String(word.example.url || ''), title: String(word.example.title || ''), start: word.example.start, end: word.example.end }
      : undefined;
    const existing = words.find((item) => item.id === word.id);
    if (existing) {
      return words.map((item) => item !== existing ? item : {
        ...item,
        ...(typeof word.known === 'boolean' ? { known: word.known, ...(word.known ? {} : { step: 0, interval: 0, due: now }) } : {}),
        example: item.example || example
      });
    }
    if (words.length >= WORD_LIMIT) throw new Error('Your word list is full.');
    return [...words, { id: word.id!, word: word.word!, reading: word.reading!, gloss: word.gloss!, step: 0, interval: 0, due: now, ...(word.known === true ? { known: true } : {}), ...(example ? { example } : {}) }];
  }
  if (message.type === 'JAPANESE_WORD_GRADE') {
    if (!words.some((item) => item.id === message.id)) throw new Error('Saved word not found.');
    return words.map((item) => item.id === message.id ? scheduleWord(item, message.remembered === true, now) : item);
  }
  return null;
}
