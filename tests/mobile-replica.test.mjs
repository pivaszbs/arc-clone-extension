import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

// The phone's sync state (mobile/src/lib/replica.ts) must agree with native/tv/replica.py.
const { outputFiles } = await build({
  entryPoints: ['mobile/src/lib/replica.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  alias: { 'expo-file-system': path.resolve('tests/helpers/expo-file-system-shim.mjs') },
});
const source = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64');
let instance = 0;
async function phone() {
  globalThis.__DOCS__ = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-'));
  return import(`${source}#${instance++}`);
}

test('local changes queue one op per key and use the Mac clock format', async () => {
  const replica = await phone();
  replica.setLocal('ep/S/E.mp4/progress', { position: 1, watchedAt: 1000 }, 1000);
  replica.setLocal('ep/S/E.mp4/progress', { position: 2, watchedAt: 2000 }, 2000);
  const { node, vv, ops } = replica.pending();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].value.position, 2);
  assert.equal(ops[0].hlc, `0000000002000:0000:${node}`);
  assert.equal(vv[node], 2);
  replica.acknowledge(ops);
  assert.equal(replica.unsentCount(), 0);
});

test('the newest write wins in either order, and seen ops are not applied twice', async () => {
  const replica = await phone();
  replica.setLocal('ep/S/E.mp4/progress', { position: 600, watchedAt: 5000 }, 5000);
  const older = { node: 'mac', seq: 1, key: 'ep/S/E.mp4/progress', value: { position: 10 }, hlc: '0000000004000:0000:mac' };
  assert.deepEqual(replica.applyRemote([older]), []);
  assert.equal(replica.get('ep/S/E.mp4/progress').position, 600);
  const newer = { ...older, seq: 2, value: { position: 900 }, hlc: '0000000009000:0000:mac' };
  assert.deepEqual(replica.applyRemote([newer]), ['ep/S/E.mp4/progress']);
  assert.deepEqual(replica.applyRemote([newer]), []);
  assert.equal(replica.pending().vv.mac, 2);
  // A later local edit sorts after what the Mac sent.
  replica.setLocal('ep/S/E.mp4/themes', { ed: { start: 1, end: 2 } });
  assert.ok(replica.pending().ops.at(-1).hlc > newer.hlc);
});
