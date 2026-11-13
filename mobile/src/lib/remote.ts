import { Directory, File, Paths } from 'expo-file-system';

import * as replica from './replica';

/**
 * Connection to the Mac's library server (native/tv/serve.py). Everything here is optional: the
 * phone plays from its own copies and keeps its own state, and only syncs when the Mac answers.
 */

export type RemoteEpisode = {
  name: string;
  video: string;
  subtitles: string | null;
  subtitleName?: string | null;
  size?: number;
};
export type RemoteSeries = { id: string; folder: string; title: string; episodes: RemoteEpisode[] };
export type SyncStatus = { state: 'unpaired' | 'idle' | 'syncing' | 'offline'; lastSync?: number; unsent: number; error?: string };

const folder = new Directory(Paths.document, '.anime-study');
const configFile = new File(folder, 'remote.json');
const catalogFile = new File(folder, 'catalog.json');
type Config = { baseUrl?: string; lastSync?: number };

function readJson<T>(file: File): T | undefined {
  try { return file.exists ? JSON.parse(file.textSync()) as T : undefined; } catch { return undefined; }
}
function writeJson(file: File, value: unknown) {
  try {
    if (!folder.exists) folder.create({ intermediates: true });
    file.write(JSON.stringify(value));
  } catch { /* Best effort. */ }
}

let config: Config = readJson<Config>(configFile) ?? {};
let status: SyncStatus = { state: config.baseUrl ? 'idle' : 'unpaired', lastSync: config.lastSync, unsent: replica.unsentCount() };
const statusListeners = new Set<(status: SyncStatus) => void>();

function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next, unsent: replica.unsentCount() };
  for (const listener of statusListeners) listener(status);
}
export const syncStatus = () => status;
export function onStatus(listener: (status: SyncStatus) => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

export const serverUrl = () => config.baseUrl;

/** Accepts the address serve.py prints, e.g. http://192.168.1.10:46158/<token>/ */
export function normalizeUrl(input: string) {
  let url = input.trim();
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/(index\.html|library\.json|catalog\.json)$/i, '');
  return url.endsWith('/') ? url : `${url}/`;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const base = config.baseUrl;
  if (!base) throw new Error('Not connected to a Mac');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`The Mac answered ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function pair(input: string) {
  const baseUrl = normalizeUrl(input);
  if (!baseUrl) throw new Error('Enter the address shown on the Mac');
  const previous = config;
  config = { baseUrl };
  try {
    await fetchCatalog();
  } catch (error) {
    config = previous;
    throw error;
  }
  writeJson(configFile, config);
  setStatus({ state: 'idle', error: undefined });
  void sync();
}

export function unpair() {
  config = {};
  writeJson(configFile, config);
  setStatus({ state: 'unpaired', error: undefined });
}

/** Series on the Mac. Falls back to the last copy, so the list still shows while the Mac is away. */
export async function fetchCatalog(): Promise<RemoteSeries[]> {
  const catalog = await request<{ series?: (Omit<RemoteSeries, 'folder'> & { folder?: string })[] }>('catalog.json');
  // Servers from before v1.3.38 don't send `folder`; their title is the folder name unless renamed.
  const series = (catalog.series ?? [])
    .map(item => ({ ...item, folder: item?.folder || item?.title }))
    .filter((item): item is RemoteSeries => typeof item.folder === 'string' && !!item.folder && Array.isArray(item.episodes));
  writeJson(catalogFile, series);
  return series;
}
export const cachedCatalog = () => readJson<RemoteSeries[]>(catalogFile) ?? [];

// ----- Downloads -----

/** Folder and file names come from the Mac; keep them inside the app's Documents folder. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200);

export const localVideo = (series: RemoteSeries, episode: RemoteEpisode) =>
  new File(new Directory(Paths.document, safeName(series.folder)), safeName(episode.name));

export function isDownloaded(series: RemoteSeries, episode: RemoteEpisode) {
  const file = localVideo(series, episode);
  return file.exists && (!episode.size || file.size === episode.size);
}

export type DownloadProgress = { key: string; written: number; total: number };

/** Copy one episode (and its subtitles) onto the phone so it plays without the Mac. */
export async function download(series: RemoteSeries, episode: RemoteEpisode, onProgress?: (progress: DownloadProgress) => void, signal?: AbortSignal) {
  const base = config.baseUrl;
  if (!base) throw new Error('Not connected to a Mac');
  const dir = new Directory(Paths.document, safeName(series.folder));
  if (!dir.exists) dir.create({ intermediates: true });
  const key = `${series.folder}/${episode.name}`;

  if (episode.subtitles) {
    const stem = episode.name.replace(/\.[^.]+$/, '');
    const name = safeName(episode.subtitleName || `${stem}.ass`);
    const target = new File(dir, name);
    if (target.exists) target.delete();
    await File.downloadFileAsync(base + episode.subtitles, target);
  }

  const target = new File(dir, safeName(episode.name));
  if (target.exists) target.delete();
  const task = File.createDownloadTask(base + episode.video, target, {
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => onProgress?.({ key, written: bytesWritten, total: totalBytes || episode.size || 0 }),
  });
  await task.downloadAsync();
}

export function removeDownload(series: RemoteSeries, episode: RemoteEpisode) {
  const file = localVideo(series, episode);
  if (file.exists) file.delete();
}

// ----- State sync -----

let syncing: Promise<string[]> | undefined;
let failures = 0;
let retryAt = 0;

/**
 * One round trip with the Mac: send this phone's changes, receive everyone else's. Never throws;
 * when the Mac is away the changes stay queued and the next sync sends them.
 */
export function sync(force = false): Promise<string[]> {
  if (!config.baseUrl) return Promise.resolve([]);
  if (syncing) return syncing;
  // Back off while the Mac is unreachable so the phone isn't kept busy retrying.
  if (!force && Date.now() < retryAt) return Promise.resolve([]);
  syncing = (async () => {
    setStatus({ state: 'syncing' });
    try {
      const body = replica.pending();
      const reply = await request<{ ops?: unknown }>('replica/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 15000);
      replica.acknowledge(body.ops);
      const changed = replica.applyRemote(reply.ops);
      failures = 0;
      retryAt = 0;
      config = { ...config, lastSync: Date.now() };
      writeJson(configFile, config);
      setStatus({ state: 'idle', lastSync: config.lastSync, error: undefined });
      return changed;
    } catch (error) {
      failures += 1;
      retryAt = Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** (failures - 1));
      setStatus({ state: 'offline', error: String((error as Error)?.message ?? error) });
      return [];
    } finally {
      syncing = undefined;
    }
  })();
  return syncing;
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Sync a little after a local change, batching the progress saves made during playback. */
export function syncSoon(delayMs = 20_000) {
  if (!config.baseUrl) return;
  setStatus({});
  clearTimeout(soon);
  soon = setTimeout(() => { void sync(); }, delayMs);
}
