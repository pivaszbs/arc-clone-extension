"""Serve one staged episode to Safari and its AirPlay receiver over the local network."""

import ipaddress
import json
import secrets
import socket
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread, Timer
from http.server import ThreadingHTTPServer

ASSETS = Path(__file__).resolve().parent
SESSION_LIMIT = 4 * 60 * 60


def lan_address():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        # Resolve the interface used by the default route without sending a packet.
        route.connect(("192.0.2.1", 80))
        address = route.getsockname()[0]
    network = ipaddress.ip_address(address)
    if network.is_loopback or not network.is_private:
        raise ValueError("Connect your Mac and TV to the same local network.")
    return address


def make_mp4(source, directory, subtitles, video_name="episode.1.mp4", subtitle_name="subtitles.1.vtt"):
    streams = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(source)], timeout=30
    ))["streams"]
    video = next((item for item in streams if item["codec_type"] == "video" and not item.get("disposition", {}).get("attached_pic")), None)
    audio = next((item for item in streams if item["codec_type"] == "audio"), None)
    if not video:
        raise ValueError("This file has no video track.")

    copy_video = video["codec_name"] == "h264" and video.get("pix_fmt") in ("yuv420p", "yuvj420p")
    video_options = ["-c:v", "copy"] if copy_video else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    audio_options = ["-c:a", "copy"] if audio and audio["codec_name"] == "aac" else ["-c:a", "aac", "-b:a", "192k"]
    command = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(source)]
    if subtitles:
        (directory / subtitle_name).write_text(subtitles, encoding="utf-8")
        command.extend(["-i", str(directory / subtitle_name)])
    command.extend(["-map", f"0:{video['index']}", *video_options])
    if audio:
        command.extend(["-map", f"0:{audio['index']}", *audio_options])
    if subtitles:
        command.extend(["-map", "1:s:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn"])
    output = directory / video_name
    subprocess.run([*command, "-movflags", "+faststart", str(output)], check=True, timeout=3600)
    return output


class AirPlaySession:
    def __init__(self, metadata):
        self.id = secrets.token_urlsafe(24)
        self.revision = 1
        self.metadata = {**metadata, "revision": 1, "video": "episode.1.mp4", "subtitlesFile": "subtitles.1.vtt"}
        self.pending_metadata = None
        self.directory = TemporaryDirectory(prefix="anime-study-airplay-")
        self.server = None
        self.timer = None

    def _reset_timer(self, expire):
        if self.timer:
            self.timer.cancel()
        self.timer = Timer(SESSION_LIMIT, expire)
        self.timer.daemon = True
        self.timer.start()

    def start(self, handler, expire):
        directory = Path(self.directory.name)
        source = directory / "source"
        address = lan_address()
        make_mp4(source, directory, self.metadata.pop("subtitles", ""), "episode.1.mp4", "subtitles.1.vtt")
        source.unlink()
        self.server = ThreadingHTTPServer((address, 0), handler)
        self.server.session = self
        Thread(target=self.server.serve_forever, daemon=True).start()
        url = f"http://{address}:{self.server.server_port}/{self.id}/"
        subprocess.run(["/usr/bin/open", "-a", "Safari", url], check=True, timeout=15)
        self._reset_timer(expire)
        return url

    def update_episode(self, expire):
        if not self.pending_metadata:
            raise ValueError("Missing episode metadata.")
        directory = Path(self.directory.name)
        source = directory / "source"
        prev_rev = self.revision
        next_rev = prev_rev + 1
        video_name = f"episode.{next_rev}.mp4"
        subtitle_name = f"subtitles.{next_rev}.vtt"
        meta = dict(self.pending_metadata)
        self.pending_metadata = None
        make_mp4(source, directory, meta.pop("subtitles", ""), video_name, subtitle_name)
        source.unlink()
        self.revision = next_rev
        self.metadata = {**meta, "revision": next_rev, "video": video_name, "subtitlesFile": subtitle_name, "autoplay": True}
        for old_name in (f"episode.{prev_rev}.mp4", f"subtitles.{prev_rev}.vtt"):
            (directory / old_name).unlink(missing_ok=True)
        self._reset_timer(expire)
        return next_rev

    def close(self):
        if self.timer:
            self.timer.cancel()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        self.directory.cleanup()
