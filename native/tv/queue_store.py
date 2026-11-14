"""Persistent state for the Anime Study worker queue (step 1 of PIPELINE.md).

SQLite (stdlib, WAL mode) so jobs, per-episode attempts/results and cached reference samples
survive coordinator restarts. The server keeps in-memory copies for speed and writes through here.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id        TEXT PRIMARY KEY,
    series_idx    INTEGER NOT NULL,
    series_name   TEXT NOT NULL,
    episode       TEXT NOT NULL,
    episode_idx   INTEGER NOT NULL,
    status        TEXT NOT NULL,          -- in_progress | completed | failed | expired
    node_id       TEXT,
    node_name     TEXT,
    progress      INTEGER NOT NULL DEFAULT 0,
    leased_at     REAL NOT NULL,
    lease_until   REAL NOT NULL,
    error         TEXT,
    updated_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS episodes (
    series_name   TEXT NOT NULL,
    episode       TEXT NOT NULL,
    state         TEXT NOT NULL,          -- done | retrying | quarantined
    attempts      INTEGER NOT NULL DEFAULT 0,
    not_before    REAL NOT NULL DEFAULT 0, -- backoff: don't offer again before this time
    last_error    TEXT,
    updated_at    REAL NOT NULL,
    PRIMARY KEY (series_name, episode)
);

-- Per-episode state for stages other than fingerprint (which keeps using `episodes`).
CREATE TABLE IF NOT EXISTS stages (
    kind          TEXT NOT NULL,          -- probe | ...
    series_name   TEXT NOT NULL,
    episode       TEXT NOT NULL,
    state         TEXT NOT NULL,          -- done | retrying | quarantined
    attempts      INTEGER NOT NULL DEFAULT 0,
    not_before    REAL NOT NULL DEFAULT 0,
    last_error    TEXT,
    result        TEXT,                   -- JSON output of the stage (e.g. probe info)
    updated_at    REAL NOT NULL,
    PRIMARY KEY (kind, series_name, episode)
);

CREATE TABLE IF NOT EXISTS samples (
    series_name   TEXT NOT NULL,
    episode       TEXT NOT NULL,
    data          TEXT NOT NULL,
    updated_at    REAL NOT NULL,
    PRIMARY KEY (series_name, episode)
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            REAL NOT NULL,
    job_id        TEXT,
    node_id       TEXT,
    type          TEXT NOT NULL,
    data          TEXT
);
"""

KEEP_EVENTS = 5000


class QueueStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        cols = {row[1] for row in self._db.execute("PRAGMA table_info(jobs)")}
        if "kind" not in cols:
            self._db.execute("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'fingerprint'")
        # Which OP/ED detector version finished the episode; rows from before versioning count as 1.
        episode_cols = {row[1] for row in self._db.execute("PRAGMA table_info(episodes)")}
        if "detector" not in episode_cols:
            self._db.execute("ALTER TABLE episodes ADD COLUMN detector INTEGER NOT NULL DEFAULT 1")

    def close(self):
        with self._lock:
            self._db.close()

    # ---- loading ---------------------------------------------------------

    def load_jobs(self, statuses=("in_progress",)):
        marks = ",".join("?" for _ in statuses)
        with self._lock:
            rows = self._db.execute(
                f"SELECT job_id, series_idx, series_name, episode, episode_idx, status, node_id, node_name,"
                f" progress, leased_at, lease_until, error, kind FROM jobs WHERE status IN ({marks})",
                tuple(statuses),
            ).fetchall()
        return [
            {
                "jobId": r[0], "series": r[1], "seriesName": r[2], "episode": r[3], "episodeIndex": r[4],
                "status": r[5], "nodeId": r[6], "nodeName": r[7], "progress": r[8],
                "leasedAt": r[9], "leaseExpiresAt": r[10], "error": r[11], "kind": r[12] or "fingerprint",
            }
            for r in rows
        ]

    def load_episodes(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT series_name, episode, state, attempts, not_before, last_error, detector FROM episodes"
            ).fetchall()
        return {
            (r[0], r[1]): {"state": r[2], "attempts": r[3], "notBefore": r[4], "error": r[5], "detector": r[6]}
            for r in rows
        }

    def load_stages(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT kind, series_name, episode, state, attempts, not_before, last_error, result FROM stages"
            ).fetchall()
        out = {}
        for kind, series_name, episode, state, attempts, not_before, error, result in rows:
            try:
                parsed = json.loads(result) if result else None
            except ValueError:
                parsed = None
            out.setdefault(kind, {})[(series_name, episode)] = {
                "state": state, "attempts": attempts, "notBefore": not_before, "error": error, "result": parsed,
            }
        return out

    def save_stage(self, kind, key, info):
        result = info.get("result")
        with self._lock:
            self._db.execute(
                "INSERT INTO stages (kind, series_name, episode, state, attempts, not_before, last_error, result, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(kind, series_name, episode) DO UPDATE SET state=excluded.state, attempts=excluded.attempts,"
                " not_before=excluded.not_before, last_error=excluded.last_error, result=excluded.result,"
                " updated_at=excluded.updated_at",
                (kind, key[0], key[1], info["state"], info["attempts"], info.get("notBefore", 0), info.get("error"),
                 json.dumps(result) if result is not None else None, time.time()),
            )

    def delete_stage(self, kind, key):
        with self._lock:
            self._db.execute("DELETE FROM stages WHERE kind=? AND series_name=? AND episode=?", (kind, *key))

    def load_samples(self):
        with self._lock:
            rows = self._db.execute("SELECT series_name, episode, data FROM samples").fetchall()
        out = {}
        for series_name, episode, data in rows:
            try:
                out[(series_name, episode)] = json.loads(data)
            except ValueError:
                continue
        return out

    # ---- writes ----------------------------------------------------------

    def save_job(self, job):
        with self._lock:
            self._db.execute(
                "INSERT INTO jobs (job_id, series_idx, series_name, episode, episode_idx, status, node_id,"
                " node_name, progress, leased_at, lease_until, error, updated_at, kind)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, node_id=excluded.node_id,"
                " node_name=excluded.node_name, progress=excluded.progress, lease_until=excluded.lease_until,"
                " error=excluded.error, updated_at=excluded.updated_at",
                (
                    job["jobId"], job["series"], job["seriesName"], job["episode"], job["episodeIndex"],
                    job["status"], job.get("nodeId"), job.get("nodeName"), int(job.get("progress") or 0),
                    job["leasedAt"], job["leaseExpiresAt"], job.get("error"), time.time(),
                    job.get("kind", "fingerprint"),
                ),
            )

    def save_episode(self, key, info):
        with self._lock:
            self._db.execute(
                "INSERT INTO episodes (series_name, episode, state, attempts, not_before, last_error, detector, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?)"
                " ON CONFLICT(series_name, episode) DO UPDATE SET state=excluded.state, attempts=excluded.attempts,"
                " not_before=excluded.not_before, last_error=excluded.last_error, detector=excluded.detector,"
                " updated_at=excluded.updated_at",
                (key[0], key[1], info["state"], info["attempts"], info.get("notBefore", 0), info.get("error"),
                 int(info.get("detector", 1)), time.time()),
            )

    def delete_episode(self, key):
        with self._lock:
            self._db.execute("DELETE FROM episodes WHERE series_name=? AND episode=?", key)

    def save_samples(self, key, data):
        with self._lock:
            self._db.execute(
                "INSERT INTO samples (series_name, episode, data, updated_at) VALUES (?,?,?,?)"
                " ON CONFLICT(series_name, episode) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                (key[0], key[1], json.dumps(data), time.time()),
            )

    def log_event(self, type_, job_id=None, node_id=None, data=None):
        with self._lock:
            self._db.execute(
                "INSERT INTO events (ts, job_id, node_id, type, data) VALUES (?,?,?,?,?)",
                (time.time(), job_id, node_id, type_, json.dumps(data) if data is not None else None),
            )
            self._db.execute(
                "DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", (KEEP_EVENTS,)
            )

    def prune_finished_jobs(self, older_than_seconds=7 * 24 * 3600):
        with self._lock:
            self._db.execute(
                "DELETE FROM jobs WHERE status != 'in_progress' AND updated_at < ?",
                (time.time() - older_than_seconds,),
            )
