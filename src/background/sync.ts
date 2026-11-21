import {
  arcStateToCraSidebar,
  craSnapshotToArcState,
  isoNoMs,
  parsePairingUri,
  stableUuid,
  type CraSyncBoost,
  type CraSyncRoute,
  type CraSyncSiteSearch,
  type CraSyncSnapshot
} from '../shared/arc-sync';
import { pinnedLinks } from '../shared/pins';
import type { ArcState, SyncConfig, TabInfo } from '../shared/types';

export const SYNC_ALARM_NAME = 'arc-live-sync';
export const NATIVE_SYNC_HOST = 'local.arcclone.sync';

const DEVICE_ID_KEY = 'arc_sync_device_id';
const BASE_DOC_KEY = 'arc_sync_base_doc';
const SYNC_ACTIVE_URLS_MS = 4000;

export type StateLoader = () => Promise<ArcState>;
export type StateSaver = (next: ArcState, opts?: { fromSync?: boolean }) => Promise<void>;
export type TabsProvider = () => Promise<TabInfo[]>;
export type HandoffHandler = (handoff: { url: string; title: string; spaceId?: string }) => Promise<void>;

export async function ensureDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  const existing = stored[DEVICE_ID_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const created = `chrome-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: created });
  return created;
}

export class ArcLiveSyncClient {
  private loadState: StateLoader;
  private saveState: StateSaver;
  private getTabs: TabsProvider;
  private onHandoff: HandoffHandler;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fastPollTimer: ReturnType<typeof setInterval> | null = null;
  private deliveredHandoffs = new Set<string>();
  private syncing = false;
  private pendingPush = false;
  private syncEnabled = false;

  constructor(opts: {
    loadState: StateLoader;
    saveState: StateSaver;
    getTabs: TabsProvider;
    onHandoff: HandoffHandler;
  }) {
    this.loadState = opts.loadState;
    this.saveState = opts.saveState;
    this.getTabs = opts.getTabs;
    this.onHandoff = opts.onHandoff;
  }

  start(): void {
    if (chrome.alarms) {
      void chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
    }
    void this.tryAutoPair();
  }

  setFastPolling(active: boolean): void {
    if (active && this.syncEnabled && !this.fastPollTimer && typeof setInterval === 'function') {
      this.fastPollTimer = setInterval(() => {
        void this.pullIfChanged();
      }, SYNC_ACTIVE_URLS_MS);
    } else if (!active && this.fastPollTimer && typeof clearInterval === 'function') {
      clearInterval(this.fastPollTimer);
      this.fastPollTimer = null;
    }
  }

  schedulePush(): void {
    if (!this.syncEnabled || typeof setTimeout !== 'function') return;
    if (this.debounceTimer && typeof clearTimeout === 'function') clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow('push');
    }, 500);
  }

  async pairFromNativeHost(): Promise<{ ok: boolean; error?: string; state?: ArcState }> {
    try {
      const api = chrome.runtime as typeof chrome.runtime & {
        sendNativeMessage?: (app: string, msg: unknown) => Promise<{ ok?: boolean; endpoint?: { urls?: string[]; token?: string; deviceName?: string }; error?: string }>;
      };
      if (!api.sendNativeMessage) {
        return { ok: false, error: 'Native messaging unavailable' };
      }
      const res = await api.sendNativeMessage(NATIVE_SYNC_HOST, { type: 'GET_ENDPOINT' });
      const ep = res?.endpoint;
      if (!res?.ok || !ep?.token || !Array.isArray(ep.urls) || ep.urls.length === 0) {
        return { ok: false, error: res?.error || 'Cra desktop app sync endpoint not running' };
      }
      const next = await this.configure({
        urls: ep.urls,
        token: ep.token,
        peerName: ep.deviceName || 'Mac',
        enabled: true
      });
      return { ok: true, state: next };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Native host unreachable (run npm run install:arc-sync)'
      };
    }
  }

  async tryAutoPair(): Promise<void> {
    const state = await this.loadState();
    if (state.syncConfig?.enabled && state.syncConfig.urls.length && state.syncConfig.token) {
      this.syncEnabled = true;
      this.setFastPolling(true);
      await this.pullIfChanged();
      return;
    }
    await this.pairFromNativeHost();
  }

  async pairFromUri(uri: string): Promise<ArcState> {
    const parsed = parsePairingUri(uri);
    if (!parsed) throw new Error('Invalid arcsync://pair link');
    return this.configure({
      urls: parsed.urls,
      token: parsed.token,
      peerName: parsed.name,
      enabled: true
    });
  }

  async configure(opts: {
    urls: string[];
    token: string;
    peerName?: string;
    enabled?: boolean;
  }): Promise<ArcState> {
    const urls = opts.urls.map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
    const token = opts.token.trim();
    if (!urls.length || !token) throw new Error('Enter both server URL and pairing token');
    const deviceId = await ensureDeviceId();
    const state = await this.loadState();
    const syncConfig: SyncConfig = {
      enabled: opts.enabled !== false,
      urls,
      token,
      deviceId,
      deviceName: state.syncConfig?.deviceName || 'Chrome',
      peerName: opts.peerName || state.syncConfig?.peerName || 'Mac'
    };
    const next: ArcState = { ...state, syncConfig };
    this.syncEnabled = syncConfig.enabled;
    this.setFastPolling(syncConfig.enabled);
    await this.saveState(next, { fromSync: true });
    return this.syncNow('full');
  }

  async disconnect(): Promise<ArcState> {
    const state = await this.loadState();
    this.syncEnabled = false;
    this.setFastPolling(false);
    const next: ArcState = {
      ...state,
      remoteDevices: [],
      syncConfig: state.syncConfig ? { ...state.syncConfig, enabled: false } : undefined
    };
    await this.saveState(next, { fromSync: true });
    return next;
  }

  async sendTabHandoff(url: string, title: string, spaceId?: string, targetDeviceId?: string): Promise<void> {
    const state = await this.loadState();
    const cfg = state.syncConfig;
    if (!cfg?.enabled || !cfg.urls.length || !cfg.token) {
      throw new Error('Pair Chrome with Mac or iPhone first');
    }
    const deviceId = cfg.deviceId || (await ensureDeviceId());
    const payload = {
      id: crypto.randomUUID(),
      url,
      title,
      spaceID: spaceId ? stableUuid(spaceId) : undefined,
      fromDeviceID: deviceId,
      fromDeviceName: cfg.deviceName || 'Chrome',
      targetDeviceID: targetDeviceId || undefined,
      createdAt: isoNoMs()
    };
    const res = await this.fetchFirst(cfg, '/v1/handoff', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Handoff failed (${res.status})`);
  }

  async pullIfChanged(): Promise<ArcState | null> {
    const state = await this.loadState();
    const cfg = state.syncConfig;
    if (!cfg?.enabled || !cfg.urls.length || !cfg.token || this.syncing) return null;
    try {
      const deviceId = cfg.deviceId || (await ensureDeviceId());
      const since = cfg.lastRevision ? `&since=${cfg.lastRevision}` : '';
      const q = `/v1/snapshot?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(cfg.deviceName || 'Chrome')}&platform=chrome${since}`;
      const res = await this.fetchFirst(cfg, q, { method: 'GET' });
      if (res.status === 304) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snapshot = (await res.json()) as CraSyncSnapshot;
      const merged = await this.applyRemoteSnapshot(snapshot);
      return merged;
    } catch (error) {
      await this.recordError(error instanceof Error ? error.message : 'Sync unreachable');
      return null;
    }
  }

  async syncNow(mode: 'full' | 'push' = 'full'): Promise<ArcState> {
    const state = await this.loadState();
    const cfg = state.syncConfig;
    if (!cfg?.enabled || !cfg.urls.length || !cfg.token) return state;
    if (this.syncing) {
      this.pendingPush = true;
      return state;
    }
    this.syncing = true;
    try {
      const deviceId = cfg.deviceId || (await ensureDeviceId());
      const openTabs = await this.getTabs();
      const doc = arcStateToCraSidebar(state);
      const baseStored = (await chrome.storage.local.get(BASE_DOC_KEY))[BASE_DOC_KEY];

      const routes: CraSyncRoute[] = (state.routingRules || []).map((r) => ({
        id: stableUuid(r.id),
        pattern: r.pattern,
        spaceID: stableUuid(r.spaceId),
        matchStyle: 'contains',
        littleWindow: false,
        updatedAt: isoNoMs()
      }));
      const siteSearches: CraSyncSiteSearch[] = (state.siteSearches || []).map((s) => ({
        id: s.id,
        shortcut: s.shortcut,
        label: s.name,
        urlTemplate: s.url
      }));
      const boosts: CraSyncBoost[] = (state.boosts || []).map((b) => ({
        id: stableUuid(b.id),
        host: b.host,
        name: b.name || b.host,
        enabled: b.enabled,
        hue: b.hue || 0,
        strength: (b.tintIntensity || 0) / 100,
        invert: Boolean(b.invert),
        contrast: b.contrast ?? 50,
        brightness: b.brightness ?? 50,
        saturation: b.saturate ?? 50,
        textScale: b.fontSize ?? 100,
        textCase: b.textCase || 'none',
        zapped: b.zappedSelectors || [],
        css: b.css || '',
        js: b.js || ''
      }));

      const activeTabs = openTabs
        .filter((t) => t.url.startsWith('http'))
        .slice(0, 30)
        .map((t) => ({
          id: stableUuid(`tab:${t.url}`),
          url: t.url,
          title: t.title,
          spaceID: stableUuid(t.spaceId),
          fromDeviceID: deviceId,
          fromDeviceName: cfg.deviceName || 'Chrome',
          createdAt: isoNoMs()
        }));

      const res = await this.fetchFirst(cfg, '/v1/sync', {
        method: 'POST',
        body: JSON.stringify({
          device: {
            id: deviceId,
            name: cfg.deviceName || 'Chrome',
            platform: 'chrome',
            lastSeenAt: isoNoMs(),
            activeSpaceID: stableUuid(state.activeSpaceId),
            activeTabs
          },
          baseRevision: mode === 'push' ? cfg.lastRevision : undefined,
          baseDocument: baseStored || undefined,
          document: doc,
          routes,
          siteSearches,
          boosts
        })
      });
      if (!res.ok) throw new Error(`Sync HTTP ${res.status}`);
      const payload = (await res.json()) as { snapshot: CraSyncSnapshot; merged: boolean };
      const next = await this.applyRemoteSnapshot(payload.snapshot);
      await chrome.storage.local.set({ [BASE_DOC_KEY]: payload.snapshot.document });
      return next;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Sync failed';
      await this.recordError(msg);
      throw new Error(msg);
    } finally {
      this.syncing = false;
      if (this.pendingPush) {
        this.pendingPush = false;
        void this.syncNow('push');
      }
    }
  }

  private async applyRemoteSnapshot(snapshot: CraSyncSnapshot): Promise<ArcState> {
    const latest = await this.loadState();
    const next = craSnapshotToArcState(snapshot, latest);
    await chrome.storage.local.set({ [BASE_DOC_KEY]: snapshot.document });
    await this.saveState(next, { fromSync: true });

    for (const h of snapshot.pendingHandoffs || []) {
      if (this.deliveredHandoffs.has(h.id)) continue;
      this.deliveredHandoffs.add(h.id);
      if (this.deliveredHandoffs.size > 100) {
        const first = this.deliveredHandoffs.values().next().value;
        if (first) this.deliveredHandoffs.delete(first);
      }
      await this.onHandoff({ url: h.url, title: h.title, spaceId: h.spaceID });
    }
    return next;
  }

  private async recordError(message: string): Promise<void> {
    const state = await this.loadState();
    if (!state.syncConfig) return;
    if (state.syncConfig.lastError === message) return;
    await this.saveState(
      { ...state, syncConfig: { ...state.syncConfig, lastError: message } },
      { fromSync: true }
    );
  }

  private async fetchFirst(
    cfg: SyncConfig,
    pathAndQuery: string,
    init: RequestInit
  ): Promise<Response> {
    let lastErr: unknown;
    for (const base of cfg.urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${base.replace(/\/+$/, '')}${pathAndQuery}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.token}`,
            ...(init.headers || {})
          }
        });
        clearTimeout(timer);
        if (res.status === 401) throw new Error('Invalid pairing token — re-pair with Mac');
        return res;
      } catch (error) {
        clearTimeout(timer);
        lastErr = error;
        if (error instanceof Error && error.message.includes('Invalid pairing token')) throw error;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All sync URLs unreachable');
  }
}

export function exportArcSidebarBundle(state: ArcState): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: isoNoMs(),
      document: arcStateToCraSidebar(state),
      spaces: state.spaces,
      routingRules: state.routingRules || [],
      siteSearches: state.siteSearches || [],
      boosts: state.boosts || []
    },
    null,
    2
  );
}

export function extractUrlsCountFromState(state: ArcState): number {
  return state.spaces.reduce(
    (sum, s) => sum + (s.favorites?.length || 0) + pinnedLinks(s.pinnedItems).length,
    0
  );
}
