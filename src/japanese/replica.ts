import { createReplica } from '../../shared/sync/replica-core';
import { tvServerBaseUrl } from './tv-sync';

/**
 * Chrome's copy of the shared library state (shared/sync/replica-core.ts), kept in localStorage.
 * Skip timings, progress and auto-skip choices made here are queued and reach the Mac — and through
 * it the phone and TV — whenever it answers, instead of being lost while it's away.
 */
const STORAGE_KEY = 'arc-replica';

export const replica = createReplica({
  read: () => localStorage.getItem(STORAGE_KEY),
  write: text => localStorage.setItem(STORAGE_KEY, text),
}, 'chrome');

replica.setSyncer(async () => { await replica.syncWith(tvServerBaseUrl()); });

type Range = { start: number; end: number; source?: string };

/** Record a change in the same shape the page already sends the Mac (see pushTvSync). */
export function recordChange(payload: Record<string, unknown>) {
  const series = typeof payload.seriesName === 'string' ? payload.seriesName : '';
  const episode = typeof payload.episode === 'string' ? payload.episode : '';
  if (!series) return;
  if (episode && payload.themes && typeof payload.themes === 'object') {
    const themes: Record<string, Range> = {};
    for (const part of ['op', 'ed', 'recap'] as const) {
      const range = (payload.themes as Record<string, Range | undefined>)[part];
      if (range && typeof range.start === 'number' && typeof range.end === 'number') themes[part] = range;
    }
    replica.setLocal(`ep/${series}/${episode}/themes`, themes);
  }
  const progress = payload.progress as { position?: unknown; watchedAt?: unknown; finished?: unknown } | undefined;
  if (episode && progress && typeof progress.position === 'number' && typeof progress.watchedAt === 'number') {
    replica.setLocal(`ep/${series}/${episode}/progress`, {
      position: progress.position, watchedAt: progress.watchedAt, finished: !!progress.finished,
    }, progress.watchedAt);
  }
  if (payload.autoSkip && typeof payload.autoSkip === 'object') {
    replica.setLocal(`series/${series}/autoSkip`, payload.autoSkip);
  }
}

/** Split an incoming key into its series folder, episode file and field. */
export function parseEpisodeKey(key: string) {
  const parts = key.split('/');
  if (parts[0] !== 'ep' || parts.length < 4) return null;
  return { series: parts[1], episode: parts.slice(2, -1).join('/'), field: parts[parts.length - 1] };
}
