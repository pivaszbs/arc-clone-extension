/** Movies and TV on the Samsung app: data shapes and helpers for the Mac server's stremio/ routes
 * (native/tv/stremio.py), which relay Cinemeta, Torrentio and the Stremio streaming server. */

export type StremioType = 'movie' | 'series';
export type TitleCard = { id: string; type: StremioType; name: string; year: string; poster: string | null };
export type StremioEpisode = { id: string; season: number; episode: number; name: string };
export type SeriesMeta = TitleCard & { episodes: StremioEpisode[] };
export type StreamOption = {
  infoHash: string;
  fileIdx: number;
  quality: string;
  title: string;
  release: string;
  seeders: number | null;
  size: string | null;
  risky: boolean;
};

/** Server-relative address of a search (empty query: popular titles). */
export function searchPath(type: StremioType, query: string) {
  return `stremio/search.json?type=${type}&q=${encodeURIComponent(query.trim())}`;
}

export function metaPath(type: StremioType, id: string) {
  return `stremio/meta.json?type=${type}&id=${encodeURIComponent(id)}`;
}

export function streamsPath(type: StremioType, id: string) {
  return `stremio/streams.json?type=${type}&id=${encodeURIComponent(id)}`;
}

/** Where the TV's video element loads a chosen torrent file from. */
export function playPath(stream: Pick<StreamOption, 'infoHash' | 'fileIdx'>) {
  if (!/^[a-f0-9]{40}$/.test(stream.infoHash)) throw new Error('Bad torrent hash');
  return `stremio/play/${stream.infoHash}/${Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0 ? stream.fileIdx : -1}`;
}

/** Seasons in viewing order: regular seasons first, specials (season 0) last. */
export function seasonsOf(episodes: StremioEpisode[]) {
  return [...new Set(episodes.map(ep => ep.season))].sort((a, b) => (a === 0 ? 1 : 0) - (b === 0 ? 1 : 0) || a - b);
}

export function seasonName(season: number) {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

export function episodeCode(ep: Pick<StremioEpisode, 'season' | 'episode'>) {
  return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
}

/** The two lines a stream button shows: quality and size, then seeders and the file or release name. */
export function streamLabel(stream: StreamOption) {
  const main = [stream.quality, stream.size].filter(Boolean).join(' · ');
  const info = [
    stream.seeders !== null ? `${stream.seeders} seeders` : '',
    stream.title,
    stream.risky ? 'may not play on TV' : ''
  ].filter(Boolean).join(' · ');
  return { main, info };
}

