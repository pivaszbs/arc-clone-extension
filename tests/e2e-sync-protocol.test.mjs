import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { encodeNativeMessage, readEndpoint } from '../native/arc-sync/host.mjs';
import { registerArcSyncHost } from '../scripts/install-arc-sync.mjs';

const compiledSync = await build({
  entryPoints: ['src/shared/arc-sync.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
});
const { arcStateToCraSidebar, craSnapshotToArcState, isoNoMs, stableUuid } = await import(
  `data:text/javascript,${encodeURIComponent(compiledSync.outputFiles[0].text)}`
);

test('E2E sync wire protocol round-trips Chrome state, enforces auth, and exchanges handoffs', async () => {
  const token = 'test-secret-token';
  let serverRevision = 1;
  const pendingHandoffs = [];
  let serverDoc = {
    version: 1,
    spaceOrder: [stableUuid('space-work')],
    spaces: [
      {
        id: stableUuid('space-work'),
        title: 'Work',
        emoji: '💼',
        theme: { colors: ['#3f42c8', '#1f1e3f'], intensity: 0.85, noise: 0.15, appearance: 'auto', vibrant: false, solid: false },
        favoritesContainerID: stableUuid('container:fav:' + stableUuid('space-work')),
        pinnedContainerID: stableUuid('container:pin:' + stableUuid('space-work')),
        todayContainerID: stableUuid('container:today:' + stableUuid('space-work')),
        createdAt: isoNoMs()
      }
    ],
    items: [
      { id: stableUuid('container:fav:' + stableUuid('space-work')), parentID: null, title: null, children: [], isUnread: false, createdAt: isoNoMs(), data: { container: { favorites: { spaceID: stableUuid('space-work') } } } },
      { id: stableUuid('container:pin:' + stableUuid('space-work')), parentID: null, title: null, children: [], isUnread: false, createdAt: isoNoMs(), data: { container: { pinned: { spaceID: stableUuid('space-work') } } } },
      { id: stableUuid('container:today:' + stableUuid('space-work')), parentID: null, title: null, children: [], isUnread: false, createdAt: isoNoMs(), data: { container: { today: { spaceID: stableUuid('space-work') } } } }
    ]
  };

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'Test Mac', version: 1 }));
      return;
    }
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.method === 'POST' && req.url === '/v1/sync') {
        serverRevision++;
        serverDoc = body.document;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          merged: true,
          snapshot: {
            version: 1,
            revision: serverRevision,
            updatedAt: isoNoMs(),
            serverDeviceID: 'mac-test',
            serverDeviceName: 'Test Mac',
            document: serverDoc,
            routes: body.routes || [],
            siteSearches: body.siteSearches || [],
            boosts: body.boosts || [],
            devices: [body.device],
            pendingHandoffs: pendingHandoffs.splice(0, pendingHandoffs.length)
          }
        }));
      } else if (req.method === 'POST' && req.url === '/v1/handoff') {
        pendingHandoffs.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 1, revision: serverRevision, updatedAt: isoNoMs(), serverDeviceID: 'mac-test', serverDeviceName: 'Test Mac', document: serverDoc, routes: [], siteSearches: [], boosts: [], devices: [], pendingHandoffs }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauth = await fetch(`${baseUrl}/v1/snapshot`);
    assert.equal(unauth.status, 401);

    const handoffRes = await fetch(`${baseUrl}/v1/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: stableUuid('handoff-1'),
        url: 'https://developer.apple.com',
        title: 'Apple Dev',
        fromDeviceID: 'ios-1',
        fromDeviceName: 'iPhone',
        targetDeviceID: 'chrome-1',
        createdAt: isoNoMs()
      })
    });
    assert.equal(handoffRes.status, 200);

    const chromeState = {
      spaces: [{ id: 'space-work', name: 'Work', icon: '💼', theme: 'indigo', favorites: [], pinnedItems: [{ id: 'p-1', type: 'link', title: 'MDN', url: 'https://developer.mozilla.org' }] }],
      activeSpaceId: 'space-work',
      favorites: [],
      tabSpaceMap: {},
      tabLastAccessed: {},
      settings: { targetLanguage: 'en', translateOnSelectMode: 'pill', peekTrigger: 'shift-click', peekMode: 'overlay', leftSidebarMode: 'hover', syncChromeTabGroups: false, autoArchiveHours: 12 },
      syncConfig: { enabled: true, urls: [baseUrl], token, deviceId: 'chrome-1', deviceName: 'Chrome' }
    };

    const syncRes = await fetch(`${baseUrl}/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        device: { id: 'chrome-1', name: 'Chrome', platform: 'chrome', lastSeenAt: isoNoMs(), activeTabs: [] },
        document: arcStateToCraSidebar(chromeState)
      })
    });
    assert.equal(syncRes.status, 200);
    const data = await syncRes.json();
    assert.equal(data.snapshot.pendingHandoffs.length, 1);
    assert.equal(data.snapshot.pendingHandoffs[0].url, 'https://developer.apple.com');

    const converged = craSnapshotToArcState(data.snapshot, chromeState);
    assert.equal(converged.spaces[0].pinnedItems[0].url, 'https://developer.mozilla.org');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Native sync host reads sync-endpoint.json and installer writes valid manifest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'arc-sync-host-'));
  try {
    const endpointPath = path.join(dir, 'sync-endpoint.json');
    await writeFile(endpointPath, JSON.stringify({ port: 46280, urls: ['http://127.0.0.1:46280'], token: 'tok123', deviceName: 'Mac' }));

    const read = await readEndpoint(endpointPath);
    assert.equal(read.ok, true);
    assert.equal(read.endpoint.token, 'tok123');

    const encoded = encodeNativeMessage({ ok: true });
    assert.equal(encoded.readUInt32LE(0), JSON.stringify({ ok: true }).length);

    const installed = await registerArcSyncHost({
      destinationDir: dir,
      extensionIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
    });
    assert.ok(installed.manifestPath.endsWith('local.arcclone.sync.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
