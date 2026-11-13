import { Directory, File, Paths } from 'expo-file-system';

/**
 * Master-master library state shared with the Mac (mirror of native/tv/replica.py).
 *
 * Every change is an op on a key, stamped with a hybrid logical clock (HLC) and this phone's node id.
 * For each key the highest HLC wins, so the phone and the Mac can both edit while apart and converge
 * when they meet. Keys: `ep/<series folder>/<video>/progress|themes`, `series/<folder>/autoSkip`, …
 *
 * HLC (sortable string): "<13-digit ms>:<4-digit counter>:<node id>".
 */

export type ReplicaOp = { node: string; seq: number; key: string; value: unknown; hlc: string };
type Register = { value: unknown; hlc: string; node: string };
type ReplicaState = {
  nodeId: string;
  lastHlc: string;
  seq: number;
  regs: Record<string, Register>;
  /** This phone's newest op per key (older ones are superseded and never needed again). */
  ownOps: Record<string, ReplicaOp>;
  /** Highest seq seen per node. */
  vv: Record<string, number>;
  /** What each peer (by base URL) had acknowledged at the last sync. */
  peerVv: Record<string, Record<string, number>>;
};

type ChangeListener = (key: string, value: unknown) => void;
type SyncResponse = { node: string; vv: Record<string, number>; ops: ReplicaOp[]; applied?: number };

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'replica.json');

const pad = (n: number, width: number) => String(Math.max(0, Math.floor(n))).padStart(width, '0');
const makeHlc = (ms: number, counter: number, node: string) => `${pad(ms, 13)}:${pad(counter, 4)}:${node}`;
const hlcMs = (hlc: string) => Number(hlc.split(':', 1)[0]) || 0;
const hlcCounter = (hlc: string) => Number(hlc.split(':')[1]) || 0;

function randomId() {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

let state: ReplicaState | null = null;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncer: (() => Promise<void>) | null = null;
const listeners = new Set<ChangeListener>();

function load(): ReplicaState {
  if (state) return state;
  try {
    if (file.exists) state = JSON.parse(file.textSync()) as ReplicaState;
  } catch { /* A damaged replica file starts fresh; the Mac re-sends everything. */ }
  if (!state || typeof state.nodeId !== 'string') {
    const nodeId = `ios-${randomId()}`;
    state = { nodeId, lastHlc: makeHlc(0, 0, nodeId), seq: 0, regs: {}, ownOps: {}, vv: {}, peerVv: {} };
    persist();
  }
  return state;
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      file.write(JSON.stringify(state));
    } catch { /* Best effort; the next change retries. */ }
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

export const replicaNodeId = () => load().nodeId;

// The Mac's catalog keys episodes by an internal series id; replication always uses the folder name.
const idToFolder = new Map<string, string>();
const folderToId = new Map<string, string>();

/** Called when the catalog is parsed: `id` is the catalog's series id, `folder` its folder name. */
export function registerSeriesAlias(id: string, folder: string) {
  if (!id || !folder || id === folder) return;
  idToFolder.set(id, folder);
  folderToId.set(folder, id);
}

/** "<series id or folder>/<video>" → "<folder>/<video>" for replication keys. */
export function canonicalEpisodeKey(localKey: string) {
  const slash = localKey.indexOf('/');
  if (slash < 0) return localKey;
  const head = localKey.slice(0, slash);
  return `${idToFolder.get(head) ?? head}${localKey.slice(slash)}`;
}

/** Every local key an incoming "<folder>/<video>" change should land on (folder key and catalog-id key). */
export function localEpisodeKeys(folderKey: string) {
  const slash = folderKey.indexOf('/');
  if (slash < 0) return [folderKey];
  const id = folderToId.get(folderKey.slice(0, slash));
  return id ? [folderKey, `${id}${folderKey.slice(slash)}`] : [folderKey];
}

export function getRegister<T = unknown>(key: string): T | undefined {
  return load().regs[key]?.value as T | undefined;
}

/** Record a local change. `physicalMs` lets progress use its own watchedAt, so the latest watch wins. */
export function setLocal(key: string, value: unknown, physicalMs?: number) {
  const s = load();
  const current = s.regs[key];
  if (current && JSON.stringify(current.value) === JSON.stringify(value)) return;
  const hlc = tick(physicalMs);
  if (current && current.hlc >= hlc) return;
  s.seq += 1;
  const op: ReplicaOp = { node: s.nodeId, seq: s.seq, key, value, hlc };
  s.ownOps[key] = op;
  s.regs[key] = { value, hlc, node: s.nodeId };
  s.vv[s.nodeId] = s.seq;
  persist();
  scheduleSync(3000);
}

export function onRemoteChange(listener: ChangeListener) {
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
export function syncWith(baseUrl: string): Promise<{ sent: number; received: number }> {
  if (!inFlight) inFlight = doSync(baseUrl).finally(() => { inFlight = null; });
  return inFlight;
}

async function doSync(baseUrl: string): Promise<{ sent: number; received: number }> {
  const s = load();
  const acked = s.peerVv[baseUrl]?.[s.nodeId] ?? 0;
  const ops = Object.values(s.ownOps).filter(op => op.seq > acked).sort((a, b) => a.seq - b.seq);
  const res = await fetch(`${baseUrl}replica/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node: s.nodeId, vv: s.vv, ops }),
  });
  if (!res.ok) throw new Error(`Replica sync HTTP ${res.status}`);
  const data = (await res.json()) as SyncResponse;
  const received = applyRemote(Array.isArray(data.ops) ? data.ops : []);
  if (data.vv && typeof data.vv === 'object') s.peerVv[baseUrl] = data.vv;
  persist();
  return { sent: ops.length, received };
}

/** The app registers how to reach the Mac; local changes then sync automatically (debounced). */
export function setSyncer(fn: (() => Promise<void>) | null) {
  syncer = fn;
}

export function scheduleSync(delayMs = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void syncer?.().catch(() => { /* Offline: changes stay queued until the next sync. */ });
  }, delayMs);
}
