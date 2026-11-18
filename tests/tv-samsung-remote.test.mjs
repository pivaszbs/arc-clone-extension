import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function python(code) {
  return execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim();
}

test('Wake-on-LAN packet is six 0xff bytes then the MAC sixteen times', () => {
  const hex = python("from native.tv.samsung_remote import magic_packet; print(magic_packet('28:07:08:B8:03:5C').hex())");
  assert.equal(hex, 'ff'.repeat(6) + '280708b8035c'.repeat(16));
  assert.throws(() => python("from native.tv.samsung_remote import magic_packet; magic_packet('nope')"));
});

test('client WebSocket frames are masked and decode back to the message', () => {
  const out = python(`
import socket
from native.tv.samsung_remote import encode_client_frame, read_server_frame
a, b = socket.socketpair()
message = '{"method":"ms.remote.control"}' * 10
frame = encode_client_frame(message)
assert frame[1] & 0x80, 'clients must mask'
a.sendall(frame)
opcode, payload = read_server_frame(b)
print(opcode, payload.decode() == message)
`);
  assert.equal(out, '1 True');
});

test('only known remote keys are sent to the TV', () => {
  const out = python(`
from native.tv.samsung_remote import SamsungRemote
r = SamsungRemote('/dev/null/none.json')
try:
    r.key('KEY_FACTORY_RESET')
except ValueError:
    print('rejected')
`);
  assert.equal(out, 'rejected');
});

test('UPnP volume requests carry the level, clamped to 0-100, and replies are parsed', () => {
  const out = python(`
from native.tv.samsung_remote import SamsungRemote, soap_envelope, soap_value
body = soap_envelope('SetVolume', (('DesiredVolume', 35),)).decode()
assert '<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">' in body
assert '<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>35</DesiredVolume>' in body
print(soap_value('<u:GetVolumeResponse><CurrentVolume>40\\n</CurrentVolume></u:GetVolumeResponse>', 'CurrentVolume'))
sent = []
r = SamsungRemote('/dev/null/none.json')
r._rendering_control = lambda action, arguments=(): sent.append((action, arguments)) or ''
r.set_volume(140); r.set_volume(-3); r.set_volume(22.6)
print([a[0][1] for _, a in sent])
for bad in ('50', True, None):
    try:
        r.set_volume(bad)
    except ValueError:
        sent.append('rejected')
print(sent.count('rejected'))
`);
  assert.equal(out, '40\n[100, 0, 23]\n3');
});
