import CookieManager from '@react-native-cookies/cookies';

import { AUTO_FALLBACK, planSeries, resolveSeriesTeam, seriesFiles, seriesRoot, type SeriesPlan } from '../../../src/japanese/series';

export { AUTO_FALLBACK, resolveSeriesTeam, seriesFiles, type SeriesPlan };

/** Where the in-app browser starts. Sign in there once; downloads use the same session. */
export const ANIME365_HOME = 'https://smotret-anime.com/';

// The shared planner uses AbortSignal.timeout, which Hermes may not provide.
if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout !== 'function') {
  (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

/** The series page for a browser address, or null when it isn't an Anime365 series or episode. */
export function seriesPageFor(url: string): string | null {
  try { return seriesRoot(url).href; } catch { return null; }
}

/**
 * The in-app browser keeps its sign-in in WebKit. Copy those cookies to the app's own network
 * session (used by fetch) and return them as a header for the file downloads.
 */
export async function shareSignIn(url: string): Promise<string> {
  const origin = new URL(url).origin;
  const cookies = Object.values(await CookieManager.get(origin, true));
  for (const cookie of cookies) {
    try { await CookieManager.set(origin, cookie, false); } catch { /* The header below still carries it. */ }
  }
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Reads every episode of the series at `url` (the same rules as the Chrome extension). */
export async function planFromBrowser(url: string, onProgress: (checked: number, total: number) => void): Promise<SeriesPlan> {
  await shareSignIn(url);
  return planSeries(url, onProgress);
}
