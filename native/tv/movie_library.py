"""Save Movies & TV streams into the Mac library, so they behave like downloaded anime.

A saved movie or episode is downloaded from the Stremio streaming server, converted to MP4 with
ffmpeg (video copied when it is H.264 or HEVC, audio made AAC, a text subtitle kept as .srt) and
filed as a series folder of the library:

    <library>/Dune (2021)/Dune (2021).mp4
    <library>/Breaking Bad - Season 1/Episode 001 - S01E01 Pilot.mp4

Each folder gets poster.jpg and movies-tv.json ({title, franchise, aired}), which catalog.json
passes on so every app groups a show's seasons together. From then on progress sync, Continue
watching, the TV and phone libraries and Download to the phone work exactly as for anime.

The queue is kept in ~/Library/Application Support/AnimeStudy/movie-downloads.json and runs one
file at a time; a partly downloaded file resumes after a restart.
"""

import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from native.tv.stremio import HASH_RE, ID_RE, STREMIO_SERVER, USER_AGENT

SIDECAR = "movies-tv.json"
PARTIAL_DIR = ".movies-tv-partial"
COPY_VIDEO = {"h264", "hevc"}
COPY_AUDIO = {"aac", "mp3", "ac3", "eac3", "alac"}
TEXT_SUBTITLES = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
POSTER_HOSTS = ("images.metahub.space", "image.tmdb.org", "m.media-amazon.com")
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"


def safe_name(text, limit=80):
    """A folder or file name from a title: no path separators, nothing hidden, not too long."""
    cleaned = re.sub(r'[/\\:*?"<>|\x00-\x1f]', " ", str(text))
    cleaned = " ".join(cleaned.split()).strip(". ") or "Untitled"
    return cleaned[:limit].rstrip(". ")


def target_paths(item):
    """(folder name, file stem, sidecar) for a saved movie or episode."""
    name = safe_name(item.get("name") or "Untitled")
    year = re.match(r"\d{4}", str(item.get("year") or ""))
    if item.get("type") == "series":
        season, episode = int(item["season"]), int(item["episode"])
        folder = f"{name} - Specials" if season == 0 else f"{name} - Season {season}"
        stem = f"Episode {episode:03d} - S{season:02d}E{episode:02d} {safe_name(item.get('episodeName') or '', 60)}".rstrip()
        sidecar = {"title": f"{item.get('name')} Specials" if season == 0 else f"{item.get('name')} Season {season}",
                   "franchise": f"imdb:{item['showId']}", "aired": 9999 if season == 0 else season}
    else:
        folder = f"{name} ({year.group(0)})" if year else name
        stem = folder
        sidecar = {"title": folder}
    return folder, stem, sidecar


def convert_command(probe, source, output):
    """The ffmpeg command that turns a downloaded file into a phone- and TV-friendly MP4."""
    streams = probe.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if not video:
        raise ValueError("no video in this file")
    english = next((s for s in audios if (s.get("tags") or {}).get("language") in ("eng", "en")), None)
    audio = english or (audios[0] if audios else None)
    command = [FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-i", str(source), "-map", f"0:{video['index']}"]
    if video.get("codec_name") in COPY_VIDEO:
        command += ["-c:v", "copy"]
        if video.get("codec_name") == "hevc":
            command += ["-tag:v", "hvc1"]  # Apple players need hvc1 to play HEVC in MP4
    else:
        command += ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    if audio:
        command += ["-map", f"0:{audio['index']}"]
        if audio.get("codec_name") in COPY_AUDIO and int(audio.get("channels") or 2) <= 6:
            command += ["-c:a", "copy"]
        else:
            command += ["-c:a", "aac", "-b:a", "256k", "-ac", str(min(6, int(audio.get("channels") or 2)))]
    command += ["-sn", "-dn", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", str(output)]
    return command


def subtitle_command(probe, source, output):
    """An ffmpeg command for the best text subtitle (English first) as .srt, or None."""
    subs = [s for s in probe.get("streams") or [] if s.get("codec_type") == "subtitle" and s.get("codec_name") in TEXT_SUBTITLES]
    if not subs:
        return None
    english = [s for s in subs if (s.get("tags") or {}).get("language") in ("eng", "en")]
    plain = [s for s in english if not (s.get("disposition") or {}).get("forced")]
    best = (plain or english or subs)[0]
    return [FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-i", str(source), "-map", f"0:{best['index']}", "-c:s", "srt", str(output)]


def validate_request(body):
    """The job a phone asked for, checked field by field."""
    stream = body.get("stream") if isinstance(body.get("stream"), dict) else {}
    item = body.get("item") if isinstance(body.get("item"), dict) else {}
    info_hash = str(stream.get("infoHash") or "")
    file_idx = stream.get("fileIdx", -1)
    if not HASH_RE.fullmatch(info_hash) or not isinstance(file_idx, int) or file_idx < -1:
        raise ValueError("bad stream")
    if item.get("type") not in ("movie", "series") or not ID_RE.fullmatch(str(item.get("id") or "")):
        raise ValueError("bad title")
    job = {
        "type": item["type"],
        "itemId": item["id"],
        "name": str(item.get("name") or "Untitled")[:200],
        "year": str(item.get("year") or "")[:12],
        "poster": item.get("poster") if isinstance(item.get("poster"), str) else None,
        "infoHash": info_hash,
        "fileIdx": file_idx,
        "quality": str(stream.get("quality") or "")[:60],
        "release": str(stream.get("title") or "")[:300],
    }
    if item["type"] == "series":
        show = str(item.get("showId") or item["id"].split(":")[0])
        if not re.fullmatch(r"tt\d{1,10}", show) or not all(isinstance(item.get(k), int) and 0 <= item[k] < 10000 for k in ("season", "episode")):
            raise ValueError("bad episode")
        job.update(showId=show, season=item["season"], episode=item["episode"],
                   episodeName=str(item.get("episodeName") or "")[:200])
    return job


class MovieLibrary:
    def __init__(self, library_folder, state_path, on_change=lambda event: None):
        self.folder = Path(library_folder)
        self.path = Path(state_path)
        self.on_change = on_change
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.cancelled = set()
        try:
            data = json.loads(self.path.read_text("utf-8"))
            self.jobs = [job for job in data.get("jobs", []) if isinstance(job, dict) and job.get("id")]
        except (OSError, ValueError, AttributeError):
            self.jobs = []
        for job in self.jobs:  # a restart interrupts whatever was running; it resumes
            if job.get("state") in ("downloading", "converting"):
                job["state"] = "queued"
        threading.Thread(target=self._run, daemon=True).start()

    # ----- queue -----

    def _save_locked(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"jobs": self.jobs[-300:]}, indent=1), "utf-8")
            tmp.replace(self.path)
        except OSError:
            pass

    def _public(self, job):
        public = self._fields(job)
        if job.get("state") == "done" and not public.get("file"):
            try:
                public["file"] = target_paths(job)[1] + ".mp4"
            except (KeyError, ValueError, TypeError):
                pass
        return public

    def _fields(self, job):
        return {key: job.get(key) for key in ("id", "type", "itemId", "showId", "poster", "name", "year", "season", "episode", "episodeName",
                                               "quality", "state", "fraction", "error", "folder", "file", "addedAt", "doneAt")}

    def listing(self):
        with self.lock:
            return {"jobs": [self._public(job) for job in reversed(self.jobs)]}

    def _notify(self, job):
        self.on_change({"type": "movie_download", **self._public(job)})

    def add(self, body):
        job = validate_request(body)
        with self.lock:
            for existing in self.jobs:
                if existing["itemId"] == job["itemId"] and existing.get("state") in ("queued", "downloading", "converting", "done"):
                    return self._public(existing)
            job.update(id=uuid.uuid4().hex[:12], state="queued", fraction=0.0, error=None, addedAt=time.time())
            self.jobs.append(job)
            self._save_locked()
        self.wake.set()
        self._notify(job)
        return self._public(job)

    def cancel(self, job_id):
        with self.lock:
            job = next((item for item in self.jobs if item["id"] == job_id), None)
            if not job:
                return False
            if job.get("state") in ("downloading", "converting"):
                self.cancelled.add(job_id)
            self.jobs.remove(job)
            self._save_locked()
        self._partial(job).unlink(missing_ok=True)
        self.on_change({"type": "movie_download", "id": job_id, "state": "removed"})
        return True

    def retry(self, job_id):
        with self.lock:
            job = next((item for item in self.jobs if item["id"] == job_id and item.get("state") == "failed"), None)
            if not job:
                return False
            job.update(state="queued", error=None)
            self._save_locked()
        self.wake.set()
        self._notify(job)
        return True

    def _update(self, job, **fields):
        with self.lock:
            job.update(fields)
            self._save_locked()
        self._notify(job)

    def _run(self):
        while True:
            with self.lock:
                job = next((item for item in self.jobs if item.get("state") == "queued"), None)
            if not job:
                self.wake.wait(30)
                self.wake.clear()
                continue
            try:
                self._process(job)
            except Exception as error:  # noqa: BLE001 - one bad file must not stop the queue
                if job["id"] in self.cancelled:
                    self.cancelled.discard(job["id"])
                else:
                    self._update(job, state="failed", error=str(error)[:300] or type(error).__name__)

    # ----- one job -----

    def _partial(self, job):
        return self.folder / PARTIAL_DIR / f"{job['id']}.part"

    def _check_cancel(self, job):
        if job["id"] in self.cancelled:
            raise InterruptedError("cancelled")

    def _download(self, job, partial):
        partial.parent.mkdir(parents=True, exist_ok=True)
        have = partial.stat().st_size if partial.exists() else 0
        url = f"{STREMIO_SERVER}/{job['infoHash']}/{job['fileIdx']}"
        request = Request(url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={have}-"})
        try:
            response = urlopen(request, timeout=120)
        except OSError as error:
            if getattr(error, "code", None) == 416 and have:
                return  # already complete
            raise ConnectionError("Start the Stremio app on the Mac to save torrents.") from error
        with response:
            total = None
            if response.status == 206 and (match := re.search(r"/(\d+)$", response.headers.get("Content-Range", ""))):
                total = int(match.group(1))
            elif response.status == 200:
                have = 0
                total = int(response.headers.get("Content-Length") or 0) or None
            last = 0.0
            with partial.open("ab" if have else "wb") as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
                    have += len(chunk)
                    self._check_cancel(job)
                    if total and time.time() - last > 2:
                        last = time.time()
                        self._update(job, fraction=round(0.9 * have / total, 4))
            if total and have < total:
                raise ConnectionError("The download stopped early; retry to resume it.")

    def _poster(self, job, folder):
        target = folder / "poster.jpg"
        poster = job.get("poster")
        if target.exists() or not poster or not poster.startswith("https://") or urlsplit(poster).hostname not in POSTER_HOSTS:
            return
        try:
            with urlopen(Request(poster, headers={"User-Agent": USER_AGENT}), timeout=15) as response:
                data = response.read(10_000_000)
            if data:
                (folder / "poster.jpg.tmp").write_bytes(data)
                (folder / "poster.jpg.tmp").replace(target)
        except OSError:
            pass

    def _process(self, job):
        folder_name, stem, sidecar = target_paths(job)
        folder = self.folder / folder_name
        output = folder / f"{stem}.mp4"
        if output.exists():
            self._update(job, state="done", fraction=1.0, folder=folder_name, file=output.name, doneAt=time.time())
            return
        partial = self._partial(job)
        self._update(job, state="downloading", folder=folder_name)
        self._download(job, partial)
        self._check_cancel(job)
        self._update(job, state="converting", fraction=0.9)
        probe = json.loads(subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", str(partial)],
                                          capture_output=True, timeout=120, check=True).stdout or b"{}")
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f".{stem}.mp4.tmp"
        result = subprocess.run(convert_command(probe, partial, tmp), capture_output=True, timeout=6 * 3600)
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg could not convert this file: {result.stderr.decode('utf-8', 'replace')[-200:].strip()}")
        if command := subtitle_command(probe, partial, folder / f"{stem}.srt"):
            subprocess.run(command, capture_output=True, timeout=600)
        (folder / SIDECAR).write_text(json.dumps(sidecar), "utf-8")
        self._poster(job, folder)
        tmp.replace(output)
        partial.unlink(missing_ok=True)
        self._update(job, state="done", fraction=1.0, file=output.name, doneAt=time.time())


def sidecar_info(folder):
    """{title, franchise, aired} for a saved Movies & TV folder, or {} for anything else."""
    try:
        data = json.loads((Path(folder) / SIDECAR).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    info = {"title": str(data["title"])} if data.get("title") else {}
    if isinstance(data.get("franchise"), str):
        info["franchise"] = data["franchise"]
    if isinstance(data.get("aired"), (int, float)):
        info["aired"] = data["aired"]
    return info
