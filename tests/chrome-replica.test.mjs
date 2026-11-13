import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Chrome's adapter must write the same keys the phone and the Mac use.
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return { ok: true, json: async () => ({ node: 'mac', vv: {}, ops: [{ node: 'ios-1', seq: 1, key: 'ep/Show/E2.mp4/progress', value: { position: 42, watchedAt: 9, finished: false }, hlc: '0000000000009:0000:ios-1' }] }) };
};
const { outputFiles } = await build({ entryPoints: ['src/japanese/replica.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { recordChange, parseEpisodeKey, replica } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('page changes become shared keys and sync to the Mac', async () => {
  recordChange({ seriesName: 'Show', episode: 'E1.mp4', themes: { ed: { start: 1300, end: 1390, source: 'auto' }, op: null } });
  recordChange({ seriesName: 'Show', episode: 'E1.mp4', progress: { position: 321, watchedAt: 5000, finished: false } });
  recordChange({ seriesName: 'Show', autoSkip: { op: true, ed: false } });
  assert.deepEqual(replica.getRegister('ep/Show/E1.mp4/themes'), { ed: { start: 1300, end: 1390, source: 'auto' } });
  assert.equal(replica.getRegister('ep/Show/E1.mp4/progress').position, 321);
  assert.deepEqual(replica.getRegister('series/Show/autoSkip'), { op: true, ed: false });
  const seen = [];
  replica.onRemoteChange(key => seen.push(parseEpisodeKey(key)));
  await replica.syncWith('http://mac/t/');
  assert.equal(posts[0].body.ops.length, 3);
  assert.match(posts[0].body.node, /^chrome-/);
  assert.deepEqual(seen, [{ series: 'Show', episode: 'E2.mp4', field: 'progress' }]);
  await new Promise(r => setTimeout(r, 350));
  assert.ok(store.get('arc-replica'), 'state saved in localStorage');
});
