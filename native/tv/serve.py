"""Serve downloaded series to Anime Study TV over a private LAN."""

import argparse
import hashlib
import ipaddress
import json
import re
import secrets
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from native.cast.airplay import lan_address

PROJECT = Path(__file__).resolve().parents[2] / "outputs" / "samsung-tv" / "AnimeStudy"
ASSETS = {"": ("index.html", "text/html; charset=utf-8"), "tv.css": ("tv.css", "text/css; charset=utf-8"),
          "tv.js": ("tv.js", "text/javascript; charset=utf-8"), "icon.png": ("icon.png", "image/png")}
SUBTITLES = (".ass", ".ssa", ".srt", ".vtt")
DEFAULT_FOLDER = Path.home() / "Downloads" / "Arc Anime"
MEDIA_PATH = re.compile(r"(?:(\d+)/)?(\d+)/(video|subtitles)")


def episode_files(folder):
    def order(path):
        return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", path.name.casefold())]
    files = [file for file in folder.iterdir() if file.is_file() and not file.is_symlink()]
    subtitles = {file.stem: file for suffix in reversed(SUBTITLES) for file in files if file.suffix.lower() == suffix}
    return [(file, subtitles.get(file.stem)) for file in sorted(files, key=order)
            if file.suffix.lower() in (".mp4", ".m4v")]


def media_range(header, size):
    if header is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or not any(match.groups()):
        raise ValueError()
    first, last = match.groups()
    start = int(first) if first else max(0, size - int(last))
    end = min(int(last), size - 1) if first and last else size - 1
    if not 0 <= start <= end < size:
        raise ValueError()
    return start, end


class TVHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def log_request(self, code="-", size="-"):
        if not self.server.verbose:
            return
        prefix = f"/{self.server.token}/"
        resource = self.path[len(prefix):] if self.path.startswith(prefix) else None
        if resource in ASSETS:
            label = ASSETS[resource][0]
        elif resource in ("library.json", "catalog.json") or (resource and MEDIA_PATH.fullmatch(resource)):
            label = resource
        else:
            label = "unknown resource"
        method = self.command if self.command in ("GET", "HEAD") else "unsupported method"
        print(f"{method} {label} → {code}", flush=True)

    def respond(self, content_type, length, code=200, **headers):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()

    def do_HEAD(self):
        self.serve()

    def do_GET(self):
        self.serve()

    def serve(self):
        path = urlsplit(self.path).path
        prefix = f"/{self.server.token}/"
        if not path.startswith(prefix):
            return self.send_error(404)
        resource = path[len(prefix):]
        try:
            if resource in ("library.json", "catalog.json"):
                payload = self.server.library(0) if resource == "library.json" else self.server.catalog()
                data = json.dumps(payload).encode("utf-8")
                self.respond("application/json; charset=utf-8", len(data))
                if self.command == "GET":
                    self.wfile.write(data)
            elif resource in ASSETS:
                name, content_type = ASSETS[resource]
                self.send_file(PROJECT / name, content_type)
            else:
                match = MEDIA_PATH.fullmatch(resource)
                if not match:
                    return self.send_error(404)
                series, index, kind = match.groups()
                folder, episodes = self.server.series[int(series or 0)]
                video, subtitle = episodes[int(index)]
                file = video if kind == "video" else subtitle
                if (not file or folder.is_symlink() or folder.resolve() != folder or
                        file.is_symlink() or file.resolve().parent != folder):
                    return self.send_error(404)
                self.send_file(file, "video/mp4" if kind == "video" else "text/plain; charset=utf-8")
        except (FileNotFoundError, IndexError):
            self.send_error(404)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, file, content_type):
        with file.open("rb") as source:
            size = file.stat().st_size
            requested = self.headers.get("Range")
            try:
                start, end = media_range(requested, size)
            except ValueError:
                return self.respond(content_type, 0, 416, **{"Content-Range": f"bytes */{size}"})
            length = end - start + 1
            headers = {"Accept-Ranges": "bytes"}
            if requested:
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            self.respond(content_type, length, 206 if requested else 200, **headers)
            if self.command == "GET":
                if not requested:
                    shutil.copyfileobj(source, self.wfile, 256 * 1024)
                    return
                source.seek(start)
                while length > 0:
                    chunk = source.read(min(length, 256 * 1024))
                    if not chunk:
                        return
                    self.wfile.write(chunk)
                    length -= len(chunk)


class TVServer(ThreadingHTTPServer):
    def __init__(self, address, folder, metadata, verbose=False):
        self.metadata = metadata
        self.series = []
        for candidate in [folder, *sorted(folder.iterdir(), key=lambda path: path.name.casefold())]:
            if candidate.is_symlink() or not candidate.is_dir():
                continue
            episodes = episode_files(candidate)
            if episodes:
                self.series.append((candidate, episodes))
        if not self.series:
            raise ValueError("No MP4 or M4V episodes in this folder or its series folders.")
        if metadata and len(self.series) != 1:
            raise ValueError("Use --metadata with one series folder, or put anime-study-tv.json in each series folder.")
        self.token = secrets.token_hex(8)
        self.verbose = verbose
        super().__init__(address, TVHandler)

    def catalog(self):
        return {"version": 1, "series": [self.library(index) for index in range(len(self.series))]}

    def library(self, index):
        folder, episodes = self.series[index]
        metadata = self.metadata or folder / "anime-study-tv.json"
        prefix = f"{index}/" if index else ""
        try:
            saved = json.loads(metadata.read_text(encoding="utf-8")) if metadata.stat().st_size < 1_000_000 else {}
            if not isinstance(saved, dict) or saved.get("version") != 1:
                saved = {}
        except (OSError, ValueError):
            saved = {}
        items = saved.get("episodes", {})
        if not isinstance(items, dict):
            items = {}
        return {
            "id": hashlib.sha256(str(folder).encode()).hexdigest()[:16],
            "title": saved.get("title") or folder.name,
            "autoSkip": saved.get("autoSkip", {}),
            "endingAction": saved.get("endingAction", "auto"),
            "episodes": [{
                "name": file.name,
                "video": f"{prefix}{number}/video",
                "subtitles": f"{prefix}{number}/subtitles" if subtitle else None,
                "saved": items.get(file.name, {})
            } for number, (file, subtitle) in enumerate(episodes)]
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", nargs="?", type=Path, default=DEFAULT_FOLDER,
                        help="Series or library folder (defaults to ~/Downloads/Arc Anime)")
    parser.add_argument("--metadata", type=Path, help="Optional Anime Study TV playback data JSON")
    parser.add_argument("--host", type=ipaddress.IPv4Address, help="Private LAN address to listen on (defaults to the active route)")
    parser.add_argument("--port", type=int, default=46158)
    parser.add_argument("--verbose", action="store_true", help="Log request types and HTTP statuses")
    options = parser.parse_args()
    host = options.host or ipaddress.IPv4Address(lan_address())
    if not (host.is_loopback or any(host in ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
        parser.error("Use a private network address.")
    folder = options.folder.expanduser().resolve()
    metadata = options.metadata.expanduser() if options.metadata else None
    try:
        with TVServer((str(host), options.port), folder, metadata, options.verbose) as server:
            print(f"Anime Study TV: http://{host}:{server.server_port}/{server.token}/", flush=True)
            count = sum(len(episodes) for _, episodes in server.series)
            print(f"{len(server.series)} series · {count} episodes. Keep this command running while watching.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
