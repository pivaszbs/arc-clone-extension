/**
 * Master-master library state shared by every Anime Study app (phone, Chrome, TV) and the Mac
 * (native/tv/replica.py, which this mirrors).
 *
 * Every change is an op on a key, stamped with a hybrid logical clock (HLC) and the device's node id.
 * For each key the highest HLC wins, so devices can edit while apart and converge when they meet.
 * Changes are saved on the device first and sent to the Mac when it answers; nothing waits for it.
 *
 * Keys: `ep/<series folder>/<video>/progress|themes`, `series/<folder>/autoSkip`, `settings/autoplay`.
 * HLC (sortable string): "<13-digit ms>:<4-digit counter>:<node id>".
 *
 * Each app supplies only how the state is stored (a file on the phone, localStorage in Chrome and on
 * the TV) — see createReplica().
 */

export type ReplicaOp = { node: string; seq: number; key: string; value: unknown; hlc: string };
type Register = { value: unknown; hlc: string; node: string };
type ReplicaState = {
  nodeId: string;
  lastHlc: string;
  seq: number;
  regs: Record<string, Register>;
  /** This device's newest op per key (older ones are superseded and never needed again). */
  ownOps: Record<string, ReplicaOp>;
  /** Highest seq seen per node. */
  vv: Record<string, number>;
  /** What each Mac (by its node id, so a new address doesn't matter) had at the last sync. */
  peerVv: Record<string, Record<string, number>>;
  /** Which Mac node answered at each base URL. */
  urlNode?: Record<string, string>;
};

export type ChangeListener = (key: string, value: unknown) => void;
type SyncResponse = { node: string; vv: Record<string, number>; ops: ReplicaOp[]; applied?: number };

/** How an app keeps the replica between launches. Both calls may be synchronous and may throw. */
export type ReplicaStore = { read(): string | null; write(text: string): void };

const pad = (n: number, width: number) => String(Math.max(0, Math.floor(n))).padStart(width, '0');
export const makeHlc = (ms: number, counter: number, node: string) => `${pad(ms, 13)}:${pad(counter, 4)}:${node}`;
const hlcMs = (hlc: string) => Number(hlc.split(':', 1)[0]) || 0;
const hlcCounter = (hlc: string) => Number(hlc.split(':')[1]) || 0;

function randomId() {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function createReplica(store: ReplicaStore, nodePrefix: string, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  let state: ReplicaState | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncer: (() => Promise<void>) | null = null;
  const listeners = new Set<ChangeListener>();

  function load(): ReplicaState {
    if (state) return state;
    try {
      const text = store.read();
      if (text) state = JSON.parse(text) as ReplicaState;
    } catch { /* A damaged replica starts fresh; the Mac re-sends everything. */ }
    if (!state || typeof state.nodeId !== 'string') {
      const nodeId = `${nodePrefix}-${randomId()}`;
      state = { nodeId, lastHlc: makeHlc(0, 0, nodeId), seq: 0, regs: {}, ownOps: {}, vv: {}, peerVv: {} };
      persist();
    }
    return state;
  }

  function persist() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      try { store.write(JSON.stringify(state)); } catch { /* Best effort; the next change retries. */ }
    }, 300);
  }

  function tick(physicalMs?: number): string {
    const s = load();
    if (physicalMs !== undefined) {
      const hlc = makeHlc(physicalMs, 0, s.nodeId);
      if (physicalMs > hlcMs(s.lastHlc)) s.lastHlc = hlc;
      return hlc;
    }
    const now = Date.now();
    const lastMs = hlcMs(s.lastHlc);
    s.lastHlc = now > lastMs ? makeHlc(now, 0, s.nodeId) : makeHlc(lastMs, hlcCounter(s.lastHlc) + 1, s.nodeId);
    return s.lastHlc;
  }

  function observe(remoteHlc: string) {
    const s = load();
    if (remoteHlc > s.lastHlc && hlcMs(remoteHlc) <= Date.now() + 86_400_000) {
      s.lastHlc = makeHlc(hlcMs(remoteHlc), hlcCounter(remoteHlc), s.nodeId);
    }
  }

  // The Mac's catalog keys episodes by an internal series id; replication always uses the folder name.
  const idToFolder = new Map<string, string>();
  const folderToId = new Map<string, string>();

  function registerSeriesAlias(id: string, folder: string) {
    if (!id || !folder || id === folder) return;
    idToFolder.set(id, folder);
    folderToId.set(folder, id);
  }

  /** "<series id or folder>/<video>" → "<folder>/<video>" for replication keys. */
  function canonicalEpisodeKey(localKey: string) {
    const slash = localKey.indexOf('/');
    if (slash < 0) return localKey;
    const head = localKey.slice(0, slash);
    return `${idToFolder.get(head) ?? head}${localKey.slice(slash)}`;
  }

  /** Every local key an incoming "<folder>/<video>" change should land on (folder key and catalog-id key). */
  function localEpisodeKeys(folderKey: string) {
    const slash = folderKey.indexOf('/');
    if (slash < 0) return [folderKey];
    const id = folderToId.get(folderKey.slice(0, slash));
    return id ? [folderKey, `${id}${folderKey.slice(slash)}`] : [folderKey];
  }

  function getRegister<T = unknown>(key: string): T | undefined {
    return load().regs[key]?.value as T | undefined;
  }

  /** Every current key/value whose key starts with `prefix`. */
  function entries(prefix = ''): [string, unknown][] {
    return Object.entries(load().regs).filter(([key]) => key.startsWith(prefix)).map(([key, reg]) => [key, reg.value]);
  }

  /** Record a local change. `physicalMs` lets progress use its own watchedAt, so the latest watch wins. */
  function setLocal(key: string, value: unknown, physicalMs?: number) {
    const s = load();
    const current = s.regs[key];
    if (current && JSON.stringify(current.value) === JSON.stringify(value)) return false;
    const hlc = tick(physicalMs);
    if (current && current.hlc >= hlc) return false;
    s.seq += 1;
    const op: ReplicaOp = { node: s.nodeId, seq: s.seq, key, value, hlc };
    s.ownOps[key] = op;
    s.regs[key] = { value, hlc, node: s.nodeId };
    s.vv[s.nodeId] = s.seq;
    persist();
    scheduleSync(3000);
    return true;
  }

  function onRemoteChange(listener: ChangeListener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  /** Merge ops from a peer; returns how many became current. */
  function applyRemote(ops: ReplicaOp[]): number {
    const s = load();
    let won = 0;
    for (const op of ops) {
      if (!op || typeof op.node !== 'string' || typeof op.seq !== 'number' || typeof op.key !== 'string' || typeof op.hlc !== 'string') continue;
      if (op.node === s.nodeId || op.seq <= (s.vv[op.node] ?? 0)) continue;
      s.vv[op.node] = op.seq;
      observe(op.hlc);
      const current = s.regs[op.key];
      if (current && current.hlc >= op.hlc) continue;
      s.regs[op.key] = { value: op.value, hlc: op.hlc, node: op.node };
      won += 1;
      for (const listener of listeners) {
        try { listener(op.key, op.value); } catch { /* A bad listener must not stop the merge. */ }
      }
    }
    if (ops.length) persist();
    return won;
  }

  let inFlight: Promise<{ sent: number; received: number }> | null = null;

  /** One round trip with the Mac: send our unacknowledged ops, receive what we're missing.
   *  Overlapping calls (app start + socket connect) share one request. */
  function syncWith(baseUrl: string): Promise<{ sent: number; received: number }> {
    if (!inFlight) inFlight = doSync(baseUrl).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function doSync(baseUrl: string): Promise<{ sent: number; received: number }> {
    const s = load();
    // A new address (Tailscale vs home network) is almost always the same Mac; with one known, assume it.
    const knownMacs = Object.keys(s.peerVv);
    const macNode = s.urlNode?.[baseUrl] ?? (knownMacs.length === 1 ? knownMacs[0] : undefined);
    const acked = macNode ? (s.peerVv[macNode]?.[s.nodeId] ?? 0) : 0;
    const ops = Object.values(s.ownOps).filter(op => op.seq > acked).sort((a, b) => a.seq - b.seq);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let data: SyncResponse;
    try {
      const res = await fetchImpl(`${baseUrl}replica/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: s.nodeId, vv: s.vv, ops }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Replica sync HTTP ${res.status}`);
      data = (await res.json()) as SyncResponse;
    } finally {
      clearTimeout(timer);
    }
    const received = applyRemote(Array.isArray(data.ops) ? data.ops : []);
    if (typeof data.node === 'string' && data.vv && typeof data.vv === 'object') {
      s.urlNode = { ...s.urlNode, [baseUrl]: data.node };
      s.peerVv[data.node] = data.vv;
    }
    persist();
    return { sent: ops.length, received };
  }

  /** The app registers how to reach the Mac; local changes then sync automatically (debounced). */
  function setSyncer(fn: (() => Promise<void>) | null) {
    syncer = fn;
  }

  function scheduleSync(delayMs = 0) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      void syncer?.().catch(() => { /* Offline: changes stay queued until the next sync. */ });
    }, delayMs);
  }

  return {
    nodeId: () => load().nodeId,
    registerSeriesAlias,
    canonicalEpisodeKey,
    localEpisodeKeys,
    getRegister,
    entries,
    setLocal,
    onRemoteChange,
    syncWith,
    setSyncer,
    scheduleSync,
  };
}

export type Replica = ReturnType<typeof createReplica>;
