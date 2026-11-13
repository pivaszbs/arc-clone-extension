import type { VideoThemes } from './video-themes';
import type { DownloadFolder } from './offline-library';

export type TvWsState = 'connecting' | 'connected' | 'disconnected';
export type PipelineEvent = { id: number; time: string; kind: string; detail: string };
export type EpisodeProgress = { position: number; watchedAt: number; finished: boolean };

export type TvPlaybackData = {
  version: 1;
  title: string;
  endingAction: string;
  autoSkip: Record<string, boolean>;
  episodes: Record<string, { themes: VideoThemes; progress?: EpisodeProgress }>;
};

export const DEFAULT_TV_SERVER_URL = 'http://10.131.140.3:46158/cf7f1d1d391d8231/';

/** Resolve the Mac TV companion base URL from storage or default LAN address. */
export function tvServerBaseUrl(): string {
  try {
    const custom = localStorage.getItem('arc-tv-server-url');
    if (custom && /^https?:\/\//.test(custom)) return custom.endsWith('/') ? custom : `${custom}/`;
  } catch { /* Fall back to the default Mac TV server URL. */ }
  return DEFAULT_TV_SERVER_URL;
}

/** Build the `anime-study-tv.json` payload for a series folder. */
export function buildTvPlaybackData(
  targetEpisodes: { video: File }[],
  title: string,
  readThemes: (file: File) => VideoThemes,
  readProgress: (file: File) => EpisodeProgress | undefined
): TvPlaybackData {
  const legacy = localStorage.getItem('arc-offline-auto-skip') !== 'off';
  const autoSkip = Object.fromEntries((['recap', 'op', 'ed'] as const).map(part => {
    const setting = localStorage.getItem(`arc-offline-auto-skip-${part}`);
    return [part, setting === null ? part === 'recap' || legacy : setting === 'on'];
  }));
  return {
    version: 1,
    title,
    endingAction: localStorage.getItem('arc-offline-ending-action') || 'auto',
    autoSkip,
    episodes: Object.fromEntries(targetEpisodes.map(({ video }) => [
      video.name, { themes: readThemes(video), progress: readProgress(video) }
    ]))
  };
}

/** Persist `anime-study-tv.json` into the selected series directory when write access is granted. */
export async function writeTvPlaybackToFolder(
  folder: DownloadFolder | undefined,
  folderGranted: boolean,
  seriesKey: string | undefined,
  data: TvPlaybackData
): Promise<boolean> {
  if (!folderGranted || !folder || !seriesKey || seriesKey === '.') return false;
  try {
    const handle = folder as unknown as FileSystemDirectoryHandle & {
      requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    if (handle.requestPermission && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
    const dir = await handle.getDirectoryHandle(seriesKey);
    const fileHandle = await dir.getFileHandle('anime-study-tv.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/** Deep WebSocket + HTTP sync client for the Mac TV companion server. */
export class TvSyncClient {
  private ws: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = true;
  private nextEventId = 1;
  private state: TvWsState = 'disconnected';
  private events: PipelineEvent[] = [];

  constructor(
    private readonly onState: (state: TvWsState) => void,
    private readonly onEvents: (events: PipelineEvent[]) => void,
    private readonly baseUrl: () => string = tvServerBaseUrl,
    private readonly onSync?: (msg: Record<string, unknown>) => void
  ) {}

  log(kind: string, detail: string) {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.events = [{ id: this.nextEventId++, time, kind, detail }, ...this.events].slice(0, 14);
    this.onEvents(this.events);
  }

  private setState(next: TvWsState) {
    this.state = next;
    this.onState(next);
  }

  connect() {
    clearTimeout(this.timer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = undefined;
    }
    if (!this.active) return;
    try {
      const url = this.baseUrl();
      this.setState('connecting');
      const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws`);
      this.ws = socket;
      socket.addEventListener('open', () => {
        if (this.ws !== socket) return;
        this.setState('connected');
        this.log('WebSocket', `Connected to ${url}`);
        void this.fetchAutoplay();
      });
      socket.addEventListener('message', event => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type === 'sync') {
            this.onSync?.(msg);
            if (typeof msg.episode === 'string') this.log('Broadcast', `Synced ${msg.episode}`);
            else if (typeof msg.autoplay === 'boolean') this.log('Broadcast', `TV autoplay ${msg.autoplay ? 'on' : 'stopped'}`);
          }
        } catch { /* ignore malformed frames */ }
      });
      socket.addEventListener('close', () => {
        if (this.ws !== socket) return;
        this.ws = undefined;
        this.setState('disconnected');
        if (this.active) this.timer = setTimeout(() => this.connect(), 4000);
      });
      socket.addEventListener('error', () => { /* close fires next */ });
    } catch {
      this.setState('disconnected');
    }
  }

  sendSocket(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(payload)); } catch { /* Ignore socket write errors. */ }
    }
  }

  async fetchAutoplay() {
    try {
      const res = await fetch(`${this.baseUrl()}catalog.json`);
      if (!res.ok) return;
      const data = await res.json() as { autoplay?: boolean };
      if (typeof data.autoplay === 'boolean') this.onSync?.({ type: 'sync', autoplay: data.autoplay });
    } catch { /* TV server may not be running locally. */ }
  }

  async pushSync(payload: Record<string, unknown>) {
    try {
      const res = await fetch(`${this.baseUrl()}sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok && payload.themes) {
        const ep = typeof payload.episode === 'string' ? payload.episode : 'episode';
        this.log('TV Sync', `${ep} → pushed skip timings`);
      } else if (res.ok && typeof payload.autoplay === 'boolean') {
        this.log('TV Setting', `Autoplay ${payload.autoplay ? 'enabled' : 'stopped'}`);
      }
    } catch { /* TV server may not be running locally. */ }
  }

  destroy() {
    this.active = false;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    if (this.state !== 'disconnected') this.setState('disconnected');
  }
}
