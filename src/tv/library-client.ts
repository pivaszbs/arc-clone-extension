import type { VideoThemes } from '../japanese/video-themes';

export type Part = keyof VideoThemes;
export type Progress = { position: number; duration?: number; watchedAt: number; finished: boolean };
export type TvEpisode = { name: string; video: string; subtitles: string | null; saved?: { themes?: VideoThemes; progress?: Progress } };
export type TvLibrary = {
  id: string;
  title: string;
  poster?: string | null;
  autoSkip?: Partial<Record<Part, boolean>>;
  autoSkipDelay?: number;
  endingAction?: string;
  episodes: TvEpisode[];
};

export type TvSyncMessage = {
  type?: string;
  action?: string;
  delta?: number;
  position?: number;
  series?: number;
  seriesName?: string;
  episode?: string;
  themes?: VideoThemes;
  autoSkip?: Partial<Record<Part, boolean>>;
  autoSkipDelay?: number;
  autoplay?: boolean;
  finished?: boolean;
  progress?: Progress;
  done?: number;
  total?: number;
};

/** Validate and normalize a private LAN Anime Study TV server URL. */
export function privateLibraryAddress(input: string): string {
  const url = new URL(input.trim());
  const octets = url.hostname.split('.').map(Number);
  const local = octets.length === 4 && (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
  if (url.protocol !== 'http:' || !local || url.username || url.password || !/^\/[a-f0-9]{16}\/?$/.test(url.pathname)) {
    throw new Error('Enter the full Anime Study address shown on your Mac.');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/`;
}

/** Strip download-folder prefixes, numeric IDs, and translation credits for display. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^Смотреть аниме\s+/i, '')
    .replace(/\s+онлайн(?=\s|$)/i, '')
    .replace(/\s+-\s+\d+(?:\s+-\s+.*)?$/, '')
    .trim() || raw;
}

/** Format an episode filename into a concise label like `Episode 3`. */
export function episodeTitle(name: string): string {
  const number = /^Episode\s+(\d+)\b/i.exec(name);
  return number ? `Episode ${Number(number[1])}` : name.replace(/\.[^.]+$/, '');
}

/** Apply an incoming WebSocket `sync` message to the catalog in place and report affected state. */
export function applyTvSyncEvent(
  catalog: TvLibrary[],
  msg: TvSyncMessage
): { targetIdx: number; targetLib: TvLibrary; themesUpdated: boolean; skipUpdated: boolean } | null {
  if (msg.type !== 'sync') return null;
  const targetIdx = typeof msg.series === 'number'
    ? msg.series
    : typeof msg.seriesName === 'string'
      ? catalog.findIndex(s => s.title === msg.seriesName || s.id === msg.seriesName)
      : -1;
  const targetLib = targetIdx >= 0 ? catalog[targetIdx] : undefined;
  if (!targetLib) return null;

  let skipUpdated = false;
  if (msg.autoSkip && typeof msg.autoSkip === 'object') {
    targetLib.autoSkip = { ...(targetLib.autoSkip ?? {}), ...msg.autoSkip };
    skipUpdated = true;
  }
  if (typeof msg.autoSkipDelay === 'number') {
    targetLib.autoSkipDelay = msg.autoSkipDelay;
    skipUpdated = true;
  }

  let themesUpdated = false;
  if (typeof msg.episode === 'string') {
    const ep = targetLib.episodes.find(e => e.name === msg.episode);
    if (ep) {
      ep.saved = ep.saved ?? {};
      if (msg.themes && typeof msg.themes === 'object') {
        ep.saved.themes = { ...(ep.saved.themes ?? {}), ...msg.themes };
        themesUpdated = true;
      }
      if (msg.progress && typeof msg.progress === 'object') {
        ep.saved.progress = { ...(ep.saved.progress ?? {}), ...msg.progress };
      }
    }
  }
  return { targetIdx, targetLib, themesUpdated, skipUpdated };
}
