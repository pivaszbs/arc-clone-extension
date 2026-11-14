import { setLocal } from './replica';
import { DEFAULT_TV_SERVER_URL } from './storage';

export { DEFAULT_TV_SERVER_URL };

export type TvWsState = 'connecting' | 'connected' | 'disconnected';
export type TvHttpState = 'idle' | 'checking' | 'ok' | 'error';
export type TvHttpStatus = { state: TvHttpState; statusCode?: number; error?: string };
export type PipelineEvent = { id: number; time: string; kind: string; detail: string };
export type ScanProgressInfo = { seriesName?: string; done: number; total: number } | null;

export type WorkerNodeInfo = {
  nodeId: string;
  nodeName: string;
  platform: string;
  status: 'working' | 'idle' | 'offline';
  currentJobId?: string | null;
  currentSeries?: string | null;
  currentEpisode?: string | null;
  progress: number;
  lastHeartbeat: number;
};

export type WorkerQueueCounts = {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  quarantined?: number;
  retrying?: number;
  total: number;
};

/** An episode the coordinator gave up on after repeated failures (until retried). */
export type QuarantinedEpisode = {
  seriesName: string;
  episode: string;
  attempts: number;
  error?: string | null;
};

export type WorkerJobInfo = {
  jobId: string;
  series: number;
  seriesName: string;
  episode: string;
  status: 'in_progress' | 'completed' | 'failed';
  nodeId: string;
  nodeName: string;
  progress: number;
  error?: string | null;
};

export type WorkerStatusPayload = {
  nodes: WorkerNodeInfo[];
  counts: WorkerQueueCounts;
  jobs: WorkerJobInfo[];
  quarantinedEpisodes?: QuarantinedEpisode[];
};

export type TvPlaybackState = {
  active: boolean;
  series?: number;
  seriesName?: string;
  seriesLabel?: string;
  episode?: string;
  episodeLabel?: string;
  paused?: boolean;
  position?: number;
  duration?: number;
  subtitles?: boolean;
  autoplay?: boolean;
  skipAvailable?: boolean;
};

export type TvControlCommand =
  | {
      action:
        | 'play'
        | 'pause'
        | 'toggle'
        | 'next'
        | 'prev'
        | 'skip'
        | 'stop'
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'ok'
        | 'back'
        | 'menu'
        | 'subtitles'
        | 'autoplay'
        | 'markWatched'
        | 'restart';
    }
  | { action: 'markWatched'; finished?: boolean }
  | { action: 'seekBy'; delta: number }
  | { action: 'seek'; position: number }
  | { action: 'playEpisode'; series?: number; seriesName?: string; episode: string };

/** Normalize a user-provided Mac TV companion server URL. */
export function normalizeTvServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_TV_SERVER_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`;
}

/** WebSocket + HTTP sync client for the Mac TV companion server. */
export class TvSyncClient {
  private ws: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = true;
  private nextEventId = 1;
  private state: TvWsState = 'disconnected';
  private events: PipelineEvent[] = [];
  private lastTvActive = false;
  private lastTvEpisode = '';

  constructor(
    private readonly onState: (state: TvWsState) => void,
    private readonly onEvents: (events: PipelineEvent[]) => void,
    private readonly baseUrl: () => string = () => DEFAULT_TV_SERVER_URL,
    private readonly onSync?: (msg: Record<string, unknown>) => void,
    private readonly onScanProgress?: (info: ScanProgressInfo) => void,
    private readonly onHttpStatus?: (status: TvHttpStatus) => void,
    private readonly onTvState?: (state: TvPlaybackState) => void,
    private readonly onWorkerStatus?: (status: WorkerStatusPayload) => void,
  ) {}

  log(kind: string, detail: string) {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.events = [{ id: this.nextEventId++, time, kind, detail }, ...this.events].slice(0, 20);
    this.onEvents(this.events);
  }

  clearEvents() {
    this.events = [];
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
      const url = normalizeTvServerUrl(this.baseUrl());
      this.setState('connecting');
      const socket = new WebSocket(`${url.replace(/^http/i, 'ws')}ws`);
      this.ws = socket;
      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.setState('connected');
        this.log('WebSocket', `Connected to ${url}`);
        void this.fetchAutoplay();
      };
      socket.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type === 'scan_progress' && typeof msg.done === 'number' && typeof msg.total === 'number') {
            const seriesName = typeof msg.seriesName === 'string' ? msg.seriesName : undefined;
            this.onScanProgress?.(msg.done < msg.total ? { seriesName, done: msg.done, total: msg.total } : null);
            this.log('Scan', `${seriesName || 'Series'}: ${msg.done}/${msg.total}`);
          } else if (msg.type === 'sync') {
            this.onSync?.(msg);
            if (typeof msg.episode === 'string') this.log('Broadcast', `Synced ${msg.episode}`);
            else if (typeof msg.autoplay === 'boolean') this.log('Broadcast', `TV autoplay ${msg.autoplay ? 'on' : 'stopped'}`);
            else if (typeof msg.seriesName === 'string') this.log('Broadcast', `Updated ${msg.seriesName}`);
          } else if (msg.type === 'tv_state') {
            const nextState = this.parseTvState(msg);
            this.handleTvState(nextState);
          } else if (msg.type === 'worker_status' && Array.isArray(msg.nodes) && msg.counts) {
            this.onWorkerStatus?.({
              nodes: msg.nodes as WorkerNodeInfo[],
              counts: msg.counts as WorkerQueueCounts,
              jobs: Array.isArray(msg.jobs) ? (msg.jobs as WorkerJobInfo[]) : [],
              quarantinedEpisodes: Array.isArray(msg.quarantinedEpisodes)
                ? (msg.quarantinedEpisodes as QuarantinedEpisode[])
                : [],
            });
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.ws = undefined;
        this.setState('disconnected');
        if (this.active) this.timer = setTimeout(() => this.connect(), 4000);
      };
      socket.onerror = () => { /* onclose handles reconnect */ };
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
    const url = normalizeTvServerUrl(this.baseUrl());
    this.onHttpStatus?.({ state: 'checking' });
    try {
      const res = await fetch(`${url}catalog.json`);
      if (!res.ok) {
        this.onHttpStatus?.({ state: 'error', statusCode: res.status, error: `HTTP ${res.status}` });
        return;
      }
      this.onHttpStatus?.({ state: 'ok', statusCode: res.status });
      const data = await res.json() as { autoplay?: boolean; tvState?: Record<string, unknown> };
      if (typeof data.autoplay === 'boolean') this.onSync?.({ type: 'sync', autoplay: data.autoplay });
      if (data.tvState && typeof data.tvState === 'object') {
        this.handleTvState(this.parseTvState(data.tvState));
      }
      void this.fetchWorkerStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.onHttpStatus?.({ state: 'error', error: msg });
    }
  }

  async fetchWorkerStatus() {
    const url = normalizeTvServerUrl(this.baseUrl());
    try {
      const res = await fetch(`${url}worker/status`);
      if (!res.ok) return;
      const data = (await res.json()) as Partial<WorkerStatusPayload>;
      if (Array.isArray(data.nodes) && data.counts) {
        this.onWorkerStatus?.({
          nodes: data.nodes,
          counts: data.counts,
          jobs: Array.isArray(data.jobs) ? data.jobs : [],
          quarantinedEpisodes: Array.isArray(data.quarantinedEpisodes) ? data.quarantinedEpisodes : [],
        });
      }
    } catch { /* Ignore background status poll errors. */ }
  }

  /** Release quarantined episodes back into the worker queue: one episode, or all of them. */
  async retryWorkerEpisodes(target: { seriesName: string; episode: string } | { all: true }) {
    const url = normalizeTvServerUrl(this.baseUrl());
    try {
      const res = await fetch(`${url}worker/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      if (!res.ok) {
        this.log('Worker', `Retry failed (HTTP ${res.status})`);
        return;
      }
      const label = 'all' in target ? 'all quarantined episodes' : target.episode;
      this.log('Worker', `Retrying ${label}`);
    } catch (error) {
      this.log('Worker', `Retry failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.fetchWorkerStatus();
  }

  async pushSync(payload: Record<string, unknown>) {
    const url = normalizeTvServerUrl(this.baseUrl());
    if (payload.themes && typeof payload.seriesName === 'string' && payload.seriesName && typeof payload.episode === 'string') {
      setLocal(`ep/${payload.seriesName}/${payload.episode}/themes`, payload.themes);
    }
    try {
      const res = await fetch(`${url}sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.onHttpStatus?.({ state: 'error', statusCode: res.status, error: `HTTP ${res.status}` });
        return;
      }
      this.onHttpStatus?.({ state: 'ok', statusCode: res.status });
      if (payload.themes) {
        const ep = typeof payload.episode === 'string' ? payload.episode : 'episode';
        this.log('TV Sync', `${ep} → pushed skip timings`);
      } else if (typeof payload.autoplay === 'boolean') {
        this.log('TV Setting', `Autoplay ${payload.autoplay ? 'enabled' : 'stopped'}`);
      } else if (typeof payload.playingEpisode === 'string') {
        this.log('TV Sync', `Playing ${payload.playingEpisode}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.onHttpStatus?.({ state: 'error', error: msg });
    }
  }

  private parseTvState(raw: Record<string, unknown>): TvPlaybackState {
    return {
      active: Boolean(raw.active),
      series: typeof raw.series === 'number' ? raw.series : undefined,
      seriesName: typeof raw.seriesName === 'string' ? raw.seriesName : undefined,
      seriesLabel: typeof raw.seriesLabel === 'string' ? raw.seriesLabel : undefined,
      episode: typeof raw.episode === 'string' ? raw.episode : undefined,
      episodeLabel: typeof raw.episodeLabel === 'string' ? raw.episodeLabel : undefined,
      paused: typeof raw.paused === 'boolean' ? raw.paused : undefined,
      position: typeof raw.position === 'number' ? raw.position : undefined,
      duration: typeof raw.duration === 'number' ? raw.duration : undefined,
      subtitles: typeof raw.subtitles === 'boolean' ? raw.subtitles : undefined,
      autoplay: typeof raw.autoplay === 'boolean' ? raw.autoplay : undefined,
      skipAvailable: typeof raw.skipAvailable === 'boolean' ? raw.skipAvailable : undefined,
    };
  }

  private handleTvState(next: TvPlaybackState) {
    if (next.active !== this.lastTvActive || (next.active && next.episode && next.episode !== this.lastTvEpisode)) {
      this.log('TV', next.active ? `Playing ${next.episodeLabel || next.episode || 'on TV'}` : 'Playback stopped');
      this.lastTvActive = next.active;
      this.lastTvEpisode = next.episode || '';
    }
    this.onTvState?.(next);
  }

  sendTvControl(command: TvControlCommand) {
    const payload: Record<string, unknown> = { type: 'tv_control', ...command };
    if (command.action === 'playEpisode') {
      this.log('TV Remote', `Play ${command.episode}`);
    } else if (command.action === 'seekBy') {
      this.log('TV Remote', `Seek ${command.delta > 0 ? `+${command.delta}` : command.delta}s`);
    } else {
      this.log('TV Remote', command.action);
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSocket(payload);
      return;
    }
    void this.pushSync(payload);
  }

  destroy() {
    this.active = false;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    if (this.state !== 'disconnected') this.setState('disconnected');
  }
}
