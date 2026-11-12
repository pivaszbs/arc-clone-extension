export type Cue = { start: number; end: number; text: string };
export type Card = Cue & { id: string; meaning: string; url: string; title: string; due: number; interval: number };
export const STUDY_KEY = 'arc_japanese_cards_v1';
export const hasJapanese = (text: string) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(text);
export function supportedSite(host: string) {
  return ['youtube.com', 'smotret-anime.com', 'smotret-anime.net'].some((domain) => host === domain || host.endsWith('.' + domain));
}
export function parseSubtitles(input: string): Cue[] {
  const stamp = '(?:(\\d{1,2}):)?(\\d{2}):(\\d{2})[.,](\\d{3})';
  const timing = new RegExp('^' + stamp + '\\s+-->\\s+' + stamp);
  const seconds = (parts: string[]) => Number(parts[0] || 0) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / 1000;
  return input.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => timing.test(line));
    if (index < 0) return [];
    const match = lines[index].match(timing)!;
    const start = seconds(match.slice(1, 5));
    const end = seconds(match.slice(5, 9));
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
    return text && Number.isFinite(start) && end > start ? [{ start, end, text }] : [];
  }).sort((a, b) => a.start - b.start);
}
export function schedule(card: Card, remembered: boolean, now = Date.now()): Card {
  const interval = remembered ? Math.min(30, card.interval ? card.interval * 2 : 1) : 0;
  return { ...card, interval, due: now + (remembered ? interval * 86400000 : 600000) };
}
export function sourceUrl(url: string, start: number) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return '';
    if (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) parsed.searchParams.set('t', String(Math.floor(start)));
    return parsed.href;
  } catch { return ''; }
}
