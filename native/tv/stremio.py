"""Movies and TV for Anime Study TV through Stremio's open add-on protocol.

Titles and episode lists come from Cinemeta (Stremio's catalog add-on), torrents for a title from
Torrentio, and playback from the Stremio app's local streaming server, which turns a torrent into
an HTTP video stream with range requests. The Mac server only relays: the TV never talks to these
services directly, so the token and private-network checks still cover everything.

Set ANIME_STUDY_TORRENTIO to a configured Torrentio address (from torrentio.strem.fun/configure,
without /manifest.json) to use your own provider, quality or debrid options.
"""

import json
import os
import re
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

CINEMETA = "https://v3-cinemeta.strem.io"
TORRENTIO = os.environ.get("ANIME_STUDY_TORRENTIO", "https://torrentio.strem.fun").rstrip("/").removesuffix("/manifest.json")
STREMIO_SERVER = os.environ.get("ANIME_STUDY_STREMIO_SERVER", "http://127.0.0.1:11470").rstrip("/")
TYPES = ("movie", "series")
ID_RE = re.compile(r"tt\d{1,10}(?::\d{1,4}:\d{1,5})?")
HASH_RE = re.compile(r"[a-f0-9]{40}")
MAX_STREAMS = 40
USER_AGENT = "Mozilla/5.0 (AnimeStudy)"
# Used when Torrentio gives no peer sources of its own (its default answer has none).
TRACKERS = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.stealth.si:80/announce",
)
# Formats a Samsung TV usually cannot decode in its web player. Such streams are listed last.
RISKY = re.compile(r"\b(?:dts(?:-?hd)?|truehd|av1|3d|cam(?:rip)?|hdcam|telesync|hdts|ts(?:rip)?)\b", re.I)
SEEDERS = re.compile(r"👤\s*(\d+)")
SIZE = re.compile(r"💾\s*([\d.]+\s*[KMGT]B)", re.I)


def fetch_json(url, timeout=20):
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8_388_608).decode("utf-8"))


def valid_type(kind):
    if kind not in TYPES:
        raise ValueError("type must be movie or series")
    return kind


def valid_id(item_id):
    if not isinstance(item_id, str) or not ID_RE.fullmatch(item_id):
        raise ValueError("unsupported id")
    return item_id


def title_card(meta):
    """The fields the TV shows for one search or catalog result."""
    if not isinstance(meta, dict) or not ID_RE.fullmatch(str(meta.get("id") or "")) or meta.get("type") not in TYPES:
        return None
    poster = meta.get("poster")
    return {
        "id": meta["id"],
        "type": meta["type"],
        "name": str(meta.get("name") or meta["id"]),
        "year": str(meta.get("releaseInfo") or meta.get("year") or ""),
        "poster": poster if isinstance(poster, str) and poster.startswith("https://") else None,
    }


def catalog_cards(payload):
    metas = payload.get("metas") if isinstance(payload, dict) else None
    return [card for card in map(title_card, metas or []) if card]


def search(kind, query):
    query = " ".join(str(query or "").split())[:100]
    kind = valid_type(kind)
    path = f"/catalog/{kind}/top/search={quote(query, safe='')}.json" if query else f"/catalog/{kind}/top.json"
    return catalog_cards(fetch_json(CINEMETA + path))


def series_meta(payload):
    """A Cinemeta meta answer reduced to the title and its episodes in season order (specials last)."""
    meta = payload.get("meta") if isinstance(payload, dict) else None
    if not isinstance(meta, dict):
        raise ValueError("no meta")
    card = title_card(meta) or {}
    episodes = []
    for video in meta.get("videos") or []:
        if not isinstance(video, dict) or not ID_RE.fullmatch(str(video.get("id") or "")):
            continue
        season = video.get("season")
        number = video.get("number", video.get("episode"))
        if not isinstance(season, int) or not isinstance(number, int):
            continue
        episodes.append({"id": video["id"], "season": season, "episode": number,
                         "name": str(video.get("name") or video.get("title") or f"Episode {number}")})
    episodes.sort(key=lambda ep: (ep["season"] == 0, ep["season"], ep["episode"]))
    return {**card, "episodes": episodes}


def meta(kind, item_id):
    kind, item_id = valid_type(kind), valid_id(item_id)
    return series_meta(fetch_json(f"{CINEMETA}/meta/{kind}/{quote(item_id, safe=':')}.json"))


def stream_option(stream):
    """One Torrentio stream as the TV lists it, or None when it is not a playable torrent."""
    if not isinstance(stream, dict):
        return None
    info_hash = str(stream.get("infoHash") or "").lower()
    if not HASH_RE.fullmatch(info_hash):
        return None
    file_idx = stream.get("fileIdx")
    file_idx = file_idx if isinstance(file_idx, int) and file_idx >= 0 else -1
    title = str(stream.get("title") or stream.get("description") or "")
    lines = [line.strip() for line in title.split("\n") if line.strip()]
    hints = stream.get("behaviorHints") if isinstance(stream.get("behaviorHints"), dict) else {}
    filename = str(hints.get("filename") or "")
    seeders = SEEDERS.search(title)
    size = SIZE.search(title)
    details = " ".join(filter(None, [lines[0] if lines else "", filename]))
    quality = " ".join(str(stream.get("name") or "").replace("Torrentio", "").split()) or "Unknown"
    # Samsung TVs have no Dolby Vision; DV files without an HDR10 layer show wrong colours or fail.
    dolby_only = bool(re.search(r"\bDV\b", quality)) and "HDR" not in quality
    sources = [s for s in stream.get("sources") or [] if isinstance(s, str) and re.fullmatch(r"(?:tracker:|dht:)[^\s]{1,300}", s)]
    return {
        "infoHash": info_hash,
        "fileIdx": file_idx,
        "quality": quality,
        "title": filename or (lines[0] if lines else info_hash),
        "release": lines[0] if lines else "",
        "seeders": int(seeders.group(1)) if seeders else None,
        "size": size.group(1) if size else None,
        "risky": dolby_only or bool(RISKY.search(details)),
        "sources": sources,
    }


def stream_rank(option):
    """TV-friendly order: formats the TV plays first, then 1080p, 720p, 4K, anything else; most seeders first."""
    quality = option["quality"].lower()
    tier = next((i for i, mark in enumerate(("1080p", "720p", "4k")) if mark in quality), 3)
    return option["risky"], tier, -(option["seeders"] or 0)


def stream_options(payload):
    """Playable torrents with seeders, best for streaming to a TV first."""
    options = [option for option in map(stream_option, (payload or {}).get("streams") or []) if option]
    options = [option for option in options if option["seeders"] != 0]
    options.sort(key=stream_rank)
    return options[:MAX_STREAMS]


class Stremio:
    """Relays Cinemeta, Torrentio and the local Stremio streaming server for the TV."""

    def __init__(self):
        self.lock = threading.Lock()
        self.sources = {}  # info hash -> peer sources from the last stream listing
        self.created = set()

    def status(self):
        try:
            with urlopen(Request(f"{STREMIO_SERVER}/settings", headers={"User-Agent": USER_AGENT}), timeout=3):
                pass
            running = True
        except HTTPError:
            running = True  # it answered, so it is running
        except (URLError, OSError):
            running = False
        return {"server": running, "torrentio": "default" if TORRENTIO == "https://torrentio.strem.fun" else "custom"}

    def search(self, kind, query):
        return {"results": search(kind, query)}

    def meta(self, kind, item_id):
        return meta(kind, item_id)

    def streams(self, kind, item_id):
        kind, item_id = valid_type(kind), valid_id(item_id)
        options = stream_options(fetch_json(f"{TORRENTIO}/stream/{kind}/{quote(item_id, safe=':')}.json", timeout=30))
        with self.lock:
            for option in options:
                self.sources[option["infoHash"]] = option.pop("sources")
        return {"streams": options}

    def prepare(self, info_hash):
        """Ask the Stremio server to start the torrent with peer sources (best effort: a plain
        request for the file also starts it, only with fewer peers at first)."""
        with self.lock:
            if info_hash in self.created:
                return
            self.created.add(info_hash)
            sources = self.sources.get(info_hash) or []
        sources = sources or [f"tracker:{tracker}" for tracker in TRACKERS]
        body = json.dumps({"torrent": {"infoHash": info_hash},
                           "peerSearch": {"sources": [f"dht:{info_hash}", *sources], "min": 40, "max": 150},
                           "guessFileIdx": {}}).encode("utf-8")
        try:
            request = Request(f"{STREMIO_SERVER}/{info_hash}/create", data=body, method="POST",
                              headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
            with urlopen(request, timeout=10) as response:
                response.read(65_536)
        except (URLError, OSError, ValueError):
            with self.lock:
                self.created.discard(info_hash)

    def open_stream(self, info_hash, file_idx, method="GET", range_header=None):
        """The Stremio server's response for one file of a torrent; the caller relays and closes it."""
        if not HASH_RE.fullmatch(info_hash) or file_idx < -1:
            raise ValueError("bad stream")
        self.prepare(info_hash)
        headers = {"User-Agent": USER_AGENT}
        if range_header:
            headers["Range"] = range_header
        request = Request(f"{STREMIO_SERVER}/{info_hash}/{file_idx}", headers=headers, method=method)
        try:
            return urlopen(request, timeout=90)
        except HTTPError as error:
            return error  # 416 and friends are relayed as they are
