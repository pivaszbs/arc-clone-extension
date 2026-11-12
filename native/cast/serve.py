"""Serve one explicitly selected episode to one Google Cast receiver."""

import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import pychromecast
from pychromecast.const import CAST_TYPE_AUDIO, CAST_TYPE_GROUP
from airplay import AirPlaySession, ASSETS

PORT = 46157
BUFFER_SIZE = 1024 * 1024
MEDIA_TYPES = {"video/mp4", "video/webm", "video/x-m4v"}
extension_path = Path(__file__).resolve().parents[2] / "dist"
extension_id = hashlib.sha256(str(extension_path).encode()).hexdigest()[:32]
extension_origin = "chrome-extension://" + extension_id.translate(
    str.maketrans("0123456789abcdef", "abcdefghijklmnop")
)


def byte_range(value, size):
    if value is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("Unsupported byte range")
    first, last = match.groups()
    start = int(first) if first else max(0, size - int(last))
    end = min(int(last), size - 1) if first and last else size - 1
    if not 0 <= start <= end < size:
        raise ValueError("Invalid byte range")
    return start, end


class MediaHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def access(self):
        session = self.server.session
        if isinstance(session, AirPlaySession):
            return self.path in (f"/{session.id}/episode.mp4", f"/{session.id}/subtitles.vtt")
        return self.client_address[0] == session.device.host and self.path in (
            f"/{session.id}/video", f"/{session.id}/subtitles.vtt"
        )

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        if not self.access():
            return self.send_error(404)
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_HEAD(self):
        self.serve_media()

    def do_GET(self):
        session = self.server.session
        if isinstance(session, AirPlaySession):
            assets = {
                f"/{session.id}/": ("text/html; charset=utf-8", lambda: (ASSETS / "airplay.html").read_bytes()),
                f"/{session.id}/player.js": ("text/javascript; charset=utf-8", lambda: (ASSETS / "airplay-player.js").read_bytes()),
                f"/{session.id}/episode.json": ("application/json", lambda: json.dumps(session.metadata).encode())
            }
            if self.path in assets:
                content_type, read = assets[self.path]
                data = read()
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(data)
                return
        self.serve_media()

    def serve_media(self):
        if not self.access():
            return self.send_error(404)
        session = self.server.session
        subtitles = self.path.endswith(".vtt")
        if isinstance(session, AirPlaySession):
            requested_name = self.path.rsplit("/", 1)[-1]
            default_name = session.metadata.get("subtitlesFile" if subtitles else "video", "subtitles.vtt" if subtitles else "episode.mp4")
            allowed_name = requested_name if re.fullmatch(r"(?:episode\.\d+\.mp4|subtitles\.\d+\.vtt)", requested_name) else default_name
            path = Path(session.directory.name) / allowed_name
        else:
            path = Path(session.directory.name) / ("subtitles.vtt" if subtitles else "video")
        try:
            source = path.open("rb")
        except FileNotFoundError:
            return self.send_error(404)
        with source:
            size = os.fstat(source.fileno()).st_size
            requested = self.headers.get("Range")
            try:
                start, end = byte_range(requested, size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.cors()
                self.end_headers()
                return
            remaining = end - start + 1
            self.send_response(206 if requested else 200)
            self.cors()
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", "text/vtt; charset=utf-8" if subtitles else getattr(session, "content_type", "video/mp4"))
            self.send_header("Content-Length", str(remaining))
            if requested:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if self.command == "HEAD":
                return
            source.seek(start)
            try:
                while remaining:
                    chunk = source.read(min(BUFFER_SIZE, remaining))
                    if not chunk:
                        return
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


class Session:
    def __init__(self, device, metadata):
        self.device = device
        self.id = secrets.token_urlsafe(24)
        self.content_type = metadata["type"]
        self.title = metadata["title"][:250]
        self.position = metadata["position"]
        self.subtitles = metadata.get("subtitles", "")
        self.directory = TemporaryDirectory(prefix="anime-study-cast-")
        self.receiver = None
        self.media_server = None
        self.url = None
        self.lock = threading.Lock()
        self.closed = False
        self.playing = False

    def play(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect((self.device.host, self.device.port))
            host = route.getsockname()[0]
        self.media_server = ThreadingHTTPServer((host, 0), MediaHandler)
        self.media_server.session = self
        threading.Thread(target=self.media_server.serve_forever, daemon=True).start()
        base = f"http://{host}:{self.media_server.server_port}/{self.id}"
        self.url = f"{base}/video"
        if self.subtitles:
            (Path(self.directory.name) / "subtitles.vtt").write_text(self.subtitles, encoding="utf-8")

        device = self.device
        self.receiver = pychromecast.get_chromecast_from_host(
            (device.host, device.port, device.uuid, device.model_name, device.friendly_name),
            tries=1, timeout=5,
        )
        self.receiver.wait(timeout=8)
        controller = self.receiver.media_controller
        controller.quick_play(
            media_id=self.url, media_type=self.content_type, timeout=15,
            title=self.title, current_time=self.position, stream_type="BUFFERED",
            subtitles=f"{base}/subtitles.vtt" if self.subtitles else None,
            subtitles_lang="ja",
        )
        status = controller.status
        if status.content_id != self.url or status.player_state == "IDLE":
            raise ValueError("The TV did not accept the episode. Check its video and audio format.")
        self.playing = True

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                if self.receiver:
                    controller = self.receiver.media_controller
                    if controller.status.content_id == self.url:
                        controller.stop(timeout=3)
            except Exception:
                pass
            finally:
                try:
                    if self.receiver:
                        self.receiver.disconnect(timeout=3)
                except Exception:
                    pass
                finally:
                    if self.media_server:
                        self.media_server.shutdown()
                        self.media_server.server_close()
                    self.directory.cleanup()


class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def authorized(self):
        return (self.headers.get("Origin") == extension_origin
                and self.headers.get("Host") == f"127.0.0.1:{PORT}")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", extension_origin)
        self.send_header("Access-Control-Allow-Methods", "POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        if not self.authorized():
            return self.send_error(403)
        self.send_response(204)
        self.cors()
        self.end_headers()

    def reply(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_metadata(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 2 * BUFFER_SIZE:
            raise ValueError("Invalid episode metadata.")
        metadata = json.loads(self.rfile.read(size))
        if not isinstance(metadata, dict):
            raise ValueError("Invalid episode metadata.")
        return metadata

    def do_POST(self):
        if not self.authorized():
            return self.send_error(403)
        self.connection.settimeout(30)
        if self.path == "/devices":
            with self.server.lock:
                session = self.server.session
            if session and session.playing and not session.closed:
                if session.receiver.media_controller.status.player_state != "IDLE":
                    return self.reply({"devices": [], "session": {"id": session.id, "title": session.title}})
                self.clear_session(session)
            try:
                discovered, browser = pychromecast.discover_chromecasts(timeout=5)
                browser.stop_discovery()
                devices = {
                    str(device.uuid): device for device in discovered
                    if device.cast_type not in (CAST_TYPE_AUDIO, CAST_TYPE_GROUP)
                    and ipaddress.ip_address(device.host).version == 4
                }
                with self.server.lock:
                    self.server.devices = devices
                return self.reply({"devices": [
                    {"id": key, "name": device.friendly_name or device.host}
                    for key, device in devices.items()
                ]})
            except Exception as error:
                print(f"Cast discovery failed: {error}", flush=True)
                return self.reply({"error": "Could not search for TVs on this network."}, 502)
        if self.path.startswith("/airplay/") and self.path.endswith("/episode"):
            try:
                data = self.read_metadata()
                title, position, subtitles = data["title"], data["position"], data.get("subtitles", "")
                if not isinstance(title, str) or not math.isfinite(position) or position < 0 or not isinstance(subtitles, str):
                    raise ValueError("Invalid episode metadata.")
                with self.server.airplay_lock:
                    session = self.server.airplay
                    if not session or self.path != f"/airplay/{session.id}/episode" or not session.server:
                        return self.reply({"error": "AirPlay session expired. Try again."}, 404)
                    session.pending_metadata = {
                        "title": title[:250], "position": position, "subtitles": subtitles,
                        "hasSubtitles": bool(subtitles), "skips": data.get("skips", {})
                    }
                    return self.reply({"ok": True})
            except (KeyError, ValueError, TypeError, OSError):
                return self.reply({"error": "Could not prepare this episode for AirPlay."}, 400)
        if self.path == "/airplay":
            try:
                data = self.read_metadata()
                title, position, subtitles = data["title"], data["position"], data.get("subtitles", "")
                if not isinstance(title, str) or not math.isfinite(position) or position < 0 or not isinstance(subtitles, str):
                    raise ValueError("Invalid episode metadata.")
                with self.server.airplay_lock:
                    if self.server.airplay:
                        self.server.airplay.close()
                    self.server.airplay = AirPlaySession({
                        "title": title[:250], "position": position, "subtitles": subtitles,
                        "hasSubtitles": bool(subtitles), "skips": data.get("skips", {})
                    })
                    return self.reply({"id": self.server.airplay.id})
            except (KeyError, ValueError, TypeError, OSError):
                return self.reply({"error": "Could not prepare this episode for AirPlay."}, 400)
        if self.path != "/session":
            return self.reply({"error": "Unknown cast request."}, 404)

        try:
            metadata = self.read_metadata()
            if (metadata["type"] not in MEDIA_TYPES or not isinstance(metadata["title"], str)
                    or not math.isfinite(metadata["position"]) or metadata["position"] < 0
                    or not isinstance(metadata.get("subtitles", ""), str)):
                raise ValueError()
            with self.server.lock:
                device = self.server.devices.get(metadata["device"])
                if not device:
                    return self.reply({"error": "Search for the TV again."}, 404)
                if self.server.session:
                    return self.reply({"error": "Stop the current cast first."}, 409)
                session = Session(device, metadata)
                self.server.session = session
            return self.reply({"id": session.id})
        except (KeyError, ValueError, TypeError, OSError):
            return self.reply({"error": "Could not prepare this episode for casting."}, 400)

    def find_session(self):
        with self.server.lock:
            session = self.server.session
            if session and self.path == f"/session/{session.id}":
                return session
        return None

    def clear_session(self, session):
        try:
            session.close()
        finally:
            with self.server.lock:
                if self.server.session is session:
                    self.server.session = None

    def do_PUT(self):
        if not self.authorized():
            return self.send_error(403)
        if self.path.startswith("/airplay/") and self.path.endswith("/episode"):
            with self.server.airplay_lock:
                session = self.server.airplay
                if not session or self.path != f"/airplay/{session.id}/episode" or not session.server:
                    return self.reply({"error": "AirPlay session expired. Try again."}, 404)
                try:
                    self.connection.settimeout(30)
                    self.receive_video(Path(session.directory.name) / "source")
                    revision = session.update_episode(lambda: self.clear_airplay(session))
                    return self.reply({"revision": revision})
                except FileNotFoundError:
                    error = "Install FFmpeg (ffmpeg and ffprobe) on the Mac, then try again."
                except Exception as failure:
                    print(f"AirPlay episode switch failed: {failure}", flush=True)
                    error = "Could not switch the AirPlay episode. Check the file and your local network."
                return self.reply({"error": error}, 502)
        if self.path.startswith("/airplay/"):
            with self.server.airplay_lock:
                session = self.server.airplay
                if not session or self.path != f"/airplay/{session.id}" or session.server:
                    return self.reply({"error": "AirPlay session expired. Try again."}, 404)
                try:
                    self.connection.settimeout(30)
                    self.receive_video(Path(session.directory.name) / "source")
                    url = session.start(MediaHandler, lambda: self.clear_airplay(session))
                    return self.reply({"url": url})
                except FileNotFoundError:
                    error = "Install FFmpeg (ffmpeg and ffprobe) on the Mac, then try again."
                except Exception as failure:
                    print(f"AirPlay preparation failed: {failure}", flush=True)
                    error = "Could not prepare the AirPlay MP4 or open Safari. Check the file and your local network."
                self.server.airplay = None
                session.close()
                return self.reply({"error": error}, 502)
        session = self.find_session()
        if not session:
            return self.reply({"error": "Cast session expired. Try again."}, 404)
        self.connection.settimeout(30)
        try:
            with session.lock:
                if session.closed or session.receiver:
                    return self.reply({"error": "This cast session is already in use."}, 409)
                self.receive_video(Path(session.directory.name) / "video")
                session.play()
            self.reply({"playing": True})
        except Exception as error:
            print(f"Cast start failed: {error}", flush=True)
            self.clear_session(session)
            self.reply({"error": "The TV could not start this episode. Check its connection and media format."}, 502)

    def receive_video(self, path):
        remaining = int(self.headers.get("Content-Length", "0"))
        if remaining <= 0:
            raise ValueError("The episode file is empty.")
        with path.open("wb") as target:
            while remaining:
                chunk = self.rfile.read(min(BUFFER_SIZE, remaining))
                if not chunk:
                    raise ValueError("The episode transfer was interrupted.")
                target.write(chunk)
                remaining -= len(chunk)

    def clear_airplay(self, session):
        with self.server.airplay_lock:
            if self.server.airplay is session:
                self.server.airplay = None
                session.close()

    def do_DELETE(self):
        if not self.authorized():
            return self.send_error(403)
        if self.path.startswith("/airplay/"):
            with self.server.airplay_lock:
                session = self.server.airplay
            if session and self.path == f"/airplay/{session.id}":
                self.clear_airplay(session)
            return self.reply({"stopped": True})
        session = self.find_session()
        if session:
            self.clear_session(session)
        self.reply({"stopped": True})


def main():
    with ThreadingHTTPServer(("127.0.0.1", PORT), ControlHandler) as server:
        server.lock = threading.Lock()
        server.devices = {}
        server.session = None
        server.airplay = None
        server.airplay_lock = threading.Lock()
        print(f"Anime Study Cast is ready on port {PORT}. Press Ctrl+C to stop.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            if server.session:
                server.session.close()
            if server.airplay:
                server.airplay.close()


if __name__ == "__main__":
    main()
