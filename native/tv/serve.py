"""Serve downloaded series to Anime Study TV over a private LAN."""

import argparse
import base64
import struct
import threading
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


WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_encode_text(text):
    data = text.encode("utf-8")
    length = len(data)
    if length < 126:
        header = bytes([0x81, length])
    elif length < 65536:
        header = struct.pack("!BBH", 0x81, 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 127, length)
    return header + data


def ws_read_frame(conn):
    head = conn.recv(2)
    if len(head) < 2:
        return None, None
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", conn.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", conn.recv(8))[0]
    if length > 262_144:
        return 0x8, b""
    mask = conn.recv(4) if masked else b""
    payload = bytearray()
    while len(payload) < length:
        chunk = conn.recv(length - len(payload))
        if not chunk:
            return None, None
        payload.extend(chunk)
    if masked:
        for i in range(length):
            payload[i] ^= mask[i % 4]
    return opcode, bytes(payload)


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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        self.serve()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == f"/{self.server.token}/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.handle_websocket()
            return
        self.serve()

    def handle_websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self.send_error(400)
        accept = base64.b64encode(hashlib.sha1((key.strip() + WS_MAGIC).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        conn = self.connection
        self.server.add_ws(conn)
        try:
            while True:
                opcode, payload = ws_read_frame(conn)
                if opcode is None or opcode == 0x8:
                    break
                if opcode == 0x9:
                    conn.sendall(bytes([0x8A, len(payload)]) + payload)
                elif opcode == 0x1:
                    try:
                        event = json.loads(payload.decode("utf-8"))
                        if isinstance(event, dict):
                            if event.get("type") == "sync":
                                self.server.sync_metadata(event)
                            self.server.broadcast(event, exclude=conn)
                    except (ValueError, OSError):
                        pass
        except OSError:
            pass
        finally:
            self.server.remove_ws(conn)

    def do_POST(self):
        path = urlsplit(self.path).path
        prefix = f"/{self.server.token}/"
        if path != f"{prefix}sync":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 262_144:
                return self.send_error(400)
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                return self.send_error(400)
            self.server.sync_metadata(body)
            self.server.broadcast({"type": "sync", **body})
            data = b'{"ok":true}'
            self.respond("application/json; charset=utf-8", len(data))
            self.wfile.write(data)
        except (ValueError, IndexError, OSError):
            self.send_error(400)

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
    def __init__(self, address, folder, metadata, verbose=False, token=None):
        self.folder = folder
        self.metadata = metadata
        self.series = []
        self.refresh_series()
        if not self.series:
            raise ValueError("No MP4 or M4V episodes in this folder or its series folders.")
        if metadata and len(self.series) != 1:
            raise ValueError("Use --metadata with one series folder, or put anime-study-tv.json in each series folder.")
        self.token = token or secrets.token_hex(8)
        self.verbose = verbose
        self.meta_lock = threading.Lock()
        self.ws_lock = threading.Lock()
        self.ws_clients = set()
        super().__init__(address, TVHandler)

    def add_ws(self, conn):
        with self.ws_lock:
            self.ws_clients.add(conn)

    def remove_ws(self, conn):
        with self.ws_lock:
            self.ws_clients.discard(conn)

    def broadcast(self, event, exclude=None):
        frame = ws_encode_text(json.dumps(event))
        with self.ws_lock:
            clients = list(self.ws_clients)
        dead = []
        for client in clients:
            if client is exclude:
                continue
            try:
                client.sendall(frame)
            except OSError:
                dead.append(client)
        if dead:
            with self.ws_lock:
                for client in dead:
                    self.ws_clients.discard(client)

    def refresh_series(self):
        found = []
        for candidate in [self.folder, *sorted(self.folder.iterdir(), key=lambda path: path.name.casefold())]:
            if candidate.is_symlink() or not candidate.is_dir():
                continue
            episodes = episode_files(candidate)
            if episodes:
                found.append((candidate, episodes))
        if found:
            self.series = found

    def _metadata_path(self, index):
        folder, _ = self.series[index]
        return self.metadata or folder / "anime-study-tv.json"

    def _read_saved(self, metadata):
        try:
            saved = json.loads(metadata.read_text(encoding="utf-8")) if metadata.stat().st_size < 1_000_000 else {}
            if not isinstance(saved, dict) or saved.get("version") != 1:
                return {}
            return saved
        except (OSError, ValueError):
            return {}

    def _sidecar_themes(self, folder):
        sidecars = {}
        vt = folder / "video-themes.json"
        if vt.is_file() and vt.stat().st_size < 1_000_000:
            try:
                raw = json.loads(vt.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    sidecars = raw
            except (OSError, ValueError):
                pass
        return sidecars

    def _resolve_series_index(self, payload):
        folder_name = payload.get("seriesName")
        if isinstance(folder_name, str) and folder_name:
            for idx, (folder, _) in enumerate(self.series):
                if folder.name == folder_name:
                    return idx
        return int(payload.get("series") or 0)

    def sync_metadata(self, payload):
        self.refresh_series()
        series_index = self._resolve_series_index(payload)
        folder, episodes = self.series[series_index]
        metadata = self._metadata_path(series_index)
        with self.meta_lock:
            saved = self._read_saved(metadata)
            saved.setdefault("version", 1)
            saved.setdefault("title", folder.name)
            if isinstance(payload.get("autoSkip"), dict):
                auto_skip = saved.setdefault("autoSkip", {})
                for part in ("op", "ed", "recap"):
                    if part in payload["autoSkip"] and isinstance(payload["autoSkip"][part], bool):
                        auto_skip[part] = payload["autoSkip"][part]
            if isinstance(payload.get("autoSkipDelay"), (int, float)) and payload["autoSkipDelay"] in (0, 3, 5):
                saved["autoSkipDelay"] = int(payload["autoSkipDelay"])
            ep_name = payload.get("episode")
            valid_names = {video.name for video, _ in episodes}
            if isinstance(ep_name, str) and ep_name in valid_names:
                ep_map = saved.setdefault("episodes", {})
                ep_entry = ep_map.setdefault(ep_name, {})
                if isinstance(payload.get("themes"), dict):
                    cleaned = {}
                    for part in ("op", "ed", "recap"):
                        r = payload["themes"].get(part)
                        if isinstance(r, dict) and isinstance(r.get("start"), (int, float)) and isinstance(r.get("end"), (int, float)) and r["end"] > r["start"] >= 0:
                            cleaned[part] = {"start": r["start"], "end": r["end"], "source": str(r.get("source") or "manual")}
                    ep_entry["themes"] = cleaned
                if isinstance(payload.get("progress"), dict):
                    p = payload["progress"]
                    if isinstance(p.get("position"), (int, float)) and isinstance(p.get("watchedAt"), (int, float)) and isinstance(p.get("finished"), bool):
                        ep_entry["progress"] = {"position": p["position"], "watchedAt": p["watchedAt"], "finished": p["finished"]}
            tmp = metadata.with_name(metadata.name + ".tmp")
            tmp.write_text(json.dumps(saved, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            tmp.replace(metadata)

    def catalog(self):
        self.refresh_series()
        return {"version": 1, "series": [self.library(index) for index in range(len(self.series))]}

    def library(self, index):
        folder, episodes = self.series[index]
        metadata = self._metadata_path(index)
        prefix = f"{index}/" if index else ""
        with self.meta_lock:
            saved = self._read_saved(metadata)
        items = saved.get("episodes", {})
        if not isinstance(items, dict):
            items = {}
        sidecars = self._sidecar_themes(folder)
        result_episodes = []
        for number, (file, subtitle) in enumerate(episodes):
            ep_saved = dict(items.get(file.name, {}))
            if not ep_saved.get("themes"):
                per_ep = folder / f"{file.stem}.themes.json"
                if per_ep.is_file() and per_ep.stat().st_size < 200_000:
                    try:
                        ep_saved["themes"] = json.loads(per_ep.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        pass
                elif isinstance(sidecars.get(file.name), dict):
                    ep_saved["themes"] = sidecars[file.name]
            result_episodes.append({
                "name": file.name,
                "video": f"{prefix}{number}/video",
                "subtitles": f"{prefix}{number}/subtitles" if subtitle else None,
                "saved": ep_saved
            })
        return {
            "id": hashlib.sha256(str(folder).encode()).hexdigest()[:16],
            "title": saved.get("title") or folder.name,
            "autoSkip": saved.get("autoSkip", {}),
            "autoSkipDelay": saved.get("autoSkipDelay"),
            "endingAction": saved.get("endingAction", "auto"),
            "episodes": result_episodes
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", nargs="?", type=Path, default=DEFAULT_FOLDER,
                        help="Series or library folder (defaults to ~/Downloads/Arc Anime)")
    parser.add_argument("--metadata", type=Path, help="Optional Anime Study TV playback data JSON")
    parser.add_argument("--host", type=ipaddress.IPv4Address, help="Private LAN address to listen on (defaults to the active route)")
    parser.add_argument("--port", type=int, default=46158)
    parser.add_argument("--token", help="Optional 16-hex-character URL token for stable TV bookmarking")
    parser.add_argument("--verbose", action="store_true", help="Log request types and HTTP statuses")
    options = parser.parse_args()
    if options.token and not re.fullmatch(r"[a-f0-9]{16}", options.token):
        parser.error("Use a 16-character lowercase hex token.")
    host = options.host or ipaddress.IPv4Address(lan_address())
    if not (host.is_loopback or any(host in ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
        parser.error("Use a private network address.")
    folder = options.folder.expanduser().resolve()
    metadata = options.metadata.expanduser() if options.metadata else None
    try:
        with TVServer((str(host), options.port), folder, metadata, options.verbose, options.token) as server:
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
