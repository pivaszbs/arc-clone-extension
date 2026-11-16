/**
 * Where and how each subtitle line should be drawn, read from the subtitle file itself.
 *
 * The parser in react-native-anime-core returns plain text and times. Streaming players also honour
 * two things from the file: lines placed at the top of the picture (signs, song translations, a
 * second speaker) and italics (thoughts, narration, off-screen voices). This reads just those.
 */

export type CueHint = { top: boolean; italic: boolean };
type HintIndex = Map<string, CueHint>;

const plain = (text: string) => text
  .replace(/\{[^}]*\}/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/\\[Nnh]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const keyOf = (start: number, text: string) => `${Math.round(start * 100)}:${plain(text).slice(0, 16)}`;

function assTime(value: string) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}

function fromAss(body: string): HintIndex {
  const hints: HintIndex = new Map();
  const styles = new Map<string, CueHint>();
  let playResY = 288;
  let section = '';
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (section === '[script info]' && name === 'playresy') playResY = Number(value) || playResY;
    else if (section.includes('styles') && name === 'format') styleFormat = value.split(',').map(item => item.trim().toLowerCase());
    else if (section.includes('styles') && name === 'style') {
      const fields = value.split(',').map(item => item.trim());
      const alignment = Number(fields[styleFormat.indexOf('alignment')]);
      // V4+ uses numpad alignment (7–9 is the top row); old V4 marks the top row with 5–7.
      const top = section.includes('v4+') ? alignment >= 7 && alignment <= 9 : alignment >= 5 && alignment <= 7;
      styles.set(fields[0].replace(/^\*/, ''), { top, italic: fields[styleFormat.indexOf('italic')] === '-1' });
    } else if (section === '[events]' && name === 'format') eventFormat = value.split(',').map(item => item.trim().toLowerCase());
    else if (section === '[events]' && name === 'dialogue' && eventFormat.length) {
      const textAt = eventFormat.indexOf('text');
      const fields = value.split(',');
      if (fields.length <= textAt) continue;
      const text = fields.slice(textAt).join(',');
      const start = assTime(fields[eventFormat.indexOf('start')] ?? '');
      if (!Number.isFinite(start)) continue;
      const style = styles.get((fields[eventFormat.indexOf('style')] ?? '').trim().replace(/^\*/, '')) ?? { top: false, italic: false };
      const override = /\\an(\d)/.exec(text);
      const position = /\\pos\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*\)/.exec(text);
      const top = override ? Number(override[1]) >= 7
        : position ? Number(position[1]) < playResY * 0.45
          : style.top;
      // Italic when the line opens with \i1 (or the style is italic and the line doesn't turn it off).
      const opening = /^\{[^}]*\}/.exec(text)?.[0] ?? '';
      const italic = /\\i1/.test(opening) || (style.italic && !/\\i0/.test(opening));
      hints.set(keyOf(start, text), { top, italic });
    }
  }
  return hints;
}

function fromCueText(body: string): HintIndex {
  // SRT and WebVTT: a block is "start --> end [settings]" followed by its text.
  const hints: HintIndex = new Map();
  const blocks = body.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const [from, rest = ''] = lines[at].split('-->');
    const start = assTime(from.trim().replace(/^(\d{1,2}:\d{2}[.,]\d{1,3})$/, '0:$1'));
    const text = lines.slice(at + 1).join('\n');
    if (!Number.isFinite(start) || !text) continue;
    const line = /line:(-?[\d.]+)(%?)/.exec(rest);
    const top = /\{\\an[789]\}/.test(text) || (!!line && (line[2] ? Number(line[1]) < 45 : Number(line[1]) >= 0 && Number(line[1]) < 6));
    const italic = /^\s*(<i>|\{\\i1\})/i.test(text);
    if (top || italic) hints.set(keyOf(start, text), { top, italic });
  }
  return hints;
}

const none: CueHint = { top: false, italic: false };

/** Build a lookup for one subtitle file. Call it once per episode, not per frame. */
export function subtitleHints(body: string): (cue: { start: number; text: string }) => CueHint {
  if (!body) return () => none;
  let hints: HintIndex;
  try {
    hints = /^\s*\[script info\]/im.test(body) ? fromAss(body) : fromCueText(body);
  } catch {
    return () => none;
  }
  if (!hints.size) return () => none;
  return cue => hints.get(keyOf(cue.start, cue.text)) ?? none;
}

/** Every line on screen at `time`, oldest first (cues sorted by start). */
export function activeCues<T extends { start: number; end: number }>(cues: T[], time: number, limit = 3): number[] {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid]!.start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  const active: number[] = [];
  for (let index = found; index >= 0 && index >= found - 12 && active.length < limit; index--) {
    if (time < cues[index]!.end) active.unshift(index);
  }
  return active;
}

/** Seconds until the set of lines on screen next changes, or Infinity. */
export function nextChange<T extends { start: number; end: number }>(cues: T[], time: number, active: number[]) {
  let next = Infinity;
  for (const index of active) next = Math.min(next, cues[index]!.end - time);
  const after = (active.length ? active[active.length - 1]! : -1) + 1;
  for (let index = Math.max(0, after); index < cues.length; index++) {
    const start = cues[index]!.start;
    if (start > time) { next = Math.min(next, start - time); break; }
  }
  return next;
}
