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
