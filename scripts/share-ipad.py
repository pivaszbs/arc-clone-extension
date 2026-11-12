"""Serve only the iPad install artifacts over the Mac's Wi-Fi address for two hours."""
import argparse
import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, default=8791)
args = parser.parse_args()
folder = Path(__file__).resolve().parent.parent / 'outputs' / 'ipad'
token = secrets.token_hex(6)
base = f'http://{args.host}:{args.port}/{token}'
files = {
    'arc-japanese.user.js': 'text/javascript; charset=utf-8',
    'arc-japanese-ipad.zip': 'application/zip',
    'SETUP.md': 'text/plain; charset=utf-8',
}
for filename in files:
    if not (folder / filename).is_file():
        raise SystemExit(f'Missing iPad artifact: {filename}')
page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Japanese learning · iPad setup</title>
<style>body{{margin:0;background:#201d29;color:#f6f2ff;font:17px/1.6 system-ui,-apple-system,sans-serif}}main{{max-width:600px;margin:40px auto;padding:24px}}h1{{font-size:32px;line-height:1.2}}p{{color:#c7bfd6}}a{{color:#ddc9ff}}.button{{display:block;margin:14px 0;padding:18px;background:#cdb8f4;color:#251c35;border-radius:14px;text-decoration:none;font-weight:650;text-align:center}}.secondary{{background:#383043;color:#eee3ff}}li{{margin:16px 0}}small{{color:#b9adc9}}code{{overflow-wrap:anywhere}}</style>
<main><small>JAPANESE LEARNING · IPAD</small><h1>Get your listening quizzes ready.</h1><p>Keep the iPad and Mac on the same Wi-Fi while installing. Once installed, the Mac can be off.</p>
<h2>1. Install Userscripts</h2><a class="button" href="https://apps.apple.com/gb/app/userscripts/id1463298887?platform=ipad">Get the free Userscripts app</a><p>Open Userscripts once and choose its scripts folder in Files.</p>
<h2>2. Add the learning script</h2><a class="button" href="{base}/arc-japanese.user.js">Open the Japanese learning script</a><p>On the script page, open Safari’s extensions menu, choose Userscripts, and use its install option if offered. Otherwise, download the file below, then move it into the scripts folder you chose.</p>
<a class="button secondary" href="{base}/arc-japanese.user.js?download=1" download="arc-japanese.user.js">Download script to Files</a>
<h2>3. Enable it in Safari</h2><ol><li>In Settings → Apps → Safari → Extensions, enable Userscripts.</li><li>Allow access to YouTube and smotret-anime. Embedded players may need access to their own domain.</li><li>Open Userscripts from Safari’s extensions menu so it notices the new script, then refresh your video page.</li><li>Tap <strong>日本語 Learn</strong> and turn on <strong>Pause for listening quizzes</strong>.</li></ol>
<p>The panel should say <strong>Connected to video</strong> and show the player’s time. Japanese subtitles are required for questions; this version does not transcribe audio.</p>
<p>Use the websites in Safari. The native YouTube app does not run the script. iPad playback still needs a device check.</p>
<a href="{base}/SETUP.md">Full setup guide</a> · <a href="{base}/arc-japanese-ipad.zip" download>Download complete package</a>
<p><small>This local download page expires after two hours. The installed script continues to work.</small></p></main></html>'''.encode()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def serve(self, head):
        parsed = urlsplit(self.path)
        prefix = '/' + token
        if parsed.path in (prefix, prefix + '/'):
            data, content_type, name = page, 'text/html; charset=utf-8', 'setup-page'
        elif parsed.path.startswith(prefix + '/') and parsed.path[len(prefix) + 1:] in files:
            name = parsed.path[len(prefix) + 1:]
            data = (folder / name).read_bytes()
            content_type = files[name]
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if name.endswith('.zip') or 'download' in parse_qs(parsed.query):
            self.send_header('Content-Disposition', f'attachment; filename="{name}"')
        self.end_headers()
        if not head:
            self.wfile.write(data)
        device = 'iPad' if 'iPad' in self.headers.get('User-Agent', '') else 'browser'
        print(f'Served {name} to {device}', flush=True)

    def log_message(self, *_args):
        pass

server = HTTPServer((args.host, args.port), Handler)
server.timeout = 1
state = {'url': base + '/', 'host': args.host, 'port': args.port, 'expires_at': time.time() + 7200}
(folder / 'wifi-session.json').write_text(json.dumps(state, indent=2))
try:
    import qrcode
    qrcode.make(base + '/').save(folder / 'wifi-install-qr.png')
except ImportError:
    pass
print(json.dumps(state), flush=True)
deadline = time.monotonic() + 7200
try:
    while time.monotonic() < deadline:
        server.handle_request()
finally:
    server.server_close()
