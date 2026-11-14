/**
 * What the Mac server reports at status.json (native/tv/serve.py `status()`), and the wording both
 * dashboards use for it — the phone's Server tab and the extension's Pipelines screen.
 */

export type WorkerNode = {
  nodeId: string; nodeName: string; platform?: string; status: string;
  currentSeries?: string | null; currentEpisode?: string | null; progress?: number;
};
export type WorkerJob = { jobId: string; kind?: string; seriesName: string; episode: string; status: string; nodeName?: string; progress?: number };
export type StageCounts = { pending: number; inProgress: number; done: number; retrying: number; quarantined: number };
export type Quarantined = { seriesName: string; episode: string; attempts: number; error?: string | null };

export type ServerStatus = {
  version: number;
  serverTime: number;
  detectorVersion?: number;
  addresses: string[];
  tailscale: { running: boolean; name: string | null };
  library: {
    series: number; episodes: number; withTimings: number;
    perSeries: { folder: string; title: string; episodes: number; withTimings: number }[];
  };
  tv: { active: boolean; seriesLabel?: string; episodeLabel?: string; paused?: boolean; position?: number; duration?: number };
  liveConnections: number;
  devices: { node: string; kind: string; lastSync: number; secondsAgo: number }[];
  workers: {
    nodes: WorkerNode[];
    counts: { pending: number; inProgress: number; completed: number; failed: number; quarantined?: number; retrying?: number; total: number };
    stages: Record<string, StageCounts>;
    tvBusy: boolean;
    jobs: WorkerJob[];
    next: { seriesName?: string; episode?: string; kind?: string }[];
    quarantinedEpisodes: Quarantined[];
  };
};

/** Fetch the summary. Resolves null when the server is an older version without status.json. */
export async function fetchServerStatus(baseUrl: string, timeoutMs = 6000): Promise<ServerStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}status.json`, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The Mac answered ${response.status}`);
    const data = await response.json() as ServerStatus;
    return data && typeof data === 'object' && data.library && data.workers ? data : null;
  } finally {
    clearTimeout(timer);
  }
}

export function ago(seconds: number) {
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function clock(seconds?: number) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "Смотреть аниме Hell Mode … - 42441 - StudioBand" → "Hell Mode …". */
export function seriesLabel(folder?: string | null) {
  if (!folder) return '';
  return folder.replace(/^Смотреть аниме\s+/i, '').replace(/\s+онлайн(?=\s+-|$)/i, '').replace(/\s+-\s+\d+\s+-\s+.*$/, '').trim() || folder;
}

/** "Episode 008 - 5940936.mp4" → "Episode 8". */
export function episodeLabel(file?: string | null) {
  if (!file) return '';
  const match = /^Episode\s+(\d+)\b/i.exec(file);
  return match ? `Episode ${Number(match[1])}` : file.replace(/\.[^.]+$/, '');
}

/** How the device reached the Mac, from the address in use. */
export function routeLabel(baseUrl: string, status?: ServerStatus | null) {
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  if (host === '127.0.0.1' || host === 'localhost') return 'This Mac';
  if (/\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || (status?.tailscale.name && host === status.tailscale.name)) return 'Tailscale';
  return 'Home network';
}

export type Tone = 'ok' | 'warn' | 'danger' | 'idle';

/** One sentence and a colour for the top of a dashboard. */
export function headline(status: ServerStatus | null | undefined, reachable: boolean): { tone: Tone; title: string; detail: string } {
  if (!reachable) return { tone: 'danger', title: 'Mac not reachable', detail: 'Playing from this device. Changes sync when the Mac is back.' };
  if (!status) return { tone: 'ok', title: 'Mac connected', detail: 'Update the Mac server to see queue, devices and sync details.' };
  const { workers, library } = status;
  const failing = workers.quarantinedEpisodes.length;
  const active = workers.jobs.filter(job => job.status === 'in_progress' || job.status === 'working').length || workers.counts.inProgress;
  const waiting = workers.counts.pending;
  if (failing) return { tone: 'danger', title: `${failing} episode${failing === 1 ? '' : 's'} need attention`, detail: 'Skip detection failed several times. Retry below.' };
  if (active) return { tone: 'ok', title: `Detecting skips · ${active} running`, detail: `${waiting} waiting · ${library.withTimings} of ${library.episodes} episodes ready` };
  if (waiting && !workers.nodes.length) return { tone: 'warn', title: `${waiting} episode${waiting === 1 ? '' : 's'} waiting, no worker`, detail: 'Start the worker on the Mac (npm run mac:up) or turn on this device below.' };
  if (waiting && workers.tvBusy) return { tone: 'ok', title: 'Paused while the TV plays', detail: `${waiting} episode${waiting === 1 ? '' : 's'} waiting` };
  if (waiting) return { tone: 'ok', title: `${waiting} episode${waiting === 1 ? '' : 's'} waiting`, detail: `${library.withTimings} of ${library.episodes} episodes ready` };
  return { tone: 'ok', title: 'Everything is up to date', detail: `${library.withTimings} of ${library.episodes} episodes have skip timings` };
}

export function nodeLine(node: WorkerNode) {
  if (node.status === 'working' && node.currentEpisode) {
    return `${seriesLabel(node.currentSeries)} · ${episodeLabel(node.currentEpisode)} · ${Math.round(node.progress ?? 0)}%`;
  }
  return node.status === 'idle' ? 'Idle' : node.status === 'offline' ? 'Offline' : node.status;
}

export function nodeTone(node: WorkerNode): Tone {
  return node.status === 'working' ? 'ok' : node.status === 'idle' ? 'idle' : 'danger';
}
