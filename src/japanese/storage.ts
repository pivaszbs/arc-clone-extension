import { STUDY_KEY, schedule, type Card } from './study';
import { QUIZ_KEY, cleanQuizSettings, defaultQuizSettings, type QuizSettings } from './quiz';
import { WORDS_KEY, applyWordMessage, type WordCard } from './word-cards';
type StudyMessage = { type: string; card?: Card; word?: Partial<WordCard>; id?: string; remembered?: boolean; settings?: QuizSettings };
type StudyStorage = { get(keys: string[]): Promise<Record<string, any>>; set(values: Record<string, unknown>): Promise<void> };
export function createStudyStore(storage: StudyStorage) {
let queue: Promise<unknown> = Promise.resolve();
return function studyRequest(message: StudyMessage) {
  const operation = queue.catch(() => {}).then(async () => {
    const stored = await storage.get([STUDY_KEY, QUIZ_KEY, WORDS_KEY]);
    let cards: Card[] = stored[STUDY_KEY] || [];
    let settings: QuizSettings = stored[QUIZ_KEY] || { ...defaultQuizSettings };
    let words: WordCard[] = stored[WORDS_KEY] || [];
    const nextWords = applyWordMessage(words, message);
    if (nextWords) {
      words = nextWords;
      await storage.set({ [WORDS_KEY]: words });
      return { cards, settings, words };
    }
    if (message.type === 'JAPANESE_SAVE') {
      const card = message.card;
      if (!card || typeof card.text !== 'string' || !card.text.trim() || card.text.length > 5000 || typeof card.meaning !== 'string' || !Number.isFinite(card.start) || !Number.isFinite(card.end) || card.start < 0 || card.end <= card.start || !/^(?:https?:\/\/|arc-offline:[^/]+\/\d+\/\d+$)/.test(card.url)) throw new Error('Check the phrase and video time.');
      if (cards.length >= 2000) throw new Error('Export your phrases before adding more than 2,000.');
      if (cards.some((c) => c.text === card.text && c.url === card.url)) throw new Error('This phrase is already saved from this page.');
      cards = [...cards, { ...card, id: crypto.randomUUID(), due: Date.now(), interval: 0 }];
    } else if (message.type === 'JAPANESE_GRADE') {
      cards = cards.map((c) => c.id === message.id ? schedule(c, message.remembered === true) : c);
    } else if (message.type === 'JAPANESE_QUIZ_SETTINGS') {
      const next = cleanQuizSettings(message.settings);
      if (!next) throw new Error('Check your quiz settings.');
      settings = next;
      await storage.set({ [QUIZ_KEY]: settings });
    } else if (message.type !== 'JAPANESE_LIST') throw new Error('Unknown study action.');
    if (message.type === 'JAPANESE_SAVE' || message.type === 'JAPANESE_GRADE') await storage.set({ [STUDY_KEY]: cards });
    return { cards, settings, words };
  });
  queue = operation;
  return operation;
}
}
let defaultStore: ReturnType<typeof createStudyStore> | undefined;
export function studyRequest(message: StudyMessage) {
  defaultStore ??= createStudyStore(chrome.storage.local);
  return defaultStore(message);
}
