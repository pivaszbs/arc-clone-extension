import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Series downloads are done by Chrome on the Mac (it is signed in to Anime365). This device only
 * sends the series link to the Mac's library server and shows the progress Chrome reports there.
 * Series asked for from here are remembered, so auto sync copies their first episodes over even
 * before anything has been watched.
 */

export type MacDownload = {
  id: string;
  url: string;
  title?: string;
  from?: string;
  folder?: string;
  state: 'pending' | 'planning' | 'downloading' | 'done' | 'failed';
  detail?: string;
  done?: number;
  total?: number;
  createdAt?: number;
};

const stateDir = new Directory(Paths.document, '.anime-study');
const mineFile = new File(stateDir, 'requested-downloads.json');
const deviceName = Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';

function readMine(): string[] {
  try {
    if (mineFile.exists) {
      const saved = JSON.parse(mineFile.textSync()) as { ids?: unknown };
      if (Array.isArray(saved.ids)) return saved.ids.filter((id): id is string => typeof id === 'string');
    }
  } catch { /* Start over. */ }
  return [];
}

function remember(id: string) {
  try {
    if (!stateDir.exists) stateDir.create({ intermediates: true });
    mineFile.write(JSON.stringify({ ids: [...new Set([...readMine(), id])].slice(-50) }));
  } catch { /* Auto sync just won't prefetch this one. */ }
}

/** The series page for a browser address, or null when it isn't an Anime365 series or episode. */
export function seriesLinkFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const anime365 = ['smotret-anime.com', 'smotret-anime.net'].some(domain => host === domain || host.endsWith('.' + domain));
    return parsed.protocol === 'https:' && anime365 && /^\/catalog\/[\w-]+-\d+(?:\/|$)/.test(parsed.pathname) ? parsed.href : null;
  } catch { return null; }
}

export async function listMacDownloads(serverUrl: string): Promise<MacDownload[]> {
  const response = await fetch(`${serverUrl}downloads`);
  if (!response.ok) throw new Error(`The Mac answered ${response.status}. Update and restart npm run mac:up.`);
  const { requests = [] } = await response.json() as { requests?: MacDownload[] };
  return requests;
}

/** Ask the Mac to download the series at `url` (a series, episode or edition page). */
export async function requestMacDownload(serverUrl: string, url: string, title: string) {
  const response = await fetch(`${serverUrl}downloads/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title, from: deviceName }),
  });
  const body = await response.json().catch(() => ({})) as { request?: MacDownload; error?: string };
  if (!response.ok || !body.request) throw new Error(body.error || `The Mac answered ${response.status}.`);
  remember(body.request.id);
  return body.request;
}

/** Library folders of series asked for from this device, for auto sync. */
export async function requestedFolders(serverUrl: string): Promise<Set<string>> {
  const mine = new Set(readMine());
  if (!mine.size) return new Set();
  const requests = await listMacDownloads(serverUrl).catch(() => []);
  return new Set(requests.filter(item => mine.has(item.id) && item.folder).map(item => item.folder!));
}
