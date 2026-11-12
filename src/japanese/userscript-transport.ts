import { schedule, type Card } from './study';
import { QUIZ_KEY, defaultQuizSettings, type QuizSettings } from './quiz';
import { subtitleUrl } from './captions';

export type UserscriptApi = {
  getValue<T>(key: string, fallback?: T): Promise<T>;
  setValue(key: string, value: unknown): Promise<void>;
  listValues(): Promise<string[]>;
  xmlHttpRequest(details: { url: string; method: string; timeout: number; responseType: string }): Promise<{ status: number; responseText: string }>;
};
const PREFIX = 'arc_japanese_card:';
export function createUserscriptTransport(gm: UserscriptApi) {
  let queue: Promise<unknown> = Promise.resolve();
  const list = async () => {
    const keys = (await gm.listValues()).filter((key) => key.startsWith(PREFIX));
    const cards = await Promise.all(keys.map((key) => gm.getValue<Card | null>(key, null)));
    return cards.filter((card): card is Card => card !== null);
  };
  return (message: { type: string; [key: string]: unknown }) => {
    const operation = queue.catch(() => {}).then(async () => {
      if (message.type === 'JAPANESE_FETCH_CAPTIONS') {
        const url = String(message.url || '');
        if (!subtitleUrl(url)) throw new Error('Unsupported subtitle source.');
        const response = await gm.xmlHttpRequest({ url, method: 'GET', timeout: 15000, responseType: 'text' });
        if (response.status !== 200 || response.responseText.length > 5000000) throw new Error('Subtitle source unavailable.');
        return { body: response.responseText };
      }
      if (message.type === 'TRANSLATE_TEXT') {
        const text = String(message.text || '').trim();
        if (!text || text.length > 5000) throw new Error('Choose a phrase shorter than 5,000 characters.');
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.search = new URLSearchParams({ client: 'gtx', sl: 'ja', tl: 'en', dt: 't', q: text }).toString();
        const response = await gm.xmlHttpRequest({ url: url.href, method: 'GET', timeout: 15000, responseType: 'text' });
        if (response.status !== 200) throw new Error('Translation unavailable.');
        const data = JSON.parse(response.responseText);
        const translatedText = Array.isArray(data?.[0]) ? data[0].filter((part: unknown) => Array.isArray(part) && typeof part[0] === 'string').map((part: string[]) => part[0]).join('') : '';
        if (!translatedText) throw new Error('Translation unavailable.');
        return { translatedText };
      }
      let settings = await gm.getValue<QuizSettings>(QUIZ_KEY, { ...defaultQuizSettings });
      let cards = await list();
      if (message.type === 'JAPANESE_SAVE') {
        const card = message.card as Card;
        if (!card || typeof card.text !== 'string' || !card.text.trim() || card.text.length > 5000 || typeof card.meaning !== 'string' || !Number.isFinite(card.start) || !Number.isFinite(card.end) || card.start < 0 || card.end <= card.start || !/^https?:\/\//.test(card.url)) throw new Error('Check the phrase and video time.');
        if (cards.some((saved) => saved.text === card.text && saved.url === card.url)) throw new Error('This phrase is already saved from this page.');
        if (cards.length >= 2000) throw new Error('Export your phrases before adding more than 2,000.');
        const saved = { ...card, id: crypto.randomUUID(), interval: 0, due: Date.now() };
        // One record per card keeps simultaneous saves in different player frames separate.
        await gm.setValue(PREFIX + saved.id, saved);
        cards = [...cards, saved];
      } else if (message.type === 'JAPANESE_GRADE') {
        const card = cards.find((item) => item.id === message.id);
        if (!card) throw new Error('Saved phrase not found.');
        const updated = schedule(card, message.remembered === true);
        await gm.setValue(PREFIX + card.id, updated);
        cards = cards.map((item) => item.id === card.id ? updated : item);
      } else if (message.type === 'JAPANESE_QUIZ_SETTINGS') {
        const next = message.settings as QuizSettings;
        if (!next || !Number.isFinite(next.chance) || next.chance < 0 || next.chance > 1) throw new Error('Check your quiz frequency.');
        settings = { chance: next.chance };
        await gm.setValue(QUIZ_KEY, settings);
      } else if (message.type !== 'JAPANESE_LIST') throw new Error('Unsupported study request.');
      return { cards, settings };
    });
    queue = operation;
    return operation;
  };
}
