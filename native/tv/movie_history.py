"""What was watched in Movies & TV and how far: resume points and Continue watching.

The TV reports progress for the stream it plays; the Mac keeps the newest report per movie or
episode in ~/Library/Application Support/AnimeStudy/movie-history.json, together with what is
needed to start it again (the stream, title, poster). Phones and the TV read it to resume and to
list Continue watching, one entry per show (its latest episode).
"""

import json
import re
import threading
import time
from pathlib import Path

from native.tv.stremio import ID_RE

MAX_ITEMS = 500
STREAM_PATH = re.compile(r"stremio/play/[a-f0-9]{40}/(?:-1|\d{1,5})")


def clean_entry(body):
    """A progress report from the TV, checked field by field."""
    item_id = str(body.get("id") or "")
    path = str(body.get("path") or "")
    if not ID_RE.fullmatch(item_id) or not STREAM_PATH.fullmatch(path):
        raise ValueError("bad progress report")
    position = body.get("position")
    duration = body.get("duration")
    if not isinstance(position, (int, float)) or position < 0:
        raise ValueError("bad position")
    poster = body.get("poster")
    entry = {
        "id": item_id,
        "showId": item_id.split(":")[0],
        "type": "series" if ":" in item_id else "movie",
        "title": str(body.get("title") or "")[:200],
        "label": str(body.get("label") or "")[:200],
        "poster": poster if isinstance(poster, str) and poster.startswith("https://") else None,
        "path": path,
        "bingeGroup": str(body.get("bingeGroup") or "")[:200] or None,
        "position": float(position),
        "duration": float(duration) if isinstance(duration, (int, float)) and duration > 0 else None,
        "finished": bool(body.get("finished")),
        "watchedAt": float(body["watchedAt"]) if isinstance(body.get("watchedAt"), (int, float)) else time.time() * 1000,
    }
    return entry


def continue_watching(items):
    """Newest first, one per show: its latest episode (or the movie), left out once finished
    unless a later episode exists to go on with (the TV finds that one)."""
    seen, result = set(), []
    for entry in sorted(items, key=lambda e: e["watchedAt"], reverse=True):
        if entry["showId"] in seen:
            continue
        seen.add(entry["showId"])
        if entry["finished"] and entry["type"] == "movie":
            continue
        result.append(entry)
    return result


class MovieHistory:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        try:
            data = json.loads(self.path.read_text("utf-8"))
            self.items = {key: value for key, value in (data.get("items") or {}).items() if isinstance(value, dict)}
        except (OSError, ValueError, AttributeError):
            self.items = {}

    def record(self, body):
        entry = clean_entry(body)
        with self.lock:
            current = self.items.get(entry["id"])
            if current and current.get("watchedAt", 0) > entry["watchedAt"]:
                return current
            if current and not entry["poster"]:
                entry["poster"] = current.get("poster")
            self.items[entry["id"]] = entry
            if len(self.items) > MAX_ITEMS:
                for key in sorted(self.items, key=lambda k: self.items[k]["watchedAt"])[: len(self.items) - MAX_ITEMS]:
                    del self.items[key]
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps({"items": self.items}), "utf-8")
                tmp.replace(self.path)
            except OSError:
                pass
        return entry

    def listing(self):
        with self.lock:
            items = list(self.items.values())
        return {"continue": continue_watching(items), "items": sorted(items, key=lambda e: e["watchedAt"], reverse=True)}
