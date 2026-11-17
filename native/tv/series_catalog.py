"""What a downloaded series is, from public anime databases keyed by ids we already have.

Mirrors shared/gallery/series-catalog.ts: the smotret-anime id in a folder name gives the full
title (folder names are cut at 60 characters) and the MyAnimeList id; Shikimori, which uses
MyAnimeList ids, gives the franchise and when each part aired. Phones and the TV get this in
catalog.json so every app groups seasons the same way.

Lookups run in a background thread and are cached on disk; catalog.json only ever reads the cache.
"""

import json
import queue
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

SMOTRET = "https://smotret-anime.com/api/series/"
SHIKIMORI = "https://shikimori.io/api/animes/"
USER_AGENT = "AnimeStudyTV/1.0"
RETRY_SECONDS = 5 * 60
# Shikimori allows 5 requests a second; lookups run one at a time with a gap.
REQUEST_GAP_SECONDS = 0.4


def _get_json(url, timeout=8):
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout) as resp:
        return json.loads(resp.read(2_000_000).decode("utf-8"))


class SeriesCatalog:
    def __init__(self, path, fetch_json=_get_json):
        self.path = Path(path)
        self.fetch_json = fetch_json
        self.lock = threading.Lock()
        self.pending = set()
        self.failed = {}
        self.queue = queue.Queue()
        self.worker = None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        self.series = data.get("series", {}) if isinstance(data, dict) else {}
        self.franchises = data.get("franchises", {}) if isinstance(data, dict) else {}

    def info(self, series_id):
        """Cached {title, franchise, aired} for a smotret-anime id; starts a lookup when missing."""
        if not series_id:
            return {}
        with self.lock:
            known = self.series.get(series_id)
            if known and known.get("franchise"):
                return dict(known)
            retry = time.time() - self.failed.get(series_id, 0) > RETRY_SECONDS
            if series_id not in self.pending and retry:
                self.pending.add(series_id)
                self.queue.put(series_id)
                if not self.worker or not self.worker.is_alive():
                    self.worker = threading.Thread(target=self._work, daemon=True)
                    self.worker.start()
        return dict(known or {})

    def _work(self):
        # One daemon worker for the server's lifetime; it sleeps on the queue when idle.
        while True:
            series_id = self.queue.get()
            self._lookup(series_id)
            time.sleep(REQUEST_GAP_SECONDS)

    def lookup_now(self, series_id):
        """Synchronous lookup (tests and warm-up)."""
        self._lookup(series_id)
        return self.series.get(series_id, {})

    def _lookup(self, series_id):
        try:
            data = (self.fetch_json(f"{SMOTRET}{series_id}") or {}).get("data") or {}
            entry = {}
            romaji = (data.get("titles") or {}).get("romaji")
            if isinstance(romaji, str) and romaji.strip():
                entry["title"] = romaji.strip()
            mal_id = data.get("myAnimeListId")
            if isinstance(mal_id, int) and mal_id > 0:
                try:
                    entry.update(self._franchise(mal_id))
                except (OSError, ValueError):
                    pass
            with self.lock:
                if entry:
                    self.series[series_id] = entry
                if not entry.get("franchise"):
                    self.failed[series_id] = time.time()
                self._save()
        except (OSError, ValueError, AttributeError):
            with self.lock:
                self.failed[series_id] = time.time()
        finally:
            with self.lock:
                self.pending.discard(series_id)

    def _franchise(self, mal_id):
        key = str(mal_id)
        with self.lock:
            cached = self.franchises.get(key)
        if cached:
            return cached
        time.sleep(REQUEST_GAP_SECONDS)
        payload = self.fetch_json(f"{SHIKIMORI}{mal_id}/franchise") or {}
        nodes = [node for node in payload.get("nodes") or [] if isinstance(node.get("id"), int)]
        # A series with no relations is its own franchise.
        franchise = str(min(node["id"] for node in nodes)) if nodes else key
        found = {"franchise": franchise}
        with self.lock:
            for node in nodes:
                entry = {"franchise": franchise}
                if isinstance(node.get("date"), (int, float)):
                    entry["aired"] = int(node["date"])
                self.franchises[str(node["id"])] = entry
                if node["id"] == mal_id:
                    found = entry
            self.franchises[key] = found
        return found

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"series": self.series, "franchises": self.franchises}, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass
