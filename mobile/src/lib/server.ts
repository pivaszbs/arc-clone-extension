import { animeCore } from 'react-native-anime-core';
import type { Episode, Series } from './library';
import { registerSeriesAlias } from './replica';
import { rememberAddresses } from './server-address';
import type { Progress } from './storage';
import { skipRanges } from './theme-sidecar';
import { DEFAULT_TV_SERVER_URL, normalizeTvServerUrl, type TvPlaybackState } from './tv-sync';

export { DEFAULT_TV_SERVER_URL as DEFAULT_MAC_SERVER_URL, normalizeTvServerUrl as normalizeServerUrl };

type CatalogResponse = {
  addresses?: string[];
  autoplay?: boolean;
  tvState?: TvPlaybackState;
  series?: {
    id: string;
    title: string;
    poster?: string | null;
    episodes: {
      name: string;
      video: string;
      subtitles: string | null;
      saved?: { themes?: unknown; progress?: { position: number; duration?: number; watchedAt: number; finished: boolean } };
    }[];
  }[];
};

export async function fetchRemoteCatalog(baseUrl: string): Promise<{
  series: Series[];
  progress: Record<string, Progress>;
  autoplay: boolean;
  tvState?: TvPlaybackState;
  statusCode: number;
}> {
  const url = normalizeTvServerUrl(baseUrl);
  // A timeout, so an address that stopped answering fails fast and another can be tried.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let payload: CatalogResponse;
  let res: Response;
  try {
    res = await fetch(`${url}catalog.json`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as CatalogResponse;
  } finally {
    clearTimeout(timer);
  }
  rememberAddresses(payload.addresses);
  const list = Array.isArray(payload.series) ? payload.series : [];
  const progress: Record<string, Progress> = {};
  const series = list
    .filter(item => Array.isArray(item.episodes) && item.episodes.length > 0)
    .map(item => {
      registerSeriesAlias(item.id, item.title);
      const { title, credit } = animeCore.folderTitle(item.title);
      const episodes: Episode[] = item.episodes.map(ep => {
        const numberMatch = /^Episode\s+(\d+)\b/i.exec(ep.name);
        const label = numberMatch ? `Episode ${Number(numberMatch[1])}` : ep.name.replace(/\.[^.]+$/, '');
        const key = `${item.id}/${ep.name}`;
        const rawProgress = ep.saved?.progress;
        if (
          rawProgress &&
          typeof rawProgress.position === 'number' &&
          typeof rawProgress.watchedAt === 'number' &&
          typeof rawProgress.finished === 'boolean'
        ) {
          progress[key] = {
            position: rawProgress.position,
            duration: typeof rawProgress.duration === 'number' ? rawProgress.duration : 0,
            watchedAt: rawProgress.watchedAt,
            finished: rawProgress.finished,
          };
        }
        return {
          video: ep.name,
          subtitle: ep.subtitles ? ep.name : undefined,
          label,
          key,
          videoUri: `${url}${ep.video}`,
          subtitleUri: ep.subtitles ? `${url}${ep.subtitles}` : undefined,
          frames: skipRanges(ep.saved?.themes),
        };
      });
      return {
        folder: item.title,
        title: title || item.title,
        credit,
        episodes,
      };
    });
  return { series, progress, autoplay: payload.autoplay !== false, tvState: payload.tvState, statusCode: res.status };
}

export async function fetchRemoteLibrary(baseUrl: string): Promise<Series[]> {
  const { series } = await fetchRemoteCatalog(baseUrl);
  return series;
}

export async function pushRemoteSync(baseUrl: string, payload: Record<string, unknown>) {
  try {
    await fetch(`${normalizeTvServerUrl(baseUrl)}sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* Server unreachable. */ }
}
