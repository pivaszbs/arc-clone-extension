"""Master-master replication of library state between the Mac and phones (PIPELINE.md, multi-master step 1).

Every change is an *op* on a key ("register"), stamped with a hybrid logical clock (HLC) and the node
that made it. For each key the op with the highest HLC wins (last-writer-wins), so nodes can edit while
apart and converge when they meet. Ops are numbered per node (`seq`), and a version vector
`{node: highest seq seen}` tells a peer exactly which ops it is missing.

Keys:
    ep/<series folder>/<video file>/progress   {position, duration, watchedAt, finished}
    ep/<series folder>/<video file>/themes     {op?, ed?, recap?: {start, end, source}}
    series/<series folder>/autoSkip            {op?, ed?, recap?: bool}
    series/<series folder>/autoSkipDelay       0 | 3 | 5
    settings/autoplay                          bool

HLC format (sortable as a string): "<13-digit ms>:<4-digit counter>:<node id>".
"""

import json
import socket
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS replica_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replica_ops (
    node   TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    hlc    TEXT NOT NULL,
    PRIMARY KEY (node, seq)
);
CREATE TABLE IF NOT EXISTS replica_regs (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    hlc    TEXT NOT NULL,
    node   TEXT NOT NULL
);
"""

MAX_OPS_PER_SYNC = 2000


def make_hlc(ms, counter, node):
    return f"{int(ms):013d}:{int(counter):04d}:{node}"


def hlc_ms(hlc):
    try:
        return int(hlc.split(":", 1)[0])
    except (ValueError, AttributeError):
        return 0


class Replica:
    def __init__(self, path, node_id=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        saved = self._meta("node_id")
        self.node_id = saved or node_id or f"mac-{socket.gethostname().split('.')[0].lower()}"
        if not saved:
            self._set_meta("node_id", self.node_id)
        self._last_hlc = self._meta("last_hlc") or make_hlc(0, 0, self.node_id)

    # ---- meta ---------------------------------------------------------------

    def _meta(self, k):
        row = self._db.execute("SELECT v FROM replica_meta WHERE k=?", (k,)).fetchone()
        return row[0] if row else None

    def _set_meta(self, k, v):
        self._db.execute("INSERT INTO replica_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))

    def close(self):
        with self._lock:
            self._db.close()

    # ---- clock --------------------------------------------------------------

    def _tick(self, physical_ms=None):
        """Next HLC for a local change. `physical_ms` lets progress use its own watchedAt."""
        now = int(physical_ms if physical_ms is not None else time.time() * 1000)
        last_ms = hlc_ms(self._last_hlc)
        last_counter = int(self._last_hlc.split(":")[1]) if self._last_hlc.count(":") >= 2 else 0
        if physical_ms is not None:
            # Explicit timestamps (watchedAt, bootstrap) are used as-is; they don't move the clock back.
            hlc = make_hlc(now, 0, self.node_id)
            if now > last_ms:
                self._last_hlc = hlc
                self._set_meta("last_hlc", hlc)
            return hlc
        if now > last_ms:
            hlc = make_hlc(now, 0, self.node_id)
        else:
            hlc = make_hlc(last_ms, last_counter + 1, self.node_id)
        self._last_hlc = hlc
        self._set_meta("last_hlc", hlc)
        return hlc

    def _observe(self, remote_hlc):
        """Move our clock past a remote op so our next edit sorts after it."""
        if remote_hlc > self._last_hlc and hlc_ms(remote_hlc) <= time.time() * 1000 + 86_400_000:
            ms = hlc_ms(remote_hlc)
            counter = int(remote_hlc.split(":")[1])
            self._last_hlc = make_hlc(ms, counter, self.node_id)
            self._set_meta("last_hlc", self._last_hlc)

    # ---- registers ----------------------------------------------------------

    def get(self, key):
        with self._lock:
            row = self._db.execute("SELECT value FROM replica_regs WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def has(self, key):
        with self._lock:
            return self._db.execute("SELECT 1 FROM replica_regs WHERE key=?", (key,)).fetchone() is not None

    def items(self, prefix=""):
        with self._lock:
            rows = self._db.execute(
                "SELECT key, value FROM replica_regs WHERE key LIKE ? ESCAPE '\\'",
                (prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",),
            ).fetchall()
        return {k: json.loads(v) for k, v in rows}

    def _compact_locked(self, node, key, seq):
        """Only a node's newest op per key matters for LWW; drop its older ones so the log stays small.
        The node's max seq (the version vector) is unaffected because the newest op is kept."""
        self._db.execute("DELETE FROM replica_ops WHERE node=? AND key=? AND seq<?", (node, key, seq))

    def _apply_locked(self, key, value_json, hlc, node):
        row = self._db.execute("SELECT hlc FROM replica_regs WHERE key=?", (key,)).fetchone()
        if row and row[0] >= hlc:
            return False
        self._db.execute(
            "INSERT INTO replica_regs (key, value, hlc, node) VALUES (?,?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value, hlc=excluded.hlc, node=excluded.node",
            (key, value_json, hlc, node),
        )
        return True

    # ---- local edits ----------------------------------------------------------

    def set_local(self, key, value, physical_ms=None, only_if_newer=True):
        """Record a local change. Returns True if it became the current value."""
        value_json = json.dumps(value, sort_keys=True, ensure_ascii=False)
        with self._lock:
            current = self._db.execute("SELECT value, hlc FROM replica_regs WHERE key=?", (key,)).fetchone()
            if current and current[0] == value_json:
                return False
            hlc = self._tick(physical_ms)
            if only_if_newer and current and current[1] >= hlc:
                return False
            seq = int(self._meta(f"seq:{self.node_id}") or 0) + 1
            self._db.execute("BEGIN")
            try:
                self._db.execute(
                    "INSERT INTO replica_ops (node, seq, key, value, hlc) VALUES (?,?,?,?,?)",
                    (self.node_id, seq, key, value_json, hlc),
                )
                self._set_meta(f"seq:{self.node_id}", str(seq))
                self._compact_locked(self.node_id, key, seq)
                self._apply_locked(key, value_json, hlc, self.node_id)
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
            return True

    # ---- replication ----------------------------------------------------------

    def version_vector(self):
        with self._lock:
            rows = self._db.execute("SELECT node, MAX(seq) FROM replica_ops GROUP BY node").fetchall()
        return {node: seq for node, seq in rows}

    def ops_since(self, vv, limit=MAX_OPS_PER_SYNC):
        """Ops the peer with version vector `vv` hasn't seen (from every node, so changes relay)."""
        vv = vv if isinstance(vv, dict) else {}
        out = []
        with self._lock:
            nodes = [r[0] for r in self._db.execute("SELECT DISTINCT node FROM replica_ops")]
            for node in nodes:
                since = int(vv.get(node, 0) or 0)
                rows = self._db.execute(
                    "SELECT node, seq, key, value, hlc FROM replica_ops WHERE node=? AND seq>? ORDER BY seq LIMIT ?",
                    (node, since, limit),
                ).fetchall()
                out += [{"node": r[0], "seq": r[1], "key": r[2], "value": json.loads(r[3]), "hlc": r[4]} for r in rows]
                if len(out) >= limit:
                    break
        return out[:limit]

    def apply_remote(self, ops):
        """Store ops from a peer. Returns [(key, value)] that became current (to write into local state)."""
        won = []
        if not isinstance(ops, list):
            return won
        with self._lock:
            have = {node: seq for node, seq in self._db.execute("SELECT node, MAX(seq) FROM replica_ops GROUP BY node")}
            self._db.execute("BEGIN")
            try:
                for op in ops[:MAX_OPS_PER_SYNC]:
                    if not isinstance(op, dict):
                        continue
                    node, seq, key, hlc = op.get("node"), op.get("seq"), op.get("key"), op.get("hlc")
                    if not (isinstance(node, str) and isinstance(seq, int) and isinstance(key, str) and isinstance(hlc, str)):
                        continue
                    if node == self.node_id or len(key) > 512 or len(hlc) > 120:
                        continue
                    if seq <= int(have.get(node, 0)):
                        continue
                    value_json = json.dumps(op.get("value"), sort_keys=True, ensure_ascii=False)
                    if len(value_json) > 20_000:
                        continue
                    self._db.execute(
                        "INSERT OR IGNORE INTO replica_ops (node, seq, key, value, hlc) VALUES (?,?,?,?,?)",
                        (node, seq, key, value_json, hlc),
                    )
                    have[node] = max(int(have.get(node, 0)), seq)
                    self._compact_locked(node, key, seq)
                    self._observe(hlc)
                    if self._apply_locked(key, value_json, hlc, node):
                        won.append((key, op.get("value")))
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        return won
