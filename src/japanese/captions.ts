import { parseSubtitles, type Cue } from './study';

export function subtitleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return false;
    const language = url.searchParams.get('lang') || url.searchParams.get('language') || '';
    if (language && !/^ja(?:[-_]|$)/i.test(language)) return false;
    if (url.searchParams.has('tlang')) return false;
    return /\.(vtt|srt|ass|ssa|ttml|dfxp)(?:$|\/)/i.test(url.pathname) || (/^(?:www\.)?youtube\.com$/.test(url.hostname) && url.pathname === '/api/timedtext' && /^ja(?:[-_]|$)/i.test(language));
  } catch { return false; }
}

const clean = (text: string) => text.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const valid = (cue: Cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && !!cue.text;
function timestamp(value: string) {
  if (/^[\d.]+s$/.test(value)) return parseFloat(value);
  if (/^[\d.]+ms$/.test(value)) return parseFloat(value) / 1000;
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}
export function parseCaptionResponse(body: string): Cue[] {
  if (body.length > 5000000) return [];
  const basic = parseSubtitles(body);
  if (basic.length) return basic;
  try {
    const data = JSON.parse(body);
    if (Array.isArray(data.events)) return data.events.flatMap((event: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }) => {
      if (!Array.isArray(event.segs) || typeof event.tStartMs !== 'number' || typeof event.dDurationMs !== 'number') return [];
      const cue = { start: event.tStartMs / 1000, end: (event.tStartMs + event.dDurationMs) / 1000, text: clean(event.segs.map((part) => part.utf8 || '').join('')) };
      return valid(cue) ? [cue] : [];
    });
  } catch { /* Other supported caption formats are text. */ }
  if (/\[Events\]/i.test(body)) {
    let fields: string[] = [];
    return body.split(/\r?\n/).flatMap((line) => {
      if (line.startsWith('Format:')) { fields = line.slice(7).split(',').map((field) => field.trim().toLowerCase()); return []; }
      if (!line.startsWith('Dialogue:') || !['text', 'start', 'end'].every((field) => fields.includes(field))) return [];
      const parts = line.slice(9).split(',');
      const cue = { start: timestamp(parts[fields.indexOf('start')] || ''), end: timestamp(parts[fields.indexOf('end')] || ''), text: clean(parts.slice(fields.indexOf('text')).join(',').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')) };
      return valid(cue) ? [cue] : [];
    });
  }
  // YouTube XML and TTML use timed text elements. Never insert their markup into the page.
  const cues: Cue[] = [];
  for (const match of body.matchAll(/<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attributes = Object.fromEntries(Array.from(match[2].matchAll(/([\w:]+)=["']([^"']*)["']/g), (part) => [part[1], part[2]]));
    const start = timestamp(attributes.start || attributes.begin || '');
    const end = attributes.end ? timestamp(attributes.end) : start + timestamp(attributes.dur || '');
    const cue = { start, end, text: clean(match[3].replace(/<br\s*\/?\s*>/g, '\n')) };
    if (valid(cue)) cues.push(cue);
  }
  return cues;
}

export function japaneseCaptions(cues: Cue[], declaredJapanese = false): boolean {
  if (!cues.length) return false;
  if (declaredJapanese) return cues.some((cue) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(cue.text));
  return cues.filter((cue) => /[\u3040-\u30ff]/u.test(cue.text)).length >= Math.max(1, cues.length * 0.3);
}

// Read only the JSON caption-track array from script text, without executing page code.
export function youtubeTracks(script: string, videoId?: string): { url: string; label: string }[] {
  const marker = /["']captionTracks["']\s*:\s*\[/g.exec(script);
  if (!marker) return [];
  const start = marker.index + marker[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < script.length && i - start < 1000000; i++) {
    const char = script[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      try {
        const tracks = JSON.parse(script.slice(start, i + 1));
        return tracks.filter((track: { languageCode?: string; baseUrl?: string }) => /^ja(?:[-_]|$)/i.test(track.languageCode || '') && typeof track.baseUrl === 'string' && subtitleUrl(track.baseUrl) && (!videoId || new URL(track.baseUrl).searchParams.get('v') === videoId)).map((track: { baseUrl: string; kind?: string }) => ({ url: track.baseUrl, label: track.kind === 'asr' ? 'Japanese auto-captions' : 'Japanese captions' }));
      } catch { return []; }
    }
  }
  return [];
}
