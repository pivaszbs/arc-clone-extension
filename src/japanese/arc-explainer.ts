import type { Cue } from './study';
import type { VideoThemes } from './video-themes';

export type ArcExplainerData = {
  seriesTitle: string;
  episodeTitle?: string;
  overview: string;
  recapSummary?: string;
  storyBeats: string[];
  genres: string[];
  hasSubtitles: boolean;
};

export function extractSeriesIdFromName(folderName: string): string | null {
  const match = /\b(\d{4,6})\b/.exec(folderName);
  return match ? match[1] : null;
}

export function extractEpisodeNumberFromName(fileName: string): number | null {
  const match = /(?:Episode|Ep\.?|E)\s*0*(\d+)\b/i.exec(fileName);
  return match ? Number(match[1]) : null;
}

function insideRange(cue: Cue, range?: { start: number; end: number }): boolean {
  if (!range) return false;
  const mid = (cue.start + cue.end) / 2;
  return mid >= range.start && mid <= range.end;
}

/**
 * Pick representative dialogue cues from an episode while excluding OP and ED theme songs.
 * Separates recap lines when a recap interval is detected.
 */
export function selectStoryCuesForExplainer(
  cues: Cue[],
  themes: VideoThemes,
  maxStory = 8
): { recapLines: string[]; storyLines: string[] } {
  const cleanText = (text: string) => text.replace(/\s+/g, ' ').trim();
  const recapLines: string[] = [];
  const storyCandidates: Cue[] = [];

  for (const cue of cues) {
    const text = cleanText(cue.text);
    if (text.length < 4) continue;
    if (insideRange(cue, themes.op) || insideRange(cue, themes.ed)) continue;
    if (insideRange(cue, themes.recap)) {
      if (recapLines.length < 3 && recapLines[recapLines.length - 1] !== text) recapLines.push(text);
      continue;
    }
    storyCandidates.push({ ...cue, text });
  }

  if (storyCandidates.length <= maxStory) {
    return { recapLines, storyLines: storyCandidates.map(c => c.text) };
  }

  const storyLines: string[] = [];
  const step = (storyCandidates.length - 1) / (maxStory - 1);
  for (let i = 0; i < maxStory; i++) {
    const line = storyCandidates[Math.round(i * step)].text;
    if (storyLines[storyLines.length - 1] !== line) storyLines.push(line);
  }
  return { recapLines, storyLines };
}

export function parseSeriesArcMetadata(
  payload: unknown,
  episodeNumber: number | null
): { seriesTitle: string; episodeTitle?: string; synopsis: string; genres: string[] } {
  const root = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data ?? payload : {}) as Record<string, unknown>;
  const seriesTitle = typeof root.title === 'string' ? root.title : '';
  const descriptions = Array.isArray(root.descriptions) ? root.descriptions as { value?: unknown }[] : [];
  const rawDesc = descriptions.find(d => typeof d?.value === 'string' && d.value.trim())?.value;
  const synopsis = typeof rawDesc === 'string'
    ? rawDesc.replace(/<[^>]+>/g, '').replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim()
    : '';
  const genres = Array.isArray(root.genres)
    ? (root.genres as { title?: unknown }[]).map(g => (typeof g?.title === 'string' ? g.title : '')).filter(Boolean)
    : [];
  let episodeTitle: string | undefined;
  if (episodeNumber !== null && Array.isArray(root.episodes)) {
    const found = (root.episodes as { episodeInt?: unknown; episodeFull?: unknown; episodeTitle?: unknown }[])
      .find(ep => Number(ep.episodeInt) === episodeNumber);
    if (found && typeof found.episodeTitle === 'string' && found.episodeTitle.trim()) {
      episodeTitle = found.episodeTitle.trim();
    }
  }
  return { seriesTitle, episodeTitle, synopsis, genres };
}
