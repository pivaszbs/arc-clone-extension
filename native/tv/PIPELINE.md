# Anime Study distributed pipeline — design

Status: steps 1–3 are implemented (`queue_store.py`, `serve.py`, `worker.py`): persistent queue, renewable leases, backoff + quarantine, `worker/retry`, and per-episode stages probe → fingerprint(+match) → publish with `kinds`-aware claiming, and the step-3 scheduler (next-to-watch priority, phone power/thermal gating, TV-busy limit, learned per-node speed). Steps 4–8 are a proposal. Today's queue lives in `serve.py` (`/worker/claim|progress|complete`) with one
job kind (OP/ED fingerprint), in-memory state, FIFO claiming and two worker types (Mac `worker.py`,
iPhone app). This design grows that into a multi-stage pipeline without changing the core idea:
**workers pull work over plain HTTP from the coordinator**. That keeps the iPhone a first-class
worker; it can't run Celery, Redis or Ray clients.

## 1. Goals

- Process a whole series hands-off: drop files in the folder → everything ready to watch/study.
- Use every machine on the LAN (Mac, iPhone, and any extra node such as "melanicher"), each
  for what it does best.
- Survive restarts, Wi-Fi drops, a phone going to sleep, or a node disappearing mid-job.
- Never redo finished work; never block the TV from streaming.

## 2. Pipeline (per episode)

```
            ┌──────────┐
 new file → │  probe   │  duration, streams, codecs, audio langs, subtitle tracks
            └────┬─────┘
       ┌─────────┼───────────────┬────────────────┐
       ▼         ▼               ▼                ▼
 ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐
 │fingerprint│ │ subtitles│ │ thumbnails │ │ transcode?   │  only if not H.264/AAC MP4
 │ (A/V)    │ │ extract  │ │ + poster   │ │ (TV-safe)    │  (Tizen player limits)
 └────┬─────┘ └────┬─────┘ └────────────┘ └──────────────┘
      ▼            ▼
 ┌──────────┐ ┌──────────────┐
 │  match   │ │ study prep   │  word lists, furigana, cue alignment (arc-explainer)
 │ OP/ED/   │ └──────────────┘
 │  recap   │
 └────┬─────┘
      ▼   low confidence (credits over footage)
 ┌──────────────┐
 │ classify     │  optional: on-device model (Gemma/MLX on iPhone or Mac) — "is this frame credits?"
 └────┬─────────┘
      ▼
 ┌──────────┐
 │ publish  │  write themes/metadata, bump library version, push to TV + phones over WS
 └──────────┘
```

Series-level stage: **reference build**. The first two episodes fingerprinted in a series become the
series reference (cached), so later episodes only match against it — what `series_samples` does today,
but persisted.

## 3. Coordinator (`serve.py`)

### 3.1 Persistent state — SQLite (stdlib `sqlite3`, WAL mode)

```
episodes(id, series, file, size, mtime, sha1_head)          -- identity survives renames
tasks(id, episode_id, kind, status, attempts, priority,
      requires_json, depends_on_json, lease_node, lease_until,
      progress, result_ref, error, created_at, updated_at)
artifacts(hash, kind, episode_id, path, bytes, created_at)  -- content-addressed outputs
nodes(id, name, platform, caps_json, last_seen, stats_json) -- throughput history per kind
events(id, ts, task_id, node_id, type, data_json)           -- audit trail / debugging
```

- Status machine: `blocked → ready → leased → done | failed`, plus `quarantined` after N attempts.
- A task becomes `ready` when all `depends_on` are `done` (DAG). Rescans of the folder only *insert*
  missing tasks, so restarts are free.
- Idempotent completion: `complete` with a stale lease is accepted only if the task is not already
  `done` (first finisher wins, later duplicates are dropped).

### 3.2 Leases and heartbeats

- `claim` grants a lease (e.g. 90 s). Workers renew it with every `progress` call.
- Missed renewal → task returns to `ready` with `attempts+1`, exponential backoff before re-offer.
- 3 failures → `quarantined`, shown in the app with the last error and a "retry" button.

### 3.3 Scheduling — capability + cost based

Nodes declare capabilities on claim:

```json
{ "nodeId": "mac-mbp", "platform": "mac",
  "caps": ["ffmpeg", "ffprobe", "videotoolbox", "mlx"],
  "power": "ac", "maxConcurrent": 2 }
{ "nodeId": "iphone-18pm", "platform": "ios",
  "caps": ["avfoundation", "ane"], "power": "charging", "thermal": "nominal" }
```

Tasks declare requirements (`requires`), e.g. `transcode → ["ffmpeg"]`,
`fingerprint → ["ffmpeg"] | ["avfoundation"]`, `classify → ["mlx"] | ["ane"]`.

`claim` picks the **best ready task for this node**, not FIFO:

```
score = priority
      + 5  if the node already has the episode cached (locality)
      + speed(node, kind) / median_speed(kind)      -- learned from stats_json
      - 10 if node is iOS and not charging           -- don't drain the phone
      - big if the TV is currently streaming and task is I/O heavy on the coordinator
```

Priority order: the episode the user is about to watch (next in the library / currently on TV) >
rest of the current series > other series.

### 3.4 Splitting long work

Fingerprinting and transcoding split into time **segments** (e.g. 0–3 min, last 4 min for OP/ED;
fixed 2-minute chunks for transcode). Segments are independent tasks, so the Mac and the phone can
work on the same episode at once; a `join` step merges results.

### 3.5 Push, not poll

Workers keep the existing WebSocket open; the coordinator sends `{"type":"work_available"}` when a
task becomes ready, and the worker then calls `claim`. Polling stays as a 30 s fallback.

## 4. Data plane

- Workers read media with HTTP **range** requests (already supported by `media_range`), fetching
  only the segments a task needs instead of whole files.
- Outputs (samples, thumbnails, subtitles, transcodes) upload to `PUT /artifacts/<sha256>`; the
  coordinator stores them under `.anime-study/artifacts/` and records them in `artifacts`. Same
  hash = already stored = skipped upload.
- Nodes keep a small LRU cache of recent episodes, reported back so the scheduler can use locality.

## 5. Worker protocol (v2)

```
POST /worker/claim     {nodeId, caps, power, thermal, cached:[episodeIds]} → {task | null, leaseUntil}
POST /worker/progress  {taskId, nodeId, progress, note?}                   → {leaseUntil, cancel?}
POST /worker/complete  {taskId, nodeId, result, artifacts:[hash]}          → {ok}
POST /worker/fail      {taskId, nodeId, error, retryable}                  → {ok}
PUT  /artifacts/<hash> (body = bytes)                                     → {ok}
WS   {"type":"work_available"} / {"type":"cancel", taskId}
```

v1 endpoints stay working for older app builds by mapping them onto the `fingerprint` task kind.

## 6. Nodes

| Node | Best at | Notes |
|---|---|---|
| Mac (`worker.py`) | transcode, ffmpeg fingerprint, MLX classify | launchd-managed, 2 concurrent tasks |
| iPhone (Anime Study app) | AVFoundation fingerprint, thumbnails, ANE classify | only while charging + foreground/BG task; small segments |
| Extra node ("melanicher") | whatever its caps say | install `worker.py` + ffmpeg; join with the same URL + its own node key |
| Samsung TV | — | consumer only; never a worker |

Joining a node = run the worker with the coordinator URL. The node is visible in the app's worker
panel within one heartbeat.

## 7. Security

- Today the token is in the URL path. Add a per-node key (`X-Node-Key`), issued by the coordinator
  and approved once from the phone ("New worker 'melanicher' wants to join — Allow?").
- Workers can only claim, report and upload; they can't change library metadata directly.

## 8. Observability

- `/worker/status` adds per-stage counts, per-node throughput (episodes/hour) and ETA for the queue.
- The phone's Pipelines view shows a per-episode stage strip: probe ✓ fingerprint ✓ match ✓ subs … publish.
- `events` table gives a timeline for "why did this episode fail?".

## 9. Build order

1. SQLite persistence + leases with renewal + quarantine (no behaviour change for workers).
2. Task kinds + DAG: probe → fingerprint → match → publish; keep v1 endpoints mapped.
3. Capability/cost scheduler + priority for "next to watch".
4. WebSocket `work_available` push.
5. Range-based segment tasks + artifact store.
6. New stages: subtitles, thumbnails, transcode, study prep.
7. Optional classify stage (MLX/ANE) for credits-over-footage endings.
8. Per-node keys + approve-from-phone.

## 10. Why not an off-the-shelf queue

Celery/RQ/Dramatiq need Redis or RabbitMQ and Python clients; Ray and Temporal are heavyweight and
also have no iOS worker. Huey (SQLite-backed) fits the coordinator side but not the iPhone. The
coordinator already speaks HTTP and WebSocket to the phone and TV, so a small SQLite-backed lease
queue inside `serve.py` is the lowest-friction option.
