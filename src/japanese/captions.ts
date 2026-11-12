import { parseSubtitles, type Cue } from './study';

export function subtitleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return false;
    const language = url.searchParams.get('lang') || url.searchParams.get('language') || '';
    if (language && !/^ja(?:[-_]|$)/i.test(language)) return false;
    if (url.searchParams.has('tlang')) return false;
    return (
      /\.(vtt|srt|ass|ssa|ttml|dfxp)(?:$|\/)/i.test(url.pathname) ||
      /\/translations\/(?:ass|ssa|srt|vtt)\/\d+/i.test(url.pathname) ||
      (/^(?:www\.)?youtube\.com$/.test(url.hostname) && url.pathname === '/api/timedtext' && /^ja(?:[-_]|$)/i.test(language))
    );
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
    const parsedAss = body.split(/\r?\n/).flatMap((line) => {
      if (line.startsWith('Format:')) { fields = line.slice(7).split(',').map((field) => field.trim().toLowerCase()); return []; }
      if (!line.startsWith('Dialogue:') || !['text', 'start', 'end'].every((field) => fields.includes(field))) return [];
      const parts = line.slice(9).split(',');
      const styleIdx = fields.indexOf('style');
      const styleName = styleIdx >= 0 ? (parts[styleIdx] || '').trim().toLowerCase() : '';
      if (styleName && /(?:furi|ruby|karaoke)/i.test(styleName)) return [];
      const rawText = parts.slice(fields.indexOf('text')).join(',');
      if (/\{\\p[1-9]/.test(rawText)) return [];
      const cue = {
        start: timestamp((parts[fields.indexOf('start')] || '').trim()),
        end: timestamp((parts[fields.indexOf('end')] || '').trim()),
        text: clean(rawText.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '))
      };
      return valid(cue) ? [cue] : [];
    });
    return parsedAss.sort((a, b) => a.start - b.start);
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

type TimeRange = { start: number; end: number };
type AnimeSegment = TimeRange & { source: 'ass-style' | 'subtitle-label' | 'subtitle-music' | 'repeated-subtitles' | 'dialogue-gap' };
export interface AnimeOpEdIntervals {
  op: AnimeSegment | null;
  ed: AnimeSegment | null;
}

type Part = keyof AnimeOpEdIntervals;
const themeLabel = {
  op: /(?:\b(?:op\d*|opening)(?:[-_\s]?(?:romaji|jp|kanji|rus|en|sub|lyrics|song))?(?![a-z0-9])|オープニング|(?:^|\s)主題歌)/iu,
  ed: /(?:\b(?:ed\d*|ending)(?:[-_\s]?(?:romaji|jp|kanji|rus|en|sub|lyrics|song))?(?![a-z0-9])|エンディング|エンドクレジット)/iu
};

function cueLabel(text: string) {
  const marker = text.trim().match(/^[【［\[(（〈＜]([^】］\])）〉＞]+)[】］\])）〉＞]$/u)?.[1];
  return marker || '';
}

function isMusic(text: string) {
  return /^[\s♪♫♬♩]+$/u.test(text) || /^[♪♫♬♩]/u.test(text)
    || /^(?:music(?:\s+playing)?|singing|音楽|歌|テーマ曲|主題歌)$/iu.test(cueLabel(text).trim());
}

function mergeRanges(ranges: TimeRange[], gap = 0) {
  const merged: TimeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + gap) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function findRepeatedTheme(cues: Cue[], references: Cue[][], part: Part, duration: number): AnimeSegment | null {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const lines = (track: Cue[], end: number) => track.filter(cue => part === 'op' ? cue.start < 360 : cue.start >= end - 300)
    .map(cue => ({ ...cue, key: normalize(cue.text) })).filter(cue => cue.key.length >= 8);
  const current = lines(cues, duration);
  if (current.length < 6 || current.length > 750) return null;
  let best: AnimeSegment | null = null;
  let bestCount = 0;

  for (const reference of references) {
    const byText = new Map<string, number[]>();
    for (const cue of lines(reference, reference.reduce((end, cue) => Math.max(end, cue.end), 0))) {
      const times = byText.get(cue.key) || [];
      times.push(cue.start);
      byText.set(cue.key, times);
    }
    // A repeated theme keeps the timing between its lines even when the episode starts it later.
    const offsets = new Set<number>();
    for (const cue of current) {
      const times = byText.get(cue.key);
      if (times?.length === 1) offsets.add(Math.round(times[0] - cue.start));
    }
    for (const offset of offsets) {
      const matches = current.filter(cue => {
        const times = byText.get(cue.key);
        return times?.length === 1 && Math.abs(times[0] - cue.start - offset) <= 1.5;
      });
      for (const run of mergeRanges(matches, 22)) {
        const length = run.end - run.start;
        if (length < 55 || length > 140) continue;
        const count = new Set(matches.filter(cue => cue.start >= run.start && cue.end <= run.end).map(cue => cue.key)).size;
        const total = new Set(current.filter(cue => cue.start >= run.start && cue.end <= run.end).map(cue => cue.key)).size;
        if (count >= 6 && count >= total * 0.8 && count > bestCount) {
          best = { ...run, source: 'repeated-subtitles' };
          bestCount = count;
        }
      }
    }
  }
  return best;
}

export function detectAnimeOpEdIntervals(
  rawBody: string,
  cues: Cue[],
  videoDuration = 0,
  references: Cue[][] = []
): AnimeOpEdIntervals {
  const duration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0;
  const timed = cues.filter(cue => valid(cue) && (!duration || cue.end <= duration + 0.5)).sort((a, b) => a.start - b.start);
  const limit = duration || Math.max(1420, (timed[timed.length - 1]?.end || 0) + 30);
  const tagged: Record<Part, TimeRange[]> = { op: [], ed: [] };
  const music: TimeRange[] = [];
  const speech: TimeRange[] = [];

  function classify(range: TimeRange, text: string, metadata = '', comment = false) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end > limit + 0.5) return;
    const visible = clean(text);
    const label = `${metadata} ${cueLabel(visible)}`;
    if (themeLabel.op.test(label)) tagged.op.push(range);
    else if (themeLabel.ed.test(label)) tagged.ed.push(range);
    else if (/\b(?:song|lyrics|karaoke|romaji)\b/i.test(metadata) || /\{\\k[fo]?\d+/i.test(text) || isMusic(visible)) music.push(range);
    else if (!comment && visible) speech.push(range);
  }

  const isAss = /\[Events\]/i.test(rawBody);
  if (isAss) {
    let fields: string[] = [];
    for (const line of rawBody.split(/\r?\n/)) {
      if (/^\s*Format:/i.test(line)) {
        fields = line.split(':', 2)[1].split(',').map(field => field.trim().toLowerCase());
        continue;
      }
      const row = /^\s*(Dialogue|Comment):\s*(.*)$/i.exec(line);
      if (!row || !['start', 'end', 'text'].every(field => fields.includes(field))) continue;
      const parts = row[2].split(',');
      const field = (name: string) => (parts[fields.indexOf(name)] || '').trim();
      const start = timestamp(field('start'));
      const end = timestamp(field('end'));
      const text = parts.slice(fields.indexOf('text')).join(',').replace(/\\[Nn]/g, '\n');
      const style = field('style');
      if (/(?:furi|ruby)/i.test(style) || /\{\\p[1-9]/.test(text)) continue;
      classify({ start, end }, text, [style, field('name') || field('actor'), field('effect')].join(' '), /^comment$/i.test(row[1]));
    }
  } else {
    for (const cue of timed) classify(cue, cue.text);
  }

  const early = (range: TimeRange) => range.start <= Math.min(360, limit / 2);
  const late = (range: TimeRange) => range.start >= Math.max(limit / 2, limit - 240);
  const themes = mergeRanges(music, 6).filter(range => {
    const length = range.end - range.start;
    if (length < 65 || length > 140) return false;
    if (speech.some(cue => cue.start < range.end - 1 && cue.end > range.start + 1)) return false;
    const covered = mergeRanges(music.filter(cue => cue.start >= range.start && cue.end <= range.end));
    return covered.reduce((seconds, cue) => seconds + cue.end - cue.start, 0) >= length * 0.55;
  });

  function detect(part: Part, inWindow: (range: TimeRange) => boolean): AnimeSegment | null {
    const explicit = mergeRanges(tagged[part], 10).find(range => range.end - range.start >= 45 && range.end - range.start <= 150);
    if (explicit) return { ...explicit, source: isAss ? 'ass-style' : 'subtitle-label' };
    const musicTheme = themes.find(inWindow);
    if (musicTheme && (part === 'op' || duration)) return { ...musicTheme, source: 'subtitle-music' };
    if (references.length && duration) {
      const repeated = findRepeatedTheme(timed, references, part, duration);
      if (repeated && inWindow(repeated)) return repeated;
    }
    if (timed.length < 15 || (part === 'ed' && !duration)) return null;

    const occupied = mergeRanges(timed);
    const gaps = occupied.map((range, index) => ({ start: occupied[index - 1]?.end ?? 0, end: range.start }));
    if (part === 'ed') gaps.push({ start: occupied[occupied.length - 1].end, end: duration });
    const candidates = gaps.filter(range => inWindow(range) && range.end - range.start >= 75 && range.end - range.start <= 110);
    if (candidates.length !== 1) return null;
    const gap = candidates[0];
    // Keep a small margin before dialogue or the end of the file.
    return { start: gap.start, end: gap.end - 0.5, source: 'dialogue-gap' };
  }

  return { op: detect('op', early), ed: detect('ed', late) };
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
