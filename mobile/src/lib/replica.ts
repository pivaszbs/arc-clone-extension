import { Directory, File, Paths } from 'expo-file-system';

/**
 * The phone's copy of the library state shared with the Mac (native/tv/replica.py).
 *
 * Every change is an op on a key, stamped with a hybrid logical clock (HLC) and this phone's node id.
 * For each key the newest HLC wins, so the phone and the Mac can both edit while apart and agree
 * once they meet. Changes made here wait in an outbox until the Mac is reachable; nothing here
 * depends on the Mac being online.
 *
 * Keys (same as the Mac):
 *   ep/<series folder>/<video file>/progress   { position, duration, watchedAt, finished }
 *   ep/<series folder>/<video file>/themes     { op?, ed?, recap?: { start, end, source? } }
 */

export type Op = { node: string; seq: number; key: string; value: unknown; hlc: string };
type Register = { value: unknown; hlc: string; node: string };
type State = {
  node: string;
  seq: number;
  lastHlc: string;
  regs: Record<string, Register>;
  outbox: Op[];
  /** Highest op number seen from each node, so the Mac only sends what's missing. */
  vv: Record<string, number>;
};

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'replica.json');
let state: State | undefined;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(keys: string[]) => void>();

const pad = (value: number, size: number) => String(Math.max(0, Math.floor(value))).padStart(size, '0');
export const makeHlc = (ms: number, counter: number, node: string) => `${pad(ms, 13)}:${pad(counter, 4)}:${node}`;
const hlcMs = (hlc: string) => Number(hlc.split(':', 1)[0]) || 0;
const hlcCounter = (hlc: string) => Number(hlc.split(':')[1]) || 0;

function load(): State {
  if (state) return state;
  try {
    if (file.exists) {
      const saved = JSON.parse(file.textSync()) as State;
      if (saved && typeof saved.node === 'string') state = saved;
    }
  } catch { /* A damaged file starts a fresh replica; the Mac resends everything. */ }
  state ??= {
    node: `phone-${Math.random().toString(36).slice(2, 10)}`,
    seq: 0,
    lastHlc: makeHlc(0, 0, ''),
    regs: {},
    outbox: [],
    vv: {},
  };
  return state;
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      file.write(JSON.stringify(load()));
    } catch { /* Best effort; the outbox is rebuilt from the next change. */ }
  }, 300);
}

function tick(physicalMs?: number) {
  const s = load();
  const lastMs = hlcMs(s.lastHlc);
  if (physicalMs !== undefined) {
    // Explicit timestamps (progress uses watchedAt) are used as-is, like the Mac does.
    const hlc = makeHlc(physicalMs, 0, s.node);
    if (physicalMs > lastMs) s.lastHlc = hlc;
    return hlc;
  }
  const now = Date.now();
  s.lastHlc = now > lastMs ? makeHlc(now, 0, s.node) : makeHlc(lastMs, hlcCounter(s.lastHlc) + 1, s.node);
  return s.lastHlc;
}

function observe(remote: string) {
  const s = load();
  if (remote > s.lastHlc && hlcMs(remote) <= Date.now() + 86_400_000) {
    s.lastHlc = makeHlc(hlcMs(remote), hlcCounter(remote), s.node);
  }
}

export function get<T = unknown>(key: string): T | undefined {
  return load().regs[key]?.value as T | undefined;
}

/** Record a change made on this phone. Returns true when it became the current value. */
export function setLocal(key: string, value: unknown, physicalMs?: number) {
  const s = load();
  const current = s.regs[key];
  if (current && JSON.stringify(current.value) === JSON.stringify(value)) return false;
  const hlc = tick(physicalMs);
  if (current && current.hlc >= hlc) return false;
  s.seq += 1;
  // Only the newest change per key matters, so the outbox keeps one op per key.
  s.outbox = s.outbox.filter(op => op.key !== key);
  s.outbox.push({ node: s.node, seq: s.seq, key, value, hlc });
  s.regs[key] = { value, hlc, node: s.node };
  persist();
  return true;
}

/** Store ops from the Mac. Returns the keys whose current value changed. */
export function applyRemote(ops: unknown): string[] {
  const s = load();
  if (!Array.isArray(ops)) return [];
  const changed: string[] = [];
  for (const raw of ops) {
    const op = raw as Partial<Op>;
    if (typeof op?.node !== 'string' || typeof op.seq !== 'number' || typeof op.key !== 'string' || typeof op.hlc !== 'string') continue;
    if (op.node === s.node || op.seq <= (s.vv[op.node] ?? 0)) continue;
    s.vv[op.node] = op.seq;
    observe(op.hlc);
    const current = s.regs[op.key];
    if (current && current.hlc >= op.hlc) continue;
    s.regs[op.key] = { value: op.value, hlc: op.hlc, node: op.node };
    changed.push(op.key);
  }
  persist();
  if (changed.length) for (const listener of listeners) listener(changed);
  return changed;
}

/** The request body for one sync round trip. */
export function pending() {
  const s = load();
  return { node: s.node, vv: { ...s.vv, [s.node]: s.seq }, ops: s.outbox.slice() };
}

/** Drop outbox ops the Mac has now stored. */
export function acknowledge(sent: Op[]) {
  const s = load();
  const done = new Set(sent.map(op => `${op.key}\n${op.seq}`));
  s.outbox = s.outbox.filter(op => !done.has(`${op.key}\n${op.seq}`));
  persist();
}

export const unsentCount = () => load().outbox.length;

export function onChange(listener: (keys: string[]) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
