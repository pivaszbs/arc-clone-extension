import { type Card, type Cue, hasJapanese } from './study';

export type QuizSettings = { chance: number };
export const QUIZ_KEY = 'arc_japanese_quiz_v1';
export const defaultQuizSettings: QuizSettings = { chance: 0.25 };
export type ListeningCue = Cue & { estimated?: boolean };
export type Challenge = { cue: ListeningCue; kind: 'known' | 'stretch'; unknown: string[]; meaning: string; cardId?: string };
export const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
export function words(text: string): string[] {
  return [...new Set(Array.from(segmenter.segment(text)).filter((part) => part.isWordLike).map((part) => normalize(part.segment)).filter(Boolean))];
}
export function knowledge(cards: Card[]) {
  const remembered = cards.filter((card) => card.interval > 0);
  const phrases = remembered.map((card) => card.text);
  return { phrases: new Set(phrases.map(normalize)), words: new Set(phrases.flatMap(words)), remembered, cards };
}
export function classify(cue: ListeningCue, known: ReturnType<typeof knowledge>, now = Date.now()): Challenge | null {
  if (!hasJapanese(cue.text)) return null;
  const tokens = words(cue.text);
  if (!tokens.length) return null;
  const unknown = tokens.filter((token) => !known.words.has(token));
  const card = known.cards.find((card) => normalize(card.text) === normalize(cue.text));
  if (card && card.due > now) return null;
  if (card) return { cue, kind: 'known', unknown, meaning: card.meaning, cardId: card.id };
  if (known.phrases.has(normalize(cue.text)) || !unknown.length) return { cue, kind: 'known', unknown: [], meaning: '' };
  if (unknown.length <= 2) return { cue, kind: 'stretch', unknown, meaning: '' };
  return null;
}

const distractors = ['I do not understand.', 'What is that?', 'Please speak slowly.', 'Where is the station?', 'I am hungry.', 'Thank you very much.', 'I will go tomorrow.', 'This is delicious.', 'It is raining today.', 'How much does it cost?', 'Please say that again.', 'I like this book.'];
export function choices(correct: string, cards: Card[], random = Math.random): string[] {
  const unique = [...new Map([...cards.map((card) => card.meaning), ...distractors].filter((text) => text.trim() && normalize(text) !== normalize(correct)).map((text) => [normalize(text), text])).values()];
  const shuffle = <T>(items: T[]) => { for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; } return items; };
  return shuffle([correct, ...shuffle(unique).slice(0, 3)]);
}

// Keeps each sampling decision stable as a subtitle stays on screen.
export class ListeningQuiz {
  private pending: Challenge | null = null;
  private activeKey = '';
  private seen = new Set<string>();
  private lastTime: number | null = null;
  private lastStretch = -Infinity;
  reset() { this.pending = null; this.activeKey = ''; this.lastTime = null; }
  private key(cue: ListeningCue) { return `${normalize(cue.text)}:${cue.estimated ? '' : cue.start}`; }
  observe(cue: ListeningCue | null, time: number, playing: boolean, known: ReturnType<typeof knowledge>, chance: number, random = Math.random): Challenge | null {
    if (!playing) return null;
    if (this.lastTime !== null && Math.abs(time - this.lastTime) > 1.5) this.reset();
    this.lastTime = time;
    const key = cue ? this.key(cue) : '';
    const pending = this.pending;
    // With DOM captions, the first changed/cleared caption is the available end signal.
    if (pending && (pending.cue.estimated ? key !== this.activeKey : time >= pending.cue.end)) {
      this.pending = null;
      if (pending.cue.estimated) pending.cue.end = time;
      if (pending.kind === 'stretch') this.lastStretch = time;
      return pending;
    }
    if (key !== this.activeKey) {
      this.activeKey = key;
      this.pending = null;
      if (cue) {
        const seenKey = `${key}:${cue.estimated ? Math.floor(time / 15) : ''}`;
        if (!this.seen.has(seenKey)) {
          this.seen.add(seenKey);
          if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
          const candidate = classify(cue, known);
          if (candidate && (candidate.kind === 'known' || (time - this.lastStretch >= 30 && random() < chance))) {
            if (cue.estimated) candidate.cue = { ...cue, start: Math.max(0, time - 0.2) };
            this.pending = candidate;
          }
        }
      }
    }
    return null;
  }
}
