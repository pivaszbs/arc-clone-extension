"""Control the Samsung TV set itself (power, volume, keys, launching Anime Study) for the phone remote.

Uses the TV's own remote-control API: http://TV:8001/api/v2/ for status and a TLS WebSocket on
port 8002 for keys and app launches. The first connection shows an "Allow" prompt on the TV; the
token it hands back is kept in ~/Library/Application Support/AnimeStudy/samsung-tv.json. The TV's
address is learnt from the Anime Study TV app's own connection to this server, so nothing needs
configuring. Turning the TV on from off uses Wake-on-LAN with the TV's network MAC address.
"""

import base64
import ipaddress
import json
import os
import socket
import ssl
import struct
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

SETTINGS = Path.home() / "Library" / "Application Support" / "AnimeStudy" / "samsung-tv.json"
APP_ID = "AnimeStudy.AnimeStudy"
CLIENT_NAME = base64.b64encode(b"Anime Study").decode("ascii")
KEYS = frozenset({
    "KEY_POWER", "KEY_POWEROFF", "KEY_VOLUP", "KEY_VOLDOWN", "KEY_MUTE", "KEY_CHUP", "KEY_CHDOWN",
    "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT", "KEY_ENTER", "KEY_RETURN", "KEY_HOME", "KEY_SOURCE",
    "KEY_MENU", "KEY_INFO", "KEY_PLAY", "KEY_PAUSE", "KEY_STOP", "KEY_FF", "KEY_REWIND",
    "KEY_HDMI", "KEY_HDMI1", "KEY_HDMI2", "KEY_HDMI3", "KEY_HDMI4", "KEY_TV", "KEY_EXIT",
})


def _private(ip):
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return address.version == 4 and address.is_private and not address.is_loopback


def magic_packet(mac):
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError("bad MAC address")
    return b"\xff" * 6 + raw * 16


def encode_client_frame(text, opcode=0x1):
    """A masked WebSocket frame, as clients must send."""
    data = text.encode("utf-8") if isinstance(text, str) else text
    mask = os.urandom(4)
    length = len(data)
    if length < 126:
        header = bytes([0x80 | opcode, 0x80 | length])
    elif length < 65536:
        header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
    return header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def _recv_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("TV closed the connection")
        data += chunk
    return data


def read_server_frame(sock):
    head = _recv_exact(sock, 2)
    opcode, length = head[0] & 0x0F, head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    if length > 4_194_304:
        raise ConnectionError("frame too large")
    mask = _recv_exact(sock, 4) if head[1] & 0x80 else b""
    payload = _recv_exact(sock, length)
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


class SamsungRemote:
    def __init__(self, settings_path=SETTINGS):
        self.path = Path(settings_path)
        self.lock = threading.Lock()
        self.sock = None
        self.pairing = False
        self.settings = self._load()

    def _load(self):
        try:
            data = json.loads(self.path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.settings, indent=2), "utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(self.path)
        except OSError:
            pass

    @property
    def ip(self):
        return os.environ.get("ANIME_STUDY_SAMSUNG_TV") or self.settings.get("ip")

    def learn_address(self, ip):
        """Remember the TV's address from the Anime Study app's connection to this server."""
        if not _private(ip) or ip == self.settings.get("ip"):
            return
        with self.lock:
            self._close_locked()
            self.settings["ip"] = ip
            self._save()
        threading.Thread(target=self.device_info, daemon=True).start()

    def device_info(self):
        """What the phone shows: whether the TV is known, reachable, on, and paired."""
        ip = self.ip
        if not ip:
            return {"known": False}
        info = {"known": True, "ip": ip, "paired": bool(self.settings.get("token")), "pairing": self.pairing}
        try:
            with urlopen(f"http://{ip}:8001/api/v2/", timeout=2) as response:
                device = json.loads(response.read(262_144).decode("utf-8")).get("device") or {}
        except (OSError, ValueError):
            return {**info, "power": "off"}
        mac = device.get("wifiMac") or device.get("mac")
        if isinstance(mac, str) and mac.count(":") == 5 and mac != self.settings.get("mac"):
            self.settings["mac"] = mac
            self._save()
        return {**info, "power": "standby" if str(device.get("PowerState", "on")).lower() == "standby" else "on",
                "name": str(device.get("name") or "Samsung TV").replace("&quot;", '"'), "model": device.get("modelName")}

    def _close_locked(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def _connect_locked(self):
        if self.sock:
            return self.sock
        ip = self.ip
        if not ip:
            raise ConnectionError("The TV hasn't connected to this Mac yet. Open Anime Study on the TV once.")
        token = self.settings.get("token")
        path = f"/api/v2/channels/samsung.remote.control?name={CLIENT_NAME}" + (f"&token={token}" if token else "")
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # the TV's certificate is self-signed
        raw = socket.create_connection((ip, 8002), timeout=5)
        sock = context.wrap_socket(raw, server_hostname=ip)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {ip}:8002\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("TV refused the remote connection")
            response += chunk
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            sock.close()
            raise ConnectionError("TV refused the remote connection")
        # Unpaired, the TV shows its Allow prompt and answers only once someone accepts it.
        self.pairing = not token
        sock.settimeout(35 if not token else 8)
        try:
            while True:
                opcode, payload = read_server_frame(sock)
                if opcode == 0x8:
                    raise ConnectionError("Pairing was declined on the TV")
                if opcode != 0x1:
                    continue
                event = json.loads(payload.decode("utf-8"))
                if event.get("event") == "ms.channel.connect":
                    new_token = (event.get("data") or {}).get("token")
                    if new_token and new_token != token:
                        self.settings["token"] = str(new_token)
                        self._save()
                    break
                if event.get("event") == "ms.channel.unauthorized":
                    self.settings.pop("token", None)
                    self._save()
                    raise ConnectionError("Accept the Anime Study prompt on the TV, then try again")
        except socket.timeout:
            sock.close()
            raise ConnectionError("Accept the Anime Study prompt on the TV, then try again")
        finally:
            self.pairing = False
        sock.settimeout(5)
        self.sock = sock
        return sock

    def _send(self, message):
        with self.lock:
            for attempt in (0, 1):
                try:
                    self._connect_locked().sendall(encode_client_frame(json.dumps(message)))
                    return
                except (OSError, ssl.SSLError):
                    self._close_locked()
                    if attempt:
                        raise ConnectionError("The TV did not answer. Is it on and on the same network?")

    def key(self, key):
        if key not in KEYS:
            raise ValueError("unsupported key")
        self._send({"method": "ms.remote.control", "params": {
            "Cmd": "Click", "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"}})

    def launch(self, app_id=APP_ID):
        """Bring an installed app to the front. The REST call works for sideloaded web apps; the
        WebSocket launch event is only a fallback (the S85F ignores it for them)."""
        ip = self.ip
        try:
            with urlopen(Request(f"http://{ip}:8001/api/v2/applications/{app_id}", data=b"", method="POST"), timeout=5) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        self._send({"method": "ms.channel.emit", "params": {
            "event": "ed.apps.launch", "to": "host", "data": {"appId": app_id, "action_type": "DEEP_LINK"}}})

    def power(self, state):
        """'on' wakes the TV (Wake-on-LAN, or the power key from standby); 'off' puts it in standby."""
        info = self.device_info()
        if not info.get("known"):
            raise ConnectionError("The TV hasn't connected to this Mac yet. Open Anime Study on the TV once.")
        if state == "off":
            if info.get("power") == "on":
                self.key("KEY_POWER")
            return
        if info.get("power") == "standby":
            self.key("KEY_POWER")
            return
        if info.get("power") == "on":
            return
        mac = self.settings.get("mac")
        if not mac:
            raise ConnectionError("Turn the TV on once with its remote so this Mac can learn how to wake it.")
        packet = magic_packet(mac)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            # macOS sends 255.255.255.255 out of one interface only; the TV's subnet broadcast is surer.
            subnet = ".".join(self.ip.split(".")[:3] + ["255"])
            for target in (subnet, "255.255.255.255", self.ip):
                for port in (9, 7):
                    try:
                        sock.sendto(packet, (target, port))
                    except OSError:
                        pass

    def open_app(self):
        """Wake the TV if needed and bring Anime Study to the front."""
        info = self.device_info()
        if info.get("power") != "on":
            self.power("on")
            for _ in range(20):
                time.sleep(1)
                if self.device_info().get("power") == "on":
                    break
            time.sleep(2)
        self.launch()
