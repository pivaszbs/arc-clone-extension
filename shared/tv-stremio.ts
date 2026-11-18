/** Movies and TV (Samsung app and the phone remote): data shapes and helpers for the Mac server's stremio/ routes
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
  /** Torrentio's release group: the next episode from the same group plays the same way. */
  bingeGroup?: string | null;
};

/** What the Mac remembers about a watched movie or episode (native/tv/movie_history.py). */
export type HistoryEntry = {
  id: string;
  showId: string;
  type: StremioType;
  title: string;
  label: string;
  poster: string | null;
  path: string;
  bingeGroup: string | null;
  position: number;
  duration: number | null;
  finished: boolean;
  watchedAt: number;
};

/** A Movies & TV job saving a stream into the Mac library (native/tv/movie_library.py). */
export type SaveJob = {
  id: string;
  type: StremioType;
  itemId: string;
  showId?: string | null;
  poster?: string | null;
  name: string;
  year?: string;
  season?: number;
  episode?: number;
  episodeName?: string;
  quality?: string;
  state: 'queued' | 'downloading' | 'converting' | 'done' | 'failed';
  fraction?: number;
  error?: string | null;
  folder?: string;
  /** The saved MP4 inside `folder`, once done. */
  file?: string | null;
};

/** Saved copies by movie or episode id: these play from the library instead of a torrent. */
export function savedCopies(jobs: SaveJob[]) {
  return new Map(jobs.filter(job => job.state === 'done' && job.folder && job.file).map(job => [job.itemId, job]));
}

export function nextPath(id: string, group?: string | null) {
  return `stremio/next.json?id=${encodeURIComponent(id)}${group ? `&group=${encodeURIComponent(group)}` : ''}`;
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** How a Continue watching entry reads: "S01E03 · 12:30 left", "Next episode", "Resume at 1:02:10". */
export function continueLabel(entry: HistoryEntry) {
  const code = entry.type === 'series' ? entry.label.split(' · ')[0] : '';
  const where = entry.finished ? 'Next episode'
    : entry.duration && entry.duration - entry.position > 60 ? `${clock(entry.duration - entry.position)} left`
      : `Resume at ${clock(entry.position)}`;
  return [code, where].filter(Boolean).join(' · ');
}

/** One gallery card per saved movie or show: its jobs, and a badge saying how far saving got. */
export type SavedTitle = { card: TitleCard; jobs: SaveJob[]; badge: string; fraction: number | null; failed: boolean };

const activeJob = (job: SaveJob) => job.state === 'queued' || job.state === 'downloading' || job.state === 'converting';

export function savedTitles(jobs: SaveJob[]): SavedTitle[] {
  const byTitle = new Map<string, SaveJob[]>();
  for (const job of jobs) {
    const key = job.type === 'series' ? job.showId || job.itemId.split(':')[0] : job.itemId;
    byTitle.set(key, [...(byTitle.get(key) || []), job]);
  }
  return [...byTitle.entries()].map(([id, items]) => {
    const first = items[0];
    const done = items.filter(job => job.state === 'done').length;
    const running = items.find(job => job.state === 'downloading' || job.state === 'converting');
    const failed = items.some(job => job.state === 'failed');
    const waiting = items.some(activeJob);
    const fraction = running ? running.fraction || 0 : null;
    const badge = items.length > 1
      ? `${done} of ${items.length} saved${failed ? ' · failed' : ''}`
      : first.state === 'done' ? 'Saved'
        : first.state === 'failed' ? 'Failed'
          : running ? (running.state === 'converting' ? 'Converting' : `Saving ${Math.round((fraction || 0) * 100)}%`)
            : waiting ? 'Waiting' : '';
    return { card: { id, type: first.type, name: first.name, year: first.year || '', poster: first.poster || null }, jobs: items, badge, fraction, failed };
  });
}

/** What a stream save is doing, for a progress line. */
export function saveJobLabel(job: SaveJob) {
  const name = job.type === 'series' && job.season !== undefined && job.episode !== undefined
    ? `${job.name} · ${episodeCode({ season: job.season, episode: job.episode })}` : job.name;
  const state = job.state === 'downloading' ? `Downloading ${Math.round((job.fraction || 0) * 100)}%`
    : job.state === 'converting' ? 'Converting for the phone and TV'
      : job.state === 'done' ? 'Saved in the library' : job.state === 'failed' ? (job.error || 'Failed') : 'Waiting';
  return { name, state };
}

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

