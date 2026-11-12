import { createStudyStore } from '../storage';
import { subtitleUrl } from '../captions';
import { safariApi } from './api';
const api = safariApi();
const store = createStudyStore(api.storage.local);
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handle(message).then(sendResponse, (error) => sendResponse({ error: error instanceof Error ? error.message : 'Request failed.' }));
  return true;
});
async function handle(message: { type: string; [key: string]: any }) {
  if (message.type === 'JAPANESE_FETCH_CAPTIONS') {
    const url = String(message.url || '');
    if (!subtitleUrl(url)) throw new Error('Unsupported subtitle source.');
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 5000000) throw new Error('Subtitle source unavailable.');
    const body = await response.text();
    if (body.length > 5000000) throw new Error('Subtitle source too large.');
    return { body };
  }
  if (message.type === 'TRANSLATE_TEXT') {
    const text = String(message.text || '').trim();
    if (!text || text.length > 5000) throw new Error('Choose a shorter Japanese phrase.');
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({ client: 'gtx', sl: 'ja', tl: 'en', dt: 't', q: text }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Translation unavailable.');
    const data = await response.json();
    const translatedText = Array.isArray(data?.[0]) ? data[0].filter((part: unknown) => Array.isArray(part) && typeof part[0] === 'string').map((part: string[]) => part[0]).join('') : '';
    if (!translatedText) throw new Error('Translation unavailable.');
    return { translatedText };
  }
  if (message.type?.startsWith('JAPANESE_')) return store(message);
  throw new Error('Unsupported extension request.');
}
