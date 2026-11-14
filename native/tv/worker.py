"""Distributed frame-scanning Mac worker node using ffmpeg for Anime Study TV."""

import argparse
import base64
import json
import math
import shutil
import socket
import subprocess
import time
from urllib.error import URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

try:
    from . import audio_print
except ImportError:  # run as a script: python3 native/tv/worker.py
    import audio_print

FRAME_WIDTH = 12
FRAME_HEIGHT = 8
FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3  # RGB24 = 288 bytes
INTERVAL = 2
MAXIMUM_OPENING_END = 720.0


def http_json(url, payload=None, timeout=30):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def probe_duration(video_url, ffprobe_bin):
    cmd = [
        ffprobe_bin,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_url,
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=30).decode("utf-8").strip()
    duration = float(out)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Invalid duration from ffprobe: {out!r}")
    return duration


TV_SAFE_VIDEO = {"h264"}
TV_SAFE_AUDIO = {"aac", "mp3"}
TV_SAFE_CONTAINERS = ("mp4", "mov", "m4a")


def probe_media(video_url, ffprobe_bin):
    """Stream/container facts for the pipeline's `probe` stage (PIPELINE.md step 2)."""
    cmd = [ffprobe_bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", video_url]
    data = json.loads(subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=60).decode("utf-8"))
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    duration = float(fmt.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("ffprobe reported no duration")

    def tags(stream):
        return stream.get("tags") or {}

    video = next((st for st in streams if st.get("codec_type") == "video"
                  and not (st.get("disposition") or {}).get("attached_pic")), None)
    audio = [st for st in streams if st.get("codec_type") == "audio"]
    subs = [st for st in streams if st.get("codec_type") == "subtitle"]
    fps = None
    if video and video.get("avg_frame_rate") and "/" in video["avg_frame_rate"]:
        num, den = video["avg_frame_rate"].split("/", 1)
        try:
            fps = round(float(num) / float(den), 3) if float(den) else None
        except ValueError:
            fps = None
    container = (fmt.get("format_name") or "").split(",")[0]
    video_codec = video.get("codec_name") if video else None
    audio_codec = audio[0].get("codec_name") if audio else None
    return {
        "duration": round(duration, 3),
        "container": container,
        "videoCodec": video_codec,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": fps,
        "audioCodec": audio_codec,
        "audio": [{"codec": a.get("codec_name"), "lang": tags(a).get("language"), "channels": a.get("channels"),
                   "title": tags(a).get("title")} for a in audio],
        "subtitles": [{"codec": t.get("codec_name"), "lang": tags(t).get("language"), "title": tags(t).get("title")}
                      for t in subs],
        # Can the Samsung TV play it as-is? (H.264 + AAC/MP3 in MP4.) Feeds the future transcode stage.
        "tvSafe": bool(video_codec in TV_SAFE_VIDEO and (audio_codec in TV_SAFE_AUDIO or not audio)
                       and container in TV_SAFE_CONTAINERS),
    }


def process_probe_job(base_url, node_id, job, ffprobe_bin):
    http_json(urljoin(base_url, "worker/progress"), {"jobId": job["jobId"], "nodeId": node_id, "progress": 10}, timeout=10)
    probe = probe_media(urljoin(base_url, job["url"]), ffprobe_bin)
    http_json(urljoin(base_url, "worker/complete"), {"jobId": job["jobId"], "nodeId": node_id, "probe": probe}, timeout=30)
    return probe


def sample_window(video_url, start, end, ffmpeg_bin):
    span = end - start
    if span < 1.0:
        return {"times": [], "dataBase64": ""}
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel", "error",
        "-ss", f"{start:.3f}",
        "-t", f"{span:.3f}",
        "-i", video_url,
        "-vf", f"fps=1,crop=iw*0.84:ih*0.8:iw*0.08:ih*0.1,scale={FRAME_WIDTH}:{FRAME_HEIGHT}:flags=bilinear",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1",
    ]
    raw = subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=180)
    count = len(raw) // FRAME_BYTES
    trimmed = raw[: count * FRAME_BYTES]
    times = [round(start + i, 3) for i in range(count)]
    return {
        "times": times,
        "dataBase64": base64.b64encode(trimmed).decode("ascii"),
    }


def fingerprint_video(video_url, duration_hint, ffmpeg_bin, ffprobe_bin, progress_cb=None):
    duration = duration_hint if (duration_hint and duration_hint > 0) else probe_duration(video_url, ffprobe_bin)
    if not math.isfinite(duration) or duration < 180:
        return {"op": {"times": [], "dataBase64": ""}, "ed": {"times": [], "dataBase64": ""}}
    ending_start = max(duration - 240.0, duration / 2.0)
    opening_scan_end = min(MAXIMUM_OPENING_END, ending_start)
    op = sample_window(video_url, 0.0, opening_scan_end, ffmpeg_bin)
    if progress_cb:
        progress_cb(0.55)
    ed = sample_window(video_url, ending_start, duration - 0.5, ffmpeg_bin)
    if progress_cb:
        progress_cb(0.85)
    # Soundtrack of the ending window, for matching the ending song (None without numpy).
    ed_audio = audio_print.encode(audio_print.audio_print(video_url, ending_start, duration - 0.5, ffmpeg_bin))
    if progress_cb:
        progress_cb(1.0)
    return {"op": op, "ed": ed, "edAudio": ed_audio}


def decode_samples(window):
    times = window.get("times") or []
    b64 = window.get("dataBase64") or ""
    if not times or not b64:
        return []
    raw = base64.b64decode(b64)
    count = min(len(times), len(raw) // FRAME_BYTES)
    return [
        (float(times[i]), raw[i * FRAME_BYTES : (i + 1) * FRAME_BYTES])
        for i in range(count)
    ]


def frame_distance(a_bytes, b_bytes):
    total = 0
    for i in range(FRAME_BYTES):
        total += abs(a_bytes[i] - b_bytes[i])
    return total / float(FRAME_BYTES)


def aligned_distance(sample_bytes, reference, aligned, tolerance=1):
    best = math.inf
    ref_len = len(reference)
    for nearby in range(aligned - tolerance, aligned + tolerance + 1):
        if 0 <= nearby < ref_len:
            d = frame_distance(sample_bytes, reference[nearby][1])
            if d < best:
                best = d
    return best


def match_window(current, reference, minimum_seconds, late=False):
    if not current or not reference:
        return None
    best = None
    maximum_seconds = 110.0 if late else 150.0
    minimum_coverage = 0.18 if late else 0.75
    maximum_gap = 12 if late else 3
    maximum_distance = 24.0 if late else 30.0

    cur_len = len(current)
    ref_len = len(reference)

    for offset in range(-(cur_len - 1) * INTERVAL, ref_len):
        first = 0
        last = 0
        hits = 0
        changes = 0
        total = 0.0

        def consider():
            nonlocal best
            if hits <= 0:
                return
            span = last - first + 1
            seconds = (span - 1) * INTERVAL
            mean = total / hits
            if (
                minimum_seconds <= seconds <= maximum_seconds
                and (hits / span) >= minimum_coverage
                and changes >= 5
                and mean <= 19.0
                and (best is None or hits > best["hits"] or (hits == best["hits"] and mean < best["mean"]))
            ):
                best = {
                    "start": current[first][0],
                    "end": current[last][0],
                    "hits": hits,
                    "mean": mean,
                    "offset": offset,
                }

        start_idx = max(0, math.ceil(-offset / INTERVAL))
        end_idx = min(cur_len, math.ceil((ref_len - offset) / INTERVAL))
        for idx in range(start_idx, end_idx):
            if hits and (idx - last) > maximum_gap:
                consider()
                hits = 0
                changes = 0
                total = 0.0
            diff = aligned_distance(current[idx][1], reference, idx * INTERVAL + offset)
            if diff > maximum_distance:
                continue
            if hits:
                if frame_distance(current[idx][1], current[last][1]) > 14.0:
                    changes += 1
            else:
                first = idx
            last = idx
            hits += 1
            total += diff
        consider()
    return best


def refine_window(current, reference, best):
    first = next((i for i, (t, _) in enumerate(current) if t == best["start"]), -1)
    last = next((i for i, (t, _) in enumerate(current) if t == best["end"]), -1)
    if first < 0 or last < 0:
        return {"start": best["start"], "end": best["end"]}

    def matches(idx):
        return aligned_distance(current[idx][1], reference, idx + best["offset"]) <= 30.0

    while first > 0 and matches(first - 1):
        first -= 1
    while last < len(current) - 1 and matches(last + 1):
        last += 1

    start = (current[first - 1][0] + current[first][0]) / 2.0 if first > 0 else max(0.0, current[first][0] - 0.5)
    end = (current[last][0] + current[last + 1][0]) / 2.0 if last < len(current) - 1 else current[last][0] + 0.5
    return {"start": round(start, 2), "end": round(end, 2), "source": "frame-match"}


def match_video_themes(current_fp, reference_fp):
    themes = {}
    for part, min_sec in (("op", 70.0), ("ed", 60.0)):
        cur_frames = decode_samples(current_fp.get(part) or {})
        ref_frames = decode_samples(reference_fp.get(part) or {})
        if not cur_frames or not ref_frames:
            continue
        subsampled = cur_frames[::INTERVAL]
        best = match_window(subsampled, ref_frames, min_sec)
        if best:
            themes[part] = refine_window(cur_frames, ref_frames, best)
    # Join with the song match: the song can start under the last scene (only the picture repeats)
    # and credits can run over new footage (only the song repeats). Same rule as mergeEndings() in
    # src/japanese/video-themes.ts.
    song = audio_print.match_prints(
        audio_print.decode(current_fp.get("edAudio")),
        audio_print.decode(reference_fp.get("edAudio")),
    )
    if song:
        picture, sung = themes.get("ed"), song[0]
        if not picture or picture["start"] >= sung["end"] or sung["start"] >= picture["end"]:
            themes["ed"] = sung
        else:
            joined = {"start": min(picture["start"], sung["start"]), "end": max(picture["end"], sung["end"])}
            themes["ed"] = joined if joined["end"] - joined["start"] <= 130 else picture
    return themes


def process_job(base_url, node_id, job, ffmpeg_bin, ffprobe_bin):
    job_id = job["jobId"]
    video_url = urljoin(base_url, job["url"])

    def report_progress(pct):
        try:
            http_json(urljoin(base_url, "worker/progress"), {
                "jobId": job_id,
                "nodeId": node_id,
                "progress": pct,
            }, timeout=10)
        except OSError:
            pass

    report_progress(5)
    has_ref = bool(job.get("referenceSamples"))
    current_fp = fingerprint_video(
        video_url,
        job.get("durationHint"),
        ffmpeg_bin,
        ffprobe_bin,
        progress_cb=lambda f: report_progress(5 + int(f * (45 if not has_ref else 80))),
    )

    ref_fp = job.get("referenceSamples")
    ref_ep = job.get("referenceEpisode")
    sampled_ref = None
    if not ref_fp and ref_ep:
        ref_url = urljoin(base_url, ref_ep["url"])
        sampled_ref = fingerprint_video(
            ref_url,
            None,
            ffmpeg_bin,
            ffprobe_bin,
            progress_cb=lambda f: report_progress(50 + int(f * 35)),
        )
        ref_fp = sampled_ref

    report_progress(90)
    # Newer coordinators send several references (nearest episodes first); take the first match of
    # each part, so one unusual episode (no opening, special ending) doesn't hide the others.
    references = [ref for ref in (job.get("referenceSamplesList") or []) if isinstance(ref, dict)] or ([ref_fp] if ref_fp else [])
    themes = {}
    for reference in references:
        for part, found in match_video_themes(current_fp, reference).items():
            themes.setdefault(part, found)
        if "op" in themes and "ed" in themes:
            break
    report_progress(98)

    complete_payload = {
        "jobId": job_id,
        "nodeId": node_id,
        "themes": themes,
        "samples": current_fp,
    }
    if sampled_ref is not None and ref_ep:
        complete_payload["referenceEpisode"] = ref_ep["episode"]
        complete_payload["referenceSamples"] = sampled_ref

    http_json(urljoin(base_url, "worker/complete"), complete_payload, timeout=60)
    return themes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("server_url", help="Base URL of serve.py, e.g. http://192.168.1.10:46158/<token>/")
    parser.add_argument("--node-name", default=socket.gethostname(), help="Display name for this worker node")
    parser.add_argument("--node-id", default=f"mac-{socket.gethostname()}", help="Unique ID for this worker node")
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg")
    parser.add_argument("--ffprobe", default=shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--once", action="store_true", help="Exit when no jobs are pending")
    args = parser.parse_args()

    base_url = args.server_url if args.server_url.endswith("/") else f"{args.server_url}/"
    print(f"Mac worker '{args.node_name}' ({args.node_id}) connecting to {base_url}", flush=True)

    while True:
        try:
            res = http_json(urljoin(base_url, "worker/claim"), {
                "nodeId": args.node_id,
                "nodeName": args.node_name,
                "platform": "mac",
                "kinds": ["probe", "fingerprint"],
                "caps": ["ffmpeg", "ffprobe"],
            }, timeout=20)
            job = res.get("job")
            if not job:
                if args.once:
                    print("No pending jobs; exiting.", flush=True)
                    break
                time.sleep(args.poll_interval)
                continue

            kind = job.get("kind", "fingerprint")
            print(f"Claimed {kind} {job['seriesName']} :: {job['episode']} ({job['jobId']})", flush=True)
            try:
                if kind == "probe":
                    probe = process_probe_job(base_url, args.node_id, job, args.ffprobe)
                    print(f"Probed {job['episode']} -> {probe['videoCodec']}/{probe['audioCodec']} "
                          f"{probe['duration']:.0f}s tvSafe={probe['tvSafe']}", flush=True)
                    continue
                themes = process_job(base_url, args.node_id, job, args.ffmpeg, args.ffprobe)
                print(f"Completed {job['episode']} -> {themes}", flush=True)
            except Exception as exc:
                print(f"Failed {job['episode']}: {exc}", flush=True)
                try:
                    http_json(urljoin(base_url, "worker/complete"), {
                        "jobId": job["jobId"],
                        "nodeId": args.node_id,
                        "error": str(exc),
                    }, timeout=15)
                except OSError:
                    pass
        except KeyboardInterrupt:
            print("\nWorker stopped.", flush=True)
            break
        except (URLError, OSError, ValueError) as exc:
            print(f"Coordinator unreachable ({exc}); retrying in {args.poll_interval}s...", flush=True)
            if args.once:
                break
            time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
