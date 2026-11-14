"""Serve downloaded series to Anime Study TV over a private LAN."""

import argparse
import base64
import socket
import struct
import threading
import hashlib
import ipaddress
import json
import re
import secrets
import shutil
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from native.cast.airplay import lan_address

# Who may talk to the server when it listens on every interface: this Mac, the home network,
# and devices on your Tailscale tailnet (100.64.0.0/10). Everything else is dropped before parsing.
ALLOWED_CLIENTS = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")]
TAILSCALE_CLI = ("/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale")


def tailscale_self():
    """This Mac's Tailscale name and IPv4 address, or (None, None) when Tailscale isn't running."""
    import subprocess
    for cli in TAILSCALE_CLI:
        if not Path(cli).exists():
            continue
        try:
            status = json.loads(subprocess.run([cli, "status", "--json"], capture_output=True, timeout=3).stdout or b"{}")
        except (OSError, ValueError, subprocess.SubprocessError):
            return None, None
        if status.get("BackendState") != "Running":
            return None, None
        me = status.get("Self") or {}
        ipv4 = next((ip for ip in me.get("TailscaleIPs") or [] if ":" not in ip), None)
        name = (me.get("DNSName") or "").rstrip(".") or None
        return name, ipv4
    return None, None
from native.tv.queue_store import QueueStore
from native.tv.replica import Replica

PROJECT = Path(__file__).resolve().parents[2] / "outputs" / "samsung-tv" / "AnimeStudy"
ASSETS = {"": ("index.html", "text/html; charset=utf-8"), "tv.css": ("tv.css", "text/css; charset=utf-8"),
          "tv.js": ("tv.js", "text/javascript; charset=utf-8"), "icon.png": ("icon.png", "image/png")}
SUBTITLES = (".ass", ".ssa", ".srt", ".vtt")
DEFAULT_FOLDER = Path.home() / "Downloads" / "Arc Anime"
QUEUE_DIR = Path.home() / "Library" / "Application Support" / "AnimeStudy"


def default_queue_path(folder):
    digest = hashlib.sha1(str(Path(folder).resolve()).encode("utf-8")).hexdigest()[:10]
    return QUEUE_DIR / f"queue-{digest}.sqlite3"
MEDIA_PATH = re.compile(r"(?:(\d+)/)?(\d+)/(video|subtitles)")
POSTER_PATH = re.compile(r"(\d+)/poster")
WS_SEND_TIMEOUT_SECONDS = 5
SERIES_ID_RE = re.compile(r"\s-\s(\d+)(?:\s-\s|$)")


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
        elif resource in ("library.json", "catalog.json", "sync", "worker/status", "worker/claim", "worker/progress", "worker/complete", "worker/retry", "replica/sync") or (resource and MEDIA_PATH.fullmatch(resource)):
            label = resource
        else:
            label = "unknown resource"
        method = self.command if self.command in ("GET", "HEAD", "POST") else "unsupported method"
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
        if path == f"/{self.server.token}/downloads":
            return self._send_json({"requests": self.server.download_requests()})
        if path == f"/{self.server.token}/worker/status":
            data = json.dumps(self.server.get_worker_status()).encode("utf-8")
            self.respond("application/json; charset=utf-8", len(data))
            self.wfile.write(data)
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
        state = self.server.get_tv_state()
        if state:
            try:
                conn.sendall(ws_encode_text(json.dumps(state)))
            except OSError:
                pass
        try:
            worker_status = {"type": "worker_status", **self.server.get_worker_status()}
            conn.sendall(ws_encode_text(json.dumps(worker_status)))
        except OSError:
            pass
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
                            msg_type = event.get("type")
                            if msg_type == "sync":
                                self.server.sync_metadata(event)
                            elif msg_type == "tv_state":
                                event = self.server.set_tv_state(event, conn)
                            self.server.broadcast(event, exclude=conn)
                    except (ValueError, OSError):
                        pass
        except OSError:
            pass
        finally:
            self.server.remove_ws(conn)
            cleared = self.server.clear_tv_state_for_conn(conn)
            if cleared:
                self.server.broadcast(cleared)

    def _read_json_body(self, max_bytes=262_144):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > max_bytes:
            return None
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        return body if isinstance(body, dict) else None

    def _send_json(self, payload, code=200):
        data = json.dumps(payload).encode("utf-8")
        self.respond("application/json; charset=utf-8", len(data), code=code)
        self.wfile.write(data)

    def do_POST(self):
        path = urlsplit(self.path).path
        prefix = f"/{self.server.token}/"
        if not path.startswith(prefix):
            return self.send_error(404)
        resource = path[len(prefix):]
        try:
            if resource == "sync":
                body = self._read_json_body(262_144)
                if body is None:
                    return self.send_error(400)
                if body.get("type") == "tv_control":
                    self.server.broadcast(body)
                else:
                    self.server.sync_metadata(body)
                    self.server.broadcast({"type": "sync", **body})
                self._send_json({"ok": True})
            elif resource == "worker/claim":
                body = self._read_json_body(65_536)
                if body is None:
                    return self.send_error(400)
                job, status = self.server.claim_worker_job(body)
                self.server.broadcast({"type": "worker_status", **status})
                self._send_json({"job": job, "waitReason": None if job else self.server.node_wait_reason(body.get("nodeId"))})
            elif resource == "worker/progress":
                body = self._read_json_body(65_536)
                if body is None:
                    return self.send_error(400)
                status = self.server.update_worker_progress(body)
                if status is not None:
                    self.server.broadcast({"type": "worker_status", **status})
                self._send_json({"ok": status is not None})
            elif resource == "worker/complete":
                body = self._read_json_body(16_777_216)
                if body is None:
                    return self.send_error(400)
                self.server.complete_worker_job(body)
                self._send_json({"ok": True})
            elif resource == "replica/sync":
                body = self._read_json_body(8_388_608)
                if body is None:
                    return self.send_error(400)
                self._send_json(self.server.replica_sync(body))
            elif resource == "downloads/request":
                body = self._read_json_body(16_384)
                if body is None:
                    return self.send_error(400)
                request = self.server.request_download(body)
                self._send_json({"request": request} if request else {"error": "Open an Anime365 series first."}, code=200 if request else 400)
            elif resource == "downloads/update":
                body = self._read_json_body(262_144)
                if body is None:
                    return self.send_error(400)
                self._send_json(self.server.update_download(body))
            elif resource == "worker/retry":
                body = self._read_json_body(65_536)
                if body is None:
                    return self.send_error(400)
                count, _ = self.server.retry_worker_episodes(body)
                self._send_json({"ok": True, "retried": count})
            else:
                return self.send_error(404)
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
            elif poster_match := POSTER_PATH.fullmatch(resource):
                poster = self.server.poster_file(int(poster_match.group(1)))
                if not poster:
                    return self.send_error(404)
                self.send_file(poster, "image/jpeg")
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
    def verify_request(self, request, client_address):
        try:
            client = ipaddress.ip_address(client_address[0])
        except ValueError:
            return False
        return any(client in network for network in ALLOWED_CLIENTS)

    _addresses_cache = (0.0, [])

    def addresses(self):
        """Base URLs this server answers on, best first: Tailscale name (works anywhere), Tailscale IP,
        then the home network. Clients keep the list and fall back between them on their own."""
        at, cached = self._addresses_cache
        if time.time() - at < 60:
            return cached
        port, urls = self.server_port, []
        name, ts_ip = tailscale_self()
        if name:
            urls.append(f"http://{name}:{port}/{self.token}/")
        if ts_ip:
            urls.append(f"http://{ts_ip}:{port}/{self.token}/")
        try:
            urls.append(f"http://{lan_address()}:{port}/{self.token}/")
        except (OSError, ValueError):
            pass
        self._addresses_cache = (time.time(), urls)
        return urls

    def __init__(self, address, folder, metadata, verbose=False, token=None, queue_db=None):
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
        self.worker_lock = threading.Lock()
        self.downloads_lock = threading.Lock()
        self.ws_clients = set()
        self.tv_state = {"type": "tv_state", "active": False}
        self.tv_state_conn = None
        self.worker_nodes = {}
        # Persistent queue state (PIPELINE.md step 1): survives coordinator restarts.
        self.store = QueueStore(queue_db or default_queue_path(folder))
        self.store.prune_finished_jobs()
        self.worker_jobs = {job["jobId"]: job for job in self.store.load_jobs(("in_progress",))}
        self.episode_state = self.store.load_episodes()   # (series, episode) -> {state, attempts, notBefore, error}
        self.stage_state = self.store.load_stages()      # kind -> {(series, episode) -> {..., result}}
        self.series_samples = self.store.load_samples()
        # Fingerprint results that found no opening or ending, and those already given a second try.
        self.empty_fingerprints = set()
        self.rechecked_fingerprints = set()
        self._requeue_outdated_fingerprints()
        self.store.log_event("coordinator_start", data={"resumedJobs": len(self.worker_jobs)})
        # Master-master library state shared with phones (replica.py).
        self.replica = Replica(queue_db or default_queue_path(folder))
        super().__init__(address, TVHandler)
        self._bootstrap_replica()

    def get_tv_state(self):
        with self.ws_lock:
            return dict(self.tv_state)

    def set_tv_state(self, event, conn=None):
        active = bool(event.get("active"))
        if not active:
            normalized = {"type": "tv_state", "active": False}
        else:
            normalized = {
                "type": "tv_state",
                "active": True,
                "series": event.get("series") if isinstance(event.get("series"), int) else None,
                "seriesName": event.get("seriesName") if isinstance(event.get("seriesName"), str) else "",
                "seriesLabel": event.get("seriesLabel") if isinstance(event.get("seriesLabel"), str) else "",
                "episode": event.get("episode") if isinstance(event.get("episode"), str) else "",
                "episodeLabel": event.get("episodeLabel") if isinstance(event.get("episodeLabel"), str) else "",
                "paused": bool(event.get("paused")),
                "position": float(event["position"]) if isinstance(event.get("position"), (int, float)) else 0.0,
                "duration": float(event["duration"]) if isinstance(event.get("duration"), (int, float)) else 0.0,
            }
            if isinstance(event.get("subtitles"), bool):
                normalized["subtitles"] = event["subtitles"]
            if isinstance(event.get("autoplay"), bool):
                normalized["autoplay"] = event["autoplay"]
            if isinstance(event.get("skipAvailable"), bool):
                normalized["skipAvailable"] = event["skipAvailable"]
        with self.ws_lock:
            self.tv_state = normalized
            self.tv_state_conn = conn if active else None
            return dict(normalized)

    def clear_tv_state_for_conn(self, conn):
        with self.ws_lock:
            if self.tv_state_conn is conn and self.tv_state.get("active"):
                self.tv_state = {"type": "tv_state", "active": False}
                self.tv_state_conn = None
                return dict(self.tv_state)
        return None

    def add_ws(self, conn):
        # A client that stops reading (a phone asleep) must not block broadcasts forever: give sends
        # a timeout, after which broadcast() drops the client. Reads keep blocking as before.
        try:
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDTIMEO, struct.pack("ll", WS_SEND_TIMEOUT_SECONDS, 0))
        except (OSError, struct.error):
            pass
        with self.ws_lock:
            self.ws_clients.add(conn)

    def remove_ws(self, conn):
        with self.ws_lock:
            self.ws_clients.discard(conn)

    # Series download requests: a phone or iPad asks for a series, and Chrome on this Mac (signed in to
    # Anime365) claims the request, downloads it into this library and reports progress back here.
    DOWNLOAD_STATES = ("pending", "planning", "downloading", "done", "failed")

    def _downloads_path(self):
        return self.folder / ".anime-study-download-requests.json"

    def _read_downloads(self):
        try:
            saved = json.loads(self._downloads_path().read_text(encoding="utf-8"))
            return [item for item in saved.get("requests", []) if isinstance(item, dict)]
        except (OSError, ValueError, AttributeError):
            return []

    def _write_downloads(self, requests):
        path = self._downloads_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"requests": requests[-50:]}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    def download_requests(self):
        with self.downloads_lock:
            return self._read_downloads()

    def request_download(self, body):
        url = body.get("url")
        if not isinstance(url, str) or len(url) > 2_000:
            return None
        parts = urlsplit(url)
        host = parts.hostname or ""
        anime365 = any(host == domain or host.endswith("." + domain) for domain in ("smotret-anime.com", "smotret-anime.net"))
        if parts.scheme != "https" or not anime365 or parts.username or parts.password or parts.port or not parts.path.startswith("/catalog/"):
            return None
        title = body.get("title") if isinstance(body.get("title"), str) else ""
        device = body.get("from") if isinstance(body.get("from"), str) else ""
        with self.downloads_lock:
            requests = self._read_downloads()
            for item in requests:
                if item.get("url") == url and item.get("state") in ("pending", "planning", "downloading"):
                    return item
            request = {
                "id": secrets.token_hex(6), "url": url, "title": title[:200], "from": device[:60],
                "state": "pending", "detail": "Waiting for Chrome on the Mac", "createdAt": int(time.time() * 1000),
            }
            requests.append(request)
            self._write_downloads(requests)
        self.broadcast({"type": "downloads", "requests": requests[-50:]})
        return request

    def update_download(self, body):
        """Chrome reports progress. With a planned folder and file names, answers which are already here."""
        existing = []
        folder_name = body.get("folder")
        if isinstance(folder_name, str) and folder_name and "/" not in folder_name and "\\" not in folder_name and not folder_name.startswith("."):
            folder = self.folder / folder_name
            names = body.get("files") if isinstance(body.get("files"), list) else []
            existing = [name for name in names[:2_000] if isinstance(name, str) and "/" not in name and (folder / name).is_file()]
        with self.downloads_lock:
            requests = self._read_downloads()
            for item in requests:
                if item.get("id") != body.get("id"):
                    continue
                if body.get("state") in self.DOWNLOAD_STATES:
                    item["state"] = body["state"]
                for key, limit in (("detail", 300), ("title", 200), ("folder", 200)):
                    if isinstance(body.get(key), str):
                        item[key] = body[key][:limit]
                for key in ("done", "total"):
                    if isinstance(body.get(key), int):
                        item[key] = body[key]
                item["updatedAt"] = int(time.time() * 1000)
                self._write_downloads(requests)
                break
        self.broadcast({"type": "downloads", "requests": requests[-50:]})
        if body.get("state") == "done":
            self.refresh_series()
        return {"ok": True, "existing": existing}

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

    def _settings_path(self):
        return self.folder / ".anime-study-tv-settings.json"

    def get_autoplay(self):
        with self.meta_lock:
            try:
                raw = json.loads(self._settings_path().read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("autoplay"), bool):
                    return raw["autoplay"]
            except (OSError, ValueError):
                pass
        return True

    def _set_autoplay(self, value):
        path = self._settings_path()
        with self.meta_lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raw = {}
            except (OSError, ValueError):
                raw = {}
            raw["autoplay"] = bool(value)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)

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

    def sync_metadata(self, payload, record=True):
        """Apply a change to the library's JSON metadata. `record=False` when it came from replication."""
        if isinstance(payload.get("autoplay"), bool):
            self._set_autoplay(payload["autoplay"])
            if record:
                self.replica.set_local("settings/autoplay", payload["autoplay"])
            if not any(k in payload for k in ("series", "seriesName", "episode", "themes", "progress", "autoSkip", "autoSkipDelay")):
                return
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
                        entry_progress = {"position": p["position"], "watchedAt": p["watchedAt"], "finished": p["finished"]}
                        if isinstance(p.get("duration"), (int, float)) and p["duration"] > 0:
                            entry_progress["duration"] = p["duration"]
                        ep_entry["progress"] = entry_progress
            tmp = metadata.with_name(metadata.name + ".tmp")
            tmp.write_text(json.dumps(saved, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            tmp.replace(metadata)
        if record:
            self._record_replica_change(folder.name, payload, saved)

    def _record_replica_change(self, series_name, payload, saved):
        if isinstance(payload.get("autoSkip"), dict) and isinstance(saved.get("autoSkip"), dict):
            self.replica.set_local(f"series/{series_name}/autoSkip", saved["autoSkip"])
        if "autoSkipDelay" in saved and isinstance(payload.get("autoSkipDelay"), (int, float)):
            self.replica.set_local(f"series/{series_name}/autoSkipDelay", saved["autoSkipDelay"])
        ep_name = payload.get("episode")
        entry = (saved.get("episodes") or {}).get(ep_name) if isinstance(ep_name, str) else None
        if not isinstance(entry, dict):
            return
        if isinstance(payload.get("themes"), dict) and "themes" in entry:
            self.replica.set_local(f"ep/{series_name}/{ep_name}/themes", entry["themes"])
        if isinstance(payload.get("progress"), dict) and isinstance(entry.get("progress"), dict):
            prog = entry["progress"]
            self.replica.set_local(f"ep/{series_name}/{ep_name}/progress", prog, physical_ms=prog.get("watchedAt"))

    def _series_index_by_name(self, name):
        for idx, (folder, _) in enumerate(self.series):
            if folder.name == name:
                return idx
        return None

    def _bootstrap_replica(self):
        """Seed registers from existing JSON metadata the first time (and for series added later).

        Bootstrap values get old timestamps (progress keeps its watchedAt; themes/settings use 1 ms),
        so any real edit made on another node wins over them.
        """
        self.refresh_series()
        if not self.replica.has("settings/autoplay"):
            self.replica.set_local("settings/autoplay", self.get_autoplay(), physical_ms=1)
        for idx, (folder, _) in enumerate(self.series):
            with self.meta_lock:
                saved = self._read_saved(self._metadata_path(idx))
            name = folder.name
            for field in ("autoSkip", "autoSkipDelay"):
                key = f"series/{name}/{field}"
                if field in saved and not self.replica.has(key):
                    self.replica.set_local(key, saved[field], physical_ms=1)
            for ep_name, entry in (saved.get("episodes") or {}).items():
                if not isinstance(entry, dict):
                    continue
                if isinstance(entry.get("themes"), dict) and not self.replica.has(f"ep/{name}/{ep_name}/themes"):
                    self.replica.set_local(f"ep/{name}/{ep_name}/themes", entry["themes"], physical_ms=1)
                prog = entry.get("progress")
                if isinstance(prog, dict) and isinstance(prog.get("watchedAt"), (int, float)) \
                        and not self.replica.has(f"ep/{name}/{ep_name}/progress"):
                    self.replica.set_local(f"ep/{name}/{ep_name}/progress", prog, physical_ms=prog["watchedAt"])

    def apply_replica_changes(self, won):
        """Write changes that won LWW into the JSON metadata and tell connected clients (TV, phones)."""
        for key, value in won:
            parts = key.split("/")
            payload = None
            if key == "settings/autoplay" and isinstance(value, bool):
                payload = {"autoplay": value}
            elif len(parts) >= 4 and parts[0] == "ep" and parts[-1] in ("progress", "themes"):
                series_name, field = parts[1], parts[-1]
                ep_name = "/".join(parts[2:-1])
                idx = self._series_index_by_name(series_name)
                if idx is None or not isinstance(value, dict):
                    continue          # a series this Mac doesn't have: kept in the replica only
                payload = {"series": idx, "seriesName": series_name, "episode": ep_name, field: value}
            elif len(parts) == 3 and parts[0] == "series" and parts[2] in ("autoSkip", "autoSkipDelay"):
                idx = self._series_index_by_name(parts[1])
                if idx is None:
                    continue
                payload = {"series": idx, "seriesName": parts[1], parts[2]: value}
            if payload is None:
                continue
            try:
                self.sync_metadata(payload, record=False)
            except (OSError, ValueError, IndexError):
                continue
            self.broadcast({"type": "sync", "source": "replica", **payload})

    def replica_sync(self, body):
        """One round trip: take the peer's ops, return the ones it's missing. Body: {node, vv, ops}."""
        won = self.replica.apply_remote(body.get("ops"))
        self.refresh_series()
        self._bootstrap_replica()       # new series folders since startup
        self.apply_replica_changes(won)
        outgoing = self.replica.ops_since(body.get("vv"))
        peer = str(body.get("node") or "?")[:64]
        self.store.log_event("replica_sync", node_id=peer, data={
            "received": len(body.get("ops") or []), "applied": len(won), "sent": len(outgoing)})
        return {
            "node": self.replica.node_id,
            "vv": self.replica.version_vector(),
            "ops": outgoing,
            "applied": len(won),
        }

    def poster_file(self, index):
        folder, _ = self.series[index]
        if folder.is_symlink() or folder.resolve() != folder:
            return None
        cached = folder / "poster.jpg"
        if cached.is_file() and cached.stat().st_size > 0:
            return cached
        match = SERIES_ID_RE.search(folder.name)
        if not match:
            return None
        series_id = match.group(1)
        try:
            req = Request(f"https://smotret-anime.com/api/series/{series_id}", headers={"User-Agent": "AnimeStudyTV/1.0"})
            with urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read(512_000).decode("utf-8")).get("data") or {}
            poster_url = data.get("posterUrl") or data.get("posterUrlSmall")
            if not isinstance(poster_url, str) or not poster_url.startswith("https://"):
                return None
            host = urlsplit(poster_url).hostname or ""
            if not (host == "smotret-anime.com" or host.endswith(".smotret-anime.com")):
                return None
            img_req = Request(poster_url, headers={"User-Agent": "AnimeStudyTV/1.0"})
            with urlopen(img_req, timeout=8) as img_resp:
                img_bytes = img_resp.read(10_000_000)
            if not img_bytes:
                return None
            tmp = folder / "poster.jpg.tmp"
            tmp.write_bytes(img_bytes)
            tmp.replace(cached)
            return cached
        except (OSError, ValueError):
            return None

    def catalog(self):
        self.refresh_series()
        return {
            "version": 1,
            "addresses": self.addresses(),
            "autoplay": self.get_autoplay(),
            "tvState": self.get_tv_state(),
            "series": [self.library(index) for index in range(len(self.series))],
        }

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
            try:
                size = file.stat().st_size
            except OSError:
                size = None
            result_episodes.append({
                "name": file.name,
                "video": f"{prefix}{number}/video",
                "subtitles": f"{prefix}{number}/subtitles" if subtitle else None,
                # Phones download episodes under the same names, so synced keys line up.
                "subtitleName": subtitle.name if subtitle else None,
                "size": size,
                "saved": ep_saved
            })
        poster = f"{index}/poster" if (folder / "poster.jpg").is_file() or SERIES_ID_RE.search(folder.name) else None
        return {
            "id": hashlib.sha256(str(folder).encode()).hexdigest()[:16],
            "folder": folder.name,
            "title": saved.get("title") or folder.name,
            "poster": poster,
            "autoSkip": saved.get("autoSkip", {}),
            "autoSkipDelay": saved.get("autoSkipDelay"),
            "endingAction": saved.get("endingAction", "auto"),
            "episodes": result_episodes
        }

    WORKER_LEASE_SECONDS = 120.0
    WORKER_MAX_ATTEMPTS = 3          # then the episode is quarantined until retried from the app
    WORKER_BACKOFF_BASE = 30.0       # 30 s, 60 s, 120 s ... between attempts
    WORKER_BACKOFF_MAX = 900.0
    # Step 3 scheduling knobs.
    PHONE_MIN_BATTERY_ON_BATTERY = 0.8   # a phone on battery only works above 80 %
    SLOW_NODE_FACTOR = 2.0               # "much faster" = more than 2x quicker for that task kind
    TV_BUSY_MAX_JOBS = 1                 # while the TV is playing, at most this many jobs at once
    WORKER_NODE_STALE_SECONDS = 90.0
    WORKER_NODE_PRUNE_SECONDS = 300.0

    def _episode_has_themes(self, folder, file_name, ep_saved, sidecars):
        themes = ep_saved.get("themes")
        if not themes:
            per_ep = folder / f"{Path(file_name).stem}.themes.json"
            if per_ep.is_file() and per_ep.stat().st_size < 200_000:
                try:
                    themes = json.loads(per_ep.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    themes = None
            elif isinstance(sidecars.get(file_name), dict):
                themes = sidecars[file_name]
        return isinstance(themes, dict) and any(
            isinstance(themes.get(part), dict) for part in ("op", "ed", "recap")
        )

    # ---- stage state (PIPELINE.md steps 1–2) ---------------------------------
    # fingerprint keeps its original table/dict (`episode_state`); other stages live in `stage_state[kind]`.
    STAGE_KINDS = ("probe", "fingerprint")
    # Bump when worker.py's OP/ED detection changes so finished episodes are processed again.
    # v2: ending songs matched by soundtrack (audio_print.py).
    # v3: several reference episodes (nearest first, not the first episode); episodes that found
    #     nothing are checked again once another episode of the series finds its opening or ending.
    FINGERPRINT_DETECTOR_VERSION = 3
    FINGERPRINT_REFERENCES = 3

    def _requeue_outdated_fingerprints(self):
        outdated = [key for key, info in self.episode_state.items()
                    if info.get("state") == "done" and int(info.get("detector", 1)) < self.FINGERPRINT_DETECTOR_VERSION]
        for key in outdated:
            self.episode_state.pop(key, None)
            self.store.delete_episode(key)
        if outdated:
            self.store.log_event("detector_requeue", data={"episodes": len(outdated), "version": self.FINGERPRINT_DETECTOR_VERSION})

    def _stage_map(self, kind):
        if kind == "fingerprint":
            return self.episode_state
        return self.stage_state.setdefault(kind, {})

    def _save_stage(self, kind, key, info):
        if kind == "fingerprint":
            self.store.save_episode(key, info)
        else:
            self.store.save_stage(kind, key, info)

    def _record_failure_locked(self, key, error, now, job_id=None, node_id=None, kind="fingerprint"):
        states = self._stage_map(kind)
        info = states.get(key) or {"state": "retrying", "attempts": 0, "notBefore": 0, "error": None}
        if info.get("state") == "done":
            return info
        attempts = int(info.get("attempts", 0)) + 1
        quarantined = attempts >= self.WORKER_MAX_ATTEMPTS
        backoff = min(self.WORKER_BACKOFF_BASE * (2 ** (attempts - 1)), self.WORKER_BACKOFF_MAX)
        info = {
            "state": "quarantined" if quarantined else "retrying",
            "attempts": attempts,
            "notBefore": 0 if quarantined else now + backoff,
            "error": str(error)[:200],
        }
        states[key] = info
        self._save_stage(kind, key, info)
        self.store.log_event("quarantined" if quarantined else "retry_scheduled", job_id, node_id,
                             {"kind": kind, "series": key[0], "episode": key[1], "attempts": attempts, "error": info["error"]})
        return info

    def _record_done_locked(self, key, job_id=None, node_id=None, kind="fingerprint", result=None):
        states = self._stage_map(kind)
        prev = states.get(key) or {}
        info = {"state": "done", "attempts": int(prev.get("attempts", 0)), "notBefore": 0, "error": None}
        if kind == "fingerprint":
            info["detector"] = self.FINGERPRINT_DETECTOR_VERSION
        if result is not None:
            info["result"] = result
        states[key] = info
        self._save_stage(kind, key, info)
        self.store.log_event("done", job_id, node_id, {"kind": kind, "series": key[0], "episode": key[1]})

    @staticmethod
    def _stage_blocked(info, now):
        """True if a stage should not be offered: done, quarantined, or still backing off."""
        if not info:
            return False
        return info.get("state") in ("done", "quarantined") or info.get("notBefore", 0) > now

    def _probe_worker_free_locked(self):
        """A probe-capable node that is online and not busy — only then is waiting for a probe worth it."""
        return any(
            "probe" in (n.get("kinds") or []) and n.get("status") == "idle"
            for n in self.worker_nodes.values()
        )

    def _prune_worker_state_locked(self, now):
        for job_id, job in list(self.worker_jobs.items()):
            if job["status"] == "in_progress" and job["leaseExpiresAt"] < now:
                key = (job["seriesName"], job["episode"])
                kind = job.get("kind", "fingerprint")
                info = self._record_failure_locked(key, "lease expired", now, job_id, job.get("nodeId"), kind)
                job["status"] = "failed" if info["state"] == "quarantined" else "expired"
                job["error"] = "lease expired"
                self.store.save_job(job)
                node = self.worker_nodes.get(job["nodeId"])
                if node and node.get("currentJobId") == job_id:
                    node["status"] = "idle"
                    node["currentJobId"] = None
                    node["currentSeries"] = None
                    node["currentEpisode"] = None
                    node["progress"] = 0
        for node_id, node in list(self.worker_nodes.items()):
            age = now - node["lastHeartbeat"]
            if age > self.WORKER_NODE_PRUNE_SECONDS and node["status"] != "working":
                del self.worker_nodes[node_id]
            elif age > self.WORKER_NODE_STALE_SECONDS and node["status"] != "offline":
                node["status"] = "offline"

    def _watch_focus(self, series_idx, folder, episodes, items):
        """(anchor_index, weight) for 'next to watch' ordering in one series, or None.

        TV currently playing this series → anchor = playing episode, weight 1000.
        Otherwise the last-watched episode (next one if finished) with weight by how recently it was watched.
        """
        with self.ws_lock:
            tv = dict(self.tv_state)
        names = [f.name for f, _ in episodes]
        if tv.get("active") and tv.get("seriesName") == folder.name and tv.get("episode") in names:
            return names.index(tv["episode"]), 1000.0
        best = None
        for name, ep in items.items():
            prog = ep.get("progress") if isinstance(ep, dict) else None
            if not isinstance(prog, dict) or not isinstance(prog.get("watchedAt"), (int, float)) or name not in names:
                continue
            if best is None or prog["watchedAt"] > best[1]:
                best = (name, prog["watchedAt"], bool(prog.get("finished")))
        if best is None:
            return None
        anchor = names.index(best[0]) + (1 if best[2] else 0)
        age_days = max(0.0, (time.time() * 1000 - best[1]) / 86_400_000)
        return anchor, max(100.0, 500.0 - age_days * 20)   # fades over ~3 weeks

    @staticmethod
    def _episode_priority(focus, ep_idx):
        if focus is None:
            return 0.0
        anchor, weight = focus
        if ep_idx >= anchor:
            return weight - (ep_idx - anchor)          # next episode first, then the ones after it
        return weight / 10 - (anchor - ep_idx)         # already-watched ones of an active series: low

    def _scan_worker_catalog_locked(self):
        """Ready tasks across stages, in episode order (probe before fingerprint for each episode).

        Returns (pending, total_scannable, blocked) where `pending` items carry a `kind`.
        Fingerprint waits for a successful probe only while a probe-capable worker is free to run it,
        so other nodes (the iPhone) never sit idle behind a busy Mac.
        """
        now = time.time()
        pending = []
        blocked = 0
        total_scannable = 0
        in_progress = {
            (j.get("kind", "fingerprint"), j["seriesName"], j["episode"])
            for j in self.worker_jobs.values()
            if j["status"] == "in_progress"
        }
        probe_online = self._probe_worker_free_locked()
        probe_states = self._stage_map("probe")
        for series_idx, (folder, episodes) in enumerate(self.series):
            if len(episodes) < 2:
                continue
            metadata = self._metadata_path(series_idx)
            with self.meta_lock:
                saved = self._read_saved(metadata)
            items = saved.get("episodes", {})
            if not isinstance(items, dict):
                items = {}
            sidecars = self._sidecar_themes(folder)
            prefix = f"{series_idx}/" if series_idx else ""
            focus = self._watch_focus(series_idx, folder, episodes, items)
            for ep_idx, (file, _) in enumerate(episodes):
                total_scannable += 1
                key = (folder.name, file.name)
                base = {
                    "priority": round(self._episode_priority(focus, ep_idx), 2),
                    "series": series_idx,
                    "seriesName": folder.name,
                    "episode": file.name,
                    "episodeIndex": ep_idx,
                    "url": f"{prefix}{ep_idx}/video",
                }

                probe_info = probe_states.get(key)
                if not self._stage_blocked(probe_info, now) and ("probe", *key) not in in_progress:
                    pending.append({**base, "kind": "probe", "durationHint": None})

                ep_saved = items.get(file.name, {})
                if not isinstance(ep_saved, dict):
                    ep_saved = {}
                if self._episode_has_themes(folder, file.name, ep_saved, sidecars):
                    continue
                if self._stage_blocked(self.episode_state.get(key), now):
                    continue
                if ("fingerprint", *key) in in_progress:
                    continue
                probe_done = bool(probe_info and probe_info.get("state") == "done")
                probe_given_up = bool(probe_info and probe_info.get("state") == "quarantined")
                if probe_online and not probe_done and not probe_given_up:
                    blocked += 1
                    continue
                duration_hint = None
                probe_result = (probe_info or {}).get("result") or {}
                if isinstance(probe_result.get("duration"), (int, float)) and probe_result["duration"] > 0:
                    duration_hint = float(probe_result["duration"])
                prog = ep_saved.get("progress")
                if duration_hint is None and isinstance(prog, dict) and isinstance(prog.get("duration"), (int, float)) and prog["duration"] > 0:
                    duration_hint = float(prog["duration"])
                pending.append({**base, "kind": "fingerprint", "durationHint": duration_hint})
        # Highest priority first; at equal priority all (sub-second) probes go before fingerprints so they
        # unblock other nodes quickly. The stable sort keeps library order within each group.
        pending.sort(key=lambda p: (-p["priority"], 0 if p["kind"] == "probe" else 1))
        return pending, total_scannable, blocked

    def _stage_counts_locked(self, pending):
        out = {}
        for kind in self.STAGE_KINDS:
            states = self._stage_map(kind).values()
            out[kind] = {
                "pending": sum(1 for p in pending if p["kind"] == kind),
                "inProgress": sum(
                    1 for j in self.worker_jobs.values()
                    if j["status"] == "in_progress" and j.get("kind", "fingerprint") == kind
                ),
                "done": sum(1 for v in states if v.get("state") == "done"),
                "retrying": sum(1 for v in states if v.get("state") == "retrying"),
                "quarantined": sum(1 for v in states if v.get("state") == "quarantined"),
            }
        return out

    def _worker_status_snapshot_locked(self):
        pending, total_scannable, blocked = self._scan_worker_catalog_locked()
        active_jobs = [
            {
                "jobId": j["jobId"],
                "kind": j.get("kind", "fingerprint"),
                "series": j["series"],
                "seriesName": j["seriesName"],
                "episode": j["episode"],
                "status": j["status"],
                "nodeId": j["nodeId"],
                "nodeName": j["nodeName"],
                "progress": j["progress"],
                "error": j.get("error"),
            }
            for j in sorted(self.worker_jobs.values(), key=lambda x: x["leasedAt"], reverse=True)
            if j["status"] in ("in_progress", "completed", "failed")
        ][:20]
        stages = self._stage_counts_locked(pending)
        fp = stages["fingerprint"]
        quarantined = [
            {"kind": kind, "seriesName": k[0], "episode": k[1], "attempts": v.get("attempts", 0), "error": v.get("error")}
            for kind in self.STAGE_KINDS
            for k, v in self._stage_map(kind).items() if v.get("state") == "quarantined"
        ]
        nodes = sorted(self.worker_nodes.values(), key=lambda n: n["lastHeartbeat"], reverse=True)
        return {
            "nodes": [dict(n) for n in nodes],
            # `counts` describes the fingerprint stage, as older app builds expect.
            "counts": {
                "pending": fp["pending"],
                "inProgress": fp["inProgress"],
                "completed": fp["done"],
                "failed": len(quarantined),          # kept for older app builds
                "quarantined": len(quarantined),
                "retrying": fp["retrying"] + stages["probe"]["retrying"],
                "waitingForProbe": blocked,
                "total": total_scannable,
            },
            "stages": stages,
            "tvBusy": self._tv_busy(),
            "jobs": active_jobs,
            "pendingPreview": pending[:10],
            "quarantinedEpisodes": quarantined[:50],
        }

    def get_worker_status(self):
        self.refresh_series()
        with self.worker_lock:
            self._prune_worker_state_locked(time.time())
            return self._worker_status_snapshot_locked()

    def _tv_busy(self):
        with self.ws_lock:
            return bool(self.tv_state.get("active")) and not self.tv_state.get("paused")

    def _node_speed(self, node, kind):
        stats = (node.get("stats") or {}).get(kind) or {}
        return stats.get("avgSeconds")

    def _schedule_locked(self, node, kinds, pending):
        """Pick a task for this node, or (None, reason) if it should wait."""
        # 1) Device health — phones report power/thermal; nodes that report nothing are not limited.
        thermal = node.get("thermal")
        if thermal in ("serious", "critical"):
            return None, "too hot"
        if node.get("lowPowerMode"):
            return None, "Low Power Mode"
        if node.get("power") == "battery":
            level = node.get("batteryLevel")
            if not isinstance(level, (int, float)) or level < self.PHONE_MIN_BATTERY_ON_BATTERY:
                return None, "on battery — plug in to help"
        # 2) Don't starve the TV stream.
        if self._tv_busy():
            busy = sum(1 for j in self.worker_jobs.values() if j["status"] == "in_progress")
            if busy >= self.TV_BUSY_MAX_JOBS:
                return None, "TV is playing"
        candidates = [p for p in pending if p["kind"] in kinds]
        if not candidates:
            return None, "nothing to do"
        # 3) Speed: leave the last few tasks of a kind to much faster online nodes.
        item = candidates[0]
        mine = self._node_speed(node, item["kind"])
        if mine:
            faster = [
                n for n in self.worker_nodes.values()
                if n is not node and n.get("status") != "offline" and item["kind"] in (n.get("kinds") or ["fingerprint"])
                and self._node_speed(n, item["kind"]) and mine / self._node_speed(n, item["kind"]) > self.SLOW_NODE_FACTOR
            ]
            remaining = sum(1 for p in pending if p["kind"] == item["kind"])
            if faster and remaining <= len(faster):
                return None, f"leaving it to {faster[0].get('nodeName', 'a faster node')}"
        return item, None

    def node_wait_reason(self, node_id):
        with self.worker_lock:
            node = self.worker_nodes.get(str(node_id or ""))
            return node.get("waitReason") if node else None

    def claim_worker_job(self, payload):
        node_id = str(payload.get("nodeId") or "").strip()
        if not node_id:
            raise ValueError("nodeId required")
        node_name = str(payload.get("nodeName") or node_id)[:64]
        platform_name = str(payload.get("platform") or "unknown")[:24]
        # v2 workers say which task kinds they run; v1 workers (no `kinds`) only fingerprint.
        raw_kinds = payload.get("kinds")
        kinds = [k for k in raw_kinds if k in self.STAGE_KINDS] if isinstance(raw_kinds, list) else ["fingerprint"]
        caps = [str(c)[:32] for c in payload.get("caps", []) if isinstance(c, str)][:20] if isinstance(payload.get("caps"), list) else []
        self.refresh_series()
        now = time.time()
        with self.worker_lock:
            self._prune_worker_state_locked(now)
            # Release any stale in-progress job previously held by this same node.
            for job in self.worker_jobs.values():
                if job["nodeId"] == node_id and job["status"] == "in_progress":
                    job["status"] = "expired"
                    job["error"] = "reclaimed by node"
                    self.store.save_job(job)
            node = self.worker_nodes.setdefault(node_id, {
                "nodeId": node_id,
                "nodeName": node_name,
                "platform": platform_name,
                "status": "idle",
                "currentJobId": None,
                "currentSeries": None,
                "currentEpisode": None,
                "progress": 0,
                "lastHeartbeat": now,
            })
            node["nodeName"] = node_name
            node["platform"] = platform_name
            node["kinds"] = kinds
            node["caps"] = caps
            node["lastHeartbeat"] = now
            # Optional device health (phones): power "charging"|"full"|"battery", batteryLevel 0–1,
            # thermal "nominal"|"fair"|"serious"|"critical", lowPowerMode bool.
            node["power"] = payload.get("power") if payload.get("power") in ("charging", "full", "battery") else None
            level = payload.get("batteryLevel")
            node["batteryLevel"] = float(level) if isinstance(level, (int, float)) and 0 <= level <= 1 else None
            node["thermal"] = payload.get("thermal") if payload.get("thermal") in ("nominal", "fair", "serious", "critical") else None
            node["lowPowerMode"] = payload.get("lowPowerMode") is True
            if node["status"] == "offline":
                node["status"] = "idle"

            pending, _, _ = self._scan_worker_catalog_locked()
            item, wait_reason = self._schedule_locked(node, kinds, pending)
            node["waitReason"] = wait_reason
            if item is None:
                node["status"] = "idle"
                node["currentJobId"] = None
                node["currentSeries"] = None
                node["currentEpisode"] = None
                node["progress"] = 0
                return None, self._worker_status_snapshot_locked()

            kind = item["kind"]
            series_idx = item["series"]
            series_name = item["seriesName"]
            ep_idx = item["episodeIndex"]
            ep_name = item["episode"]
            folder, episodes = self.series[series_idx]
            prefix = f"{series_idx}/" if series_idx else ""

            job_id = f"{series_idx}:{ep_idx}:{kind[0]}:{secrets.token_hex(4)}"
            self.worker_jobs[job_id] = {
                "jobId": job_id,
                "kind": kind,
                "series": series_idx,
                "seriesName": series_name,
                "episode": ep_name,
                "episodeIndex": ep_idx,
                "status": "in_progress",
                "nodeId": node_id,
                "nodeName": node_name,
                "progress": 0,
                "leasedAt": now,
                "leaseExpiresAt": now + self.WORKER_LEASE_SECONDS,
                "error": None,
            }
            self.store.save_job(self.worker_jobs[job_id])
            self.store.log_event("claimed", job_id, node_id, {"kind": kind, "series": series_name, "episode": ep_name})
            node["status"] = "working"
            node["currentJobId"] = job_id
            node["currentSeries"] = series_name
            node["currentEpisode"] = ep_name if kind == "fingerprint" else f"{ep_name} ({kind})"
            node["progress"] = 0

            job_payload = {
                "jobId": job_id,
                "kind": kind,
                "series": series_idx,
                "seriesName": series_name,
                "episode": ep_name,
                "episodeIndex": ep_idx,
                "url": item["url"],
                "durationHint": item["durationHint"],
                "leaseSeconds": self.WORKER_LEASE_SECONDS,
            }
            if kind == "fingerprint":
                # Compare against several other episodes of the series, nearest first. One reference is
                # not enough: a first episode often has no opening (or a special ending), and matching
                # only against it finds nothing in every later episode.
                names = [file.name for file, _ in episodes]
                cached = [(r_name, samples) for (s_name, r_name), samples in self.series_samples.items()
                          if s_name == series_name and r_name != ep_name and r_name in names and "edAudio" in samples]
                cached.sort(key=lambda item: (names.index(item[0]) == 0, abs(names.index(item[0]) - ep_idx)))
                references = [samples for _, samples in cached[:self.FINGERPRINT_REFERENCES]]
                ref_samples = references[0] if references else None
                job_payload["referenceSamplesList"] = references
                ref_episode = None
                if ref_samples is None:
                    # Sample a neighbour, avoiding the first episode when there is another choice.
                    if ep_idx - 1 >= 1:
                        ref_idx = ep_idx - 1
                    elif ep_idx + 1 < len(episodes):
                        ref_idx = ep_idx + 1
                    else:
                        ref_idx = 0 if ep_idx != 0 else 1
                    ref_file, _ = episodes[ref_idx]
                    ref_episode = {
                        "episode": ref_file.name,
                        "episodeIndex": ref_idx,
                        "url": f"{prefix}{ref_idx}/video",
                    }
                job_payload["referenceSamples"] = ref_samples
                job_payload["referenceEpisode"] = ref_episode
            return job_payload, self._worker_status_snapshot_locked()

    def update_worker_progress(self, payload):
        job_id = payload.get("jobId")
        node_id = payload.get("nodeId")
        progress = payload.get("progress")
        if not isinstance(job_id, str) or not isinstance(node_id, str) or not isinstance(progress, (int, float)):
            return None
        pct = max(0, min(100, int(round(progress))))
        now = time.time()
        with self.worker_lock:
            job = self.worker_jobs.get(job_id)
            if not job or job["status"] != "in_progress" or job["nodeId"] != node_id:
                return None
            job["progress"] = pct
            job["leaseExpiresAt"] = now + self.WORKER_LEASE_SECONDS
            self.store.save_job(job)
            node = self.worker_nodes.get(node_id)
            if node:
                node["progress"] = pct
                node["lastHeartbeat"] = now
                node["status"] = "working"
            return self._worker_status_snapshot_locked()

    @staticmethod
    def _clean_probe(probe):
        """Keep only the small, known probe fields a worker reports."""
        if not isinstance(probe, dict):
            return None
        out = {}
        if isinstance(probe.get("duration"), (int, float)) and probe["duration"] > 0:
            out["duration"] = float(probe["duration"])
        for field in ("container", "videoCodec", "audioCodec"):
            if isinstance(probe.get(field), str):
                out[field] = probe[field][:40]
        for field in ("width", "height"):
            if isinstance(probe.get(field), int):
                out[field] = probe[field]
        if isinstance(probe.get("fps"), (int, float)):
            out["fps"] = float(probe["fps"])
        for field in ("audio", "subtitles"):
            tracks = probe.get(field)
            if isinstance(tracks, list):
                out[field] = [
                    {k: str(v)[:60] for k, v in t.items() if k in ("codec", "lang", "title", "channels") and v is not None}
                    for t in tracks[:20] if isinstance(t, dict)
                ]
        if isinstance(probe.get("tvSafe"), bool):
            out["tvSafe"] = probe["tvSafe"]
        return out

    def complete_worker_job(self, payload):
        job_id = payload.get("jobId")
        node_id = payload.get("nodeId")
        if not isinstance(job_id, str) or not isinstance(node_id, str):
            raise ValueError("jobId and nodeId required")
        error = payload.get("error")
        themes = payload.get("themes")
        samples = payload.get("samples")
        ref_samples = payload.get("referenceSamples")
        ref_ep_name = payload.get("referenceEpisode")
        now = time.time()

        sync_payload = None
        with self.worker_lock:
            job = self.worker_jobs.get(job_id)
            if not job:
                raise ValueError("unknown jobId")
            kind = job.get("kind", "fingerprint")
            series_idx = job["series"]
            series_name = job["seriesName"]
            ep_name = job["episode"]
            key = (series_name, ep_name)
            already_done = (self._stage_map(kind).get(key) or {}).get("state") == "done"

            if kind == "fingerprint":
                if isinstance(samples, dict) and ("op" in samples or "ed" in samples):
                    self.series_samples[key] = samples
                    self.store.save_samples(key, samples)
                if isinstance(ref_samples, dict) and isinstance(ref_ep_name, str) and ref_ep_name:
                    self.series_samples[(series_name, ref_ep_name)] = ref_samples
                    self.store.save_samples((series_name, ref_ep_name), ref_samples)

            node = self.worker_nodes.get(node_id)
            if node and not error and not already_done:
                # Learn how long this node takes per task kind (exponential moving average).
                took = max(0.1, now - job["leasedAt"])
                stats = node.setdefault("stats", {}).setdefault(kind, {"avgSeconds": None, "done": 0})
                stats["avgSeconds"] = round(took if not stats["avgSeconds"] else 0.7 * stats["avgSeconds"] + 0.3 * took, 2)
                stats["done"] += 1
            if node:
                node["lastHeartbeat"] = now
                if node.get("currentJobId") == job_id:
                    node["status"] = "idle"
                    node["currentJobId"] = None
                    node["currentSeries"] = None
                    node["currentEpisode"] = None
                    node["progress"] = 0

            if already_done:
                # First finisher wins; a late duplicate (e.g. after a lease expired and was re-run) is dropped.
                job["status"] = "completed" if not error else "failed"
                self.store.save_job(job)
                self.store.log_event("duplicate_dropped", job_id, node_id, {"kind": kind, "series": series_name, "episode": ep_name})
            elif error:
                err_msg = str(error)[:200]
                self._record_failure_locked(key, err_msg, now, job_id, node_id, kind)
                job["status"] = "failed"
                job["error"] = err_msg
                self.store.save_job(job)
            elif kind == "probe":
                probe = self._clean_probe(payload.get("probe"))
                if not probe:
                    self._record_failure_locked(key, "probe result missing", now, job_id, node_id, kind)
                    job["status"] = "failed"
                    job["error"] = "probe result missing"
                else:
                    job["status"] = "completed"
                    job["progress"] = 100
                    self._record_done_locked(key, job_id, node_id, kind, result=probe)
                self.store.save_job(job)
            else:
                job["status"] = "completed"
                job["progress"] = 100
                self.store.save_job(job)
                self._record_done_locked(key, job_id, node_id)
                found = isinstance(themes, dict) and any(isinstance(themes.get(p), dict) for p in ("op", "ed", "recap"))
                if not found:
                    self.empty_fingerprints.add(key)
                else:
                    self.empty_fingerprints.discard(key)
                    # Episodes of this series that found nothing (often because their only reference
                    # was an unusual episode) get one more try, now with this episode as a reference.
                    for other in [k for k in self.empty_fingerprints if k[0] == series_name and k not in self.rechecked_fingerprints]:
                        self.empty_fingerprints.discard(other)
                        self.rechecked_fingerprints.add(other)
                        self.episode_state.pop(other, None)
                        self.store.delete_episode(other)
                        self.store.log_event("recheck_requested", data={"series": other[0], "episode": other[1]})
                if found:
                    sync_payload = {
                        "series": series_idx,
                        "seriesName": series_name,
                        "episode": ep_name,
                        "themes": themes,
                    }
            status_snapshot = self._worker_status_snapshot_locked()

        if sync_payload is not None:
            # Publish stage: runs on the coordinator.
            self.sync_metadata(sync_payload)
            self.broadcast({"type": "sync", **sync_payload})
            self.store.log_event("published", job_id, node_id, {"series": series_name, "episode": ep_name})
        self.broadcast({"type": "worker_status", **status_snapshot})

    def get_probe_info(self, series_name, episode):
        with self.worker_lock:
            info = self._stage_map("probe").get((series_name, episode)) or {}
            return info.get("result")

    def retry_worker_episodes(self, payload):
        """Clear quarantine/backoff so tasks are offered again.

        Body: {seriesName, episode, kind?} (kind omitted = every stage of that episode) or {all: true}.
        """
        with self.worker_lock:
            targets = []
            if payload.get("all") is True:
                for kind in self.STAGE_KINDS:
                    targets += [(kind, k) for k, v in self._stage_map(kind).items()
                                if v.get("state") in ("quarantined", "retrying")]
            else:
                series_name, episode = payload.get("seriesName"), payload.get("episode")
                if not isinstance(series_name, str) or not isinstance(episode, str):
                    raise ValueError("seriesName and episode required")
                kinds = [payload["kind"]] if payload.get("kind") in self.STAGE_KINDS else list(self.STAGE_KINDS)
                targets = [(kind, (series_name, episode)) for kind in kinds
                           if (series_name, episode) in self._stage_map(kind)]
            retried = 0
            for kind, key in targets:
                if self._stage_map(kind).get(key, {}).get("state") == "done":
                    continue
                self._stage_map(kind).pop(key, None)
                if kind == "fingerprint":
                    self.store.delete_episode(key)
                else:
                    self.store.delete_stage(kind, key)
                self.store.log_event("retry_requested", data={"kind": kind, "series": key[0], "episode": key[1]})
                retried += 1
            snapshot = self._worker_status_snapshot_locked()
        self.broadcast({"type": "worker_status", **snapshot})
        return retried, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", nargs="?", type=Path, default=DEFAULT_FOLDER,
                        help="Series or library folder (defaults to ~/Downloads/Arc Anime)")
    parser.add_argument("--metadata", type=Path, help="Optional Anime Study TV playback data JSON")
    parser.add_argument("--host", type=ipaddress.IPv4Address,
                        help="Address to listen on. Defaults to every interface, answering only this Mac, private networks and Tailscale.")
    parser.add_argument("--port", type=int, default=46158)
    parser.add_argument("--token", help="Optional 16-hex-character URL token for stable TV bookmarking")
    parser.add_argument("--verbose", action="store_true", help="Log request types and HTTP statuses")
    parser.add_argument("--queue-db", type=Path, help="Worker queue SQLite file (defaults to ~/Library/Application Support/AnimeStudy/)")
    options = parser.parse_args()
    if options.token and not re.fullmatch(r"[a-f0-9]{16}", options.token):
        parser.error("Use a 16-character lowercase hex token.")
    host = options.host or ipaddress.IPv4Address("0.0.0.0")
    if not (host.is_unspecified or any(host in network for network in ALLOWED_CLIENTS)):
        parser.error("Use a private or Tailscale address.")
    folder = options.folder.expanduser().resolve()
    metadata = options.metadata.expanduser() if options.metadata else None
    try:
        queue_db = options.queue_db.expanduser() if options.queue_db else None
        with TVServer((str(host), options.port), folder, metadata, options.verbose, options.token, queue_db) as server:
            urls = server.addresses() if host.is_unspecified else [f"http://{host}:{server.server_port}/{server.token}/"]
            for url in urls or [f"http://127.0.0.1:{server.server_port}/{server.token}/"]:
                print(f"Anime Study TV: {url}", flush=True)
            count = sum(len(episodes) for _, episodes in server.series)
            print(f"{len(server.series)} series · {count} episodes. Keep this command running while watching.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
