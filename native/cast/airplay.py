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


def make_mp4(source, directory, subtitles):
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
        (directory / "subtitles.vtt").write_text(subtitles, encoding="utf-8")
        command.extend(["-i", str(directory / "subtitles.vtt")])
    command.extend(["-map", f"0:{video['index']}", *video_options])
    if audio:
        command.extend(["-map", f"0:{audio['index']}", *audio_options])
    if subtitles:
        command.extend(["-map", "1:s:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn"])
    output = directory / "episode.mp4"
    subprocess.run([*command, "-movflags", "+faststart", str(output)], check=True, timeout=3600)
    return output


class AirPlaySession:
    def __init__(self, metadata):
        self.id = secrets.token_urlsafe(24)
        self.metadata = metadata
        self.directory = TemporaryDirectory(prefix="anime-study-airplay-")
        self.server = None
        self.timer = None

    def start(self, handler, expire):
        directory = Path(self.directory.name)
        source = directory / "source"
        address = lan_address()
        make_mp4(source, directory, self.metadata.pop("subtitles", ""))
        source.unlink()
        self.server = ThreadingHTTPServer((address, 0), handler)
        self.server.session = self
        Thread(target=self.server.serve_forever, daemon=True).start()
        url = f"http://{address}:{self.server.server_port}/{self.id}/"
        subprocess.run(["/usr/bin/open", "-a", "Safari", url], check=True, timeout=15)
        self.timer = Timer(SESSION_LIMIT, expire)
        self.timer.daemon = True
        self.timer.start()
        return url

    def close(self):
        if self.timer:
            self.timer.cancel()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        self.directory.cleanup()
