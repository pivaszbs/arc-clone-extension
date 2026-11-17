// What a downloaded series is, from public anime databases keyed by the ids we already have:
// the smotret-anime id in the folder name gives the full title and the MyAnimeList id, and
// Shikimori (which uses MyAnimeList ids) gives the franchise and when each part aired.
import type { CatalogEntry } from './seasons';

export type CatalogCache = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

type SmotretSeries = { titles?: { romaji?: unknown }; myAnimeListId?: unknown; posterUrl?: unknown; posterUrlSmall?: unknown };
type FranchiseNode = { id?: unknown; date?: unknown };
type Franchise = { franchise: string; aired?: number };

const SMOTRET = 'https://smotret-anime.com/api/series/';
const SHIKIMORI = 'https://shikimori.io/api/animes/';

function smotretData(payload: unknown) {
  return (payload as { data?: SmotretSeries } | null)?.data;
}

/** The smotret-anime series payload, cached under the key the Arc explainer already uses. */
export async function smotretSeries(seriesId: string, cache: CatalogCache, fetcher: typeof fetch = fetch) {
  const key = `arc-series-meta:${seriesId}`;
  const cached = smotretData(cache.get(key));
  if (cached) return cached;
  const res = await fetcher(`${SMOTRET}${seriesId}`);
  if (!res.ok) return undefined;
  const payload = await res.json();
  cache.set(key, payload);
  return smotretData(payload);
}

/** Poster URL from a smotret-anime series payload. */
export function smotretPoster(data: SmotretSeries | undefined) {
  const url = data?.posterUrl || data?.posterUrlSmall;
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}

/**
 * The franchise a MyAnimeList id belongs to. One request covers every part of the franchise,
 * so each part is cached and its siblings need no request of their own.
 */
export async function franchiseOf(malId: number, cache: CatalogCache, fetcher: typeof fetch = fetch): Promise<Franchise | undefined> {
  const key = (id: number) => `anime-franchise:${id}`;
  const cached = cache.get(key(malId)) as Franchise | null | undefined;
  if (cached && typeof cached.franchise === 'string') return cached;
  const res = await fetcher(`${SHIKIMORI}${malId}/franchise`);
  if (!res.ok) return undefined;
  const payload = await res.json() as { nodes?: FranchiseNode[] };
  const nodes = (payload.nodes ?? []).filter((node): node is { id: number; date?: unknown } => typeof node.id === 'number');
  // A series with no relations has no franchise graph: it is its own franchise.
  const franchise = String(nodes.length ? Math.min(...nodes.map(node => node.id)) : malId);
  let found: Franchise | undefined;
  for (const node of nodes) {
    const entry: Franchise = { franchise, aired: typeof node.date === 'number' ? node.date : undefined };
    cache.set(key(node.id), entry);
    if (node.id === malId) found = entry;
  }
  found ??= { franchise };
  cache.set(key(malId), found);
  return found;
}

/** Full title, franchise and air date of a smotret-anime series; whatever is reachable. */
export async function lookupSeries(seriesId: string, cache: CatalogCache, fetcher: typeof fetch = fetch): Promise<CatalogEntry | undefined> {
  let data: SmotretSeries | undefined;
  try { data = await smotretSeries(seriesId, cache, fetcher); } catch { return undefined; }
  if (!data) return undefined;
  const romaji = data.titles?.romaji;
  const entry: CatalogEntry = { title: typeof romaji === 'string' && romaji.trim() ? romaji.trim() : undefined };
  const malId = Number(data.myAnimeListId);
  if (Number.isInteger(malId) && malId > 0) {
    try {
      const franchise = await franchiseOf(malId, cache, fetcher);
      if (franchise) Object.assign(entry, franchise);
    } catch { /* Offline or rate limited: group by title until next time. */ }
  }
  return entry;
}
