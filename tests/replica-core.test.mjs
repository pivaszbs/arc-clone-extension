import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// shared/sync/replica-core.ts is the sync engine every app uses; it must agree with native/tv/replica.py.
const { outputFiles } = await build({ entryPoints: ['shared/sync/replica-core.ts'], bundle: true, write: false, format: 'esm' });
const { createReplica } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const memory = () => { let text = null; return { read: () => text, write: value => { text = value; } }; };

/** A tiny stand-in for the Mac: stores ops, returns what the caller hasn't seen. */
function fakeMac() {
  const ops = [];
  const sent = [];
  return {
    sent,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, count: body.ops.length });
      for (const op of body.ops) if (!ops.some(o => o.node === op.node && o.seq === op.seq)) ops.push(op);
      const vv = {};
      for (const op of ops) vv[op.node] = Math.max(vv[op.node] ?? 0, op.seq);
      const missing = ops.filter(op => op.seq > (body.vv[op.node] ?? 0) && op.node !== body.node);
      return { ok: true, json: async () => ({ node: 'mac-1', vv, ops: missing }) };
    },
  };
}

test('uses the Mac clock format, keeps one op per key, and the newest write wins', () => {
  const replica = createReplica(memory(), 'test');
  replica.setLocal('ep/S/E.mp4/progress', { position: 1 }, 1000);
  replica.setLocal('ep/S/E.mp4/progress', { position: 2 }, 2000);
  assert.equal(replica.getRegister('ep/S/E.mp4/progress').position, 2);
  assert.equal(replica.setLocal('ep/S/E.mp4/progress', { position: 0 }, 500), false, 'an older edit loses');
  assert.match(replica.nodeId(), /^test-[0-9a-f]{8}$/);
});

test('two devices converge through the Mac, in either order', async () => {
  const mac = fakeMac();
  const phone = createReplica(memory(), 'ios', mac.fetch);
  const chrome = createReplica(memory(), 'chrome', mac.fetch);
  phone.setLocal('ep/S/E1.mp4/progress', { position: 600 }, 5000);
  chrome.setLocal('ep/S/E1.mp4/themes', { ed: { start: 1300, end: 1390 } });
  const seen = [];
  phone.onRemoteChange(key => seen.push(key));
  await phone.syncWith('http://lan/');
  await chrome.syncWith('http://lan/');
  await phone.syncWith('http://lan/');
  assert.equal(chrome.getRegister('ep/S/E1.mp4/progress').position, 600);
  assert.deepEqual(phone.getRegister('ep/S/E1.mp4/themes').ed, { start: 1300, end: 1390 });
  assert.deepEqual(seen, ['ep/S/E1.mp4/themes']);
});

test('switching to the Tailscale address does not resend what the Mac already has', async () => {
  const mac = fakeMac();
  const phone = createReplica(memory(), 'ios', mac.fetch);
  phone.setLocal('a', 1);
  phone.setLocal('b', 2);
  await phone.syncWith('http://192.168.1.10:46158/t/');
  await phone.syncWith('http://mac.tail1234.ts.net:46158/t/');   // new address, same Mac: nothing resent
  await phone.syncWith('http://mac.tail1234.ts.net:46158/t/');
  phone.setLocal('c', 3);
  await phone.syncWith('http://192.168.1.10:46158/t/');
  assert.deepEqual(mac.sent.map(s => s.count), [2, 0, 0, 1]);
});

test('state survives a restart from its store', () => {
  const store = memory();
  const first = createReplica(store, 'ios');
  first.setLocal('k', 'v');
  return new Promise(resolve => setTimeout(() => {
    const again = createReplica(store, 'ios');
    assert.equal(again.getRegister('k'), 'v');
    assert.equal(again.nodeId(), first.nodeId());
    resolve();
  }, 400));
});
