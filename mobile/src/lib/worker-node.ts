import { Platform } from 'react-native';
import { animeCore, sampleVideoFrames, type VideoFingerprint } from 'react-native-anime-core';

import { getDeviceHealth } from '../../modules/device-health/src';
import { normalizeTvServerUrl } from './tv-sync';

export type PhoneWorkerState = {
  running: boolean;
  currentSeries?: string;
  currentEpisode?: string;
  progress: number;
  lastError?: string;
  /** Why the coordinator gave no job (e.g. "on battery — plug in to help", "too hot", "TV is playing"). */
  waitReason?: string | null;
};

type ClaimedJob = {
  jobId: string;
  series: number;
  seriesName: string;
  episode: string;
  episodeIndex: number;
  url: string;
  durationHint?: number | null;
  referenceSamples?: VideoFingerprint | null;
  referenceEpisode?: { episode: string; episodeIndex: number; url: string } | null;
};

function resolveJobUrl(baseUrl: string, path: string): string {
  const normalized = normalizeTvServerUrl(baseUrl);
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${normalized}${clean}`;
}

export class PhoneWorkerNode {
  private running = false;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeSleep: (() => void) | undefined;
  private readonly nodeId = Platform.OS === 'ios' && Platform.isPad ? 'ios-ipad' : 'ios-iphone';
  private readonly nodeName = Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';

  constructor(
    private readonly baseUrl: () => string,
    private readonly onState: (state: PhoneWorkerState) => void,
    private readonly log: (kind: string, detail: string) => void,
  ) {}

  isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.onState({ running: true, progress: 0 });
    this.log('Worker', `Started ${this.nodeName} worker node`);
    void this.loop();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.sleepTimer);
    this.wakeSleep?.();
    this.wakeSleep = undefined;
    this.onState({ running: false, progress: 0 });
    this.log('Worker', `Stopped ${this.nodeName} worker node`);
  }

  private wait(ms: number) {
    return new Promise<void>(resolve => {
      this.wakeSleep = resolve;
      this.sleepTimer = setTimeout(() => {
        this.wakeSleep = undefined;
        resolve();
      }, ms);
    });
  }

  private async postJson<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${normalizeTvServerUrl(this.baseUrl())}${endpoint}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async reportProgress(job: ClaimedJob, progress: number) {
    this.onState({
      running: this.running,
      currentSeries: job.seriesName,
      currentEpisode: job.episode,
      progress,
    });
    try {
      await this.postJson('worker/progress', {
        jobId: job.jobId,
        nodeId: this.nodeId,
        progress,
      });
    } catch { /* Ignore transient progress post errors. */ }
  }

  private async processJob(baseUrl: string, job: ClaimedJob) {
    await this.reportProgress(job, 10);
    const currentSamples = await sampleVideoFrames(
      resolveJobUrl(baseUrl, job.url),
      job.durationHint ?? 0,
    );
    if (!this.running) return;

    let refSamples = job.referenceSamples ?? null;
    let sampledRef: VideoFingerprint | null = null;
    if (!refSamples && job.referenceEpisode) {
      await this.reportProgress(job, 50);
      sampledRef = await sampleVideoFrames(resolveJobUrl(baseUrl, job.referenceEpisode.url), 0);
      refSamples = sampledRef;
    } else {
      await this.reportProgress(job, 65);
    }
    if (!this.running) return;

    await this.reportProgress(job, 85);
    const matched = refSamples ? animeCore.matchVideoThemes(currentSamples, refSamples) : {};
    const themes: Record<string, { start: number; end: number; source: string }> = {};
    if (matched.op) themes.op = { ...matched.op, source: 'frame-match' };
    if (matched.ed) themes.ed = { ...matched.ed, source: 'frame-match' };

    await this.reportProgress(job, 95);
    const payload: Record<string, unknown> = {
      jobId: job.jobId,
      nodeId: this.nodeId,
      themes,
      samples: { op: currentSamples.op, ed: currentSamples.ed },
    };
    if (sampledRef && job.referenceEpisode) {
      payload.referenceEpisode = job.referenceEpisode.episode;
      payload.referenceSamples = { op: sampledRef.op, ed: sampledRef.ed };
    }
    await this.postJson('worker/complete', payload);

    const foundParts = Object.keys(themes).map(k => k.toUpperCase()).join('+') || 'none';
    this.log('Worker', `${job.episode} → ${foundParts}`);
  }

  private async loop() {
    while (this.running) {
      const baseUrl = this.baseUrl();
      try {
        // Device health lets the coordinator hold work back when the phone is hot, on low battery
        // or in Low Power Mode (PIPELINE.md step 3). Omitted entirely if the native module is missing.
        const health = await getDeviceHealth();
        const res = await this.postJson<{ job: ClaimedJob | null; waitReason?: string | null }>('worker/claim', {
          nodeId: this.nodeId,
          nodeName: this.nodeName,
          platform: 'ios',
          kinds: ['fingerprint'],
          caps: ['avfoundation'],
          ...(health
            ? {
                power: health.power === 'unknown' ? undefined : health.power,
                batteryLevel: health.batteryLevel,
                thermal: health.thermal,
                lowPowerMode: health.lowPowerMode,
              }
            : {}),
        });
        if (!this.running) break;
        const job = res.job;
        if (!job) {
          this.onState({ running: true, progress: 0, waitReason: res.waitReason ?? null });
          // Waiting on device health changes slowly; check less often to save battery.
          const healthWait = res.waitReason && /battery|hot|Low Power/i.test(res.waitReason);
          await this.wait(healthWait ? 30000 : 5000);
          continue;
        }
        this.log('Worker', `Claimed ${job.episode}`);
        try {
          await this.processJob(baseUrl, job);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.onState({ running: this.running, progress: 0, lastError: msg });
          this.log('Worker Error', `${job.episode}: ${msg}`);
          try {
            await this.postJson('worker/complete', {
              jobId: job.jobId,
              nodeId: this.nodeId,
              error: msg,
            });
          } catch { /* Ignore */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onState({ running: this.running, progress: 0, lastError: msg });
        await this.wait(5000);
      }
    }
  }
}
