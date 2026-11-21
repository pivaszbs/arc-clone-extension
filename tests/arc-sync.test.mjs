import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/shared/arc-sync.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
});
const {
  arcStateToCraSidebar,
  cleanUrl,
  craSnapshotToArcState,
  isoNoMs,
  parsePairingUri,
  stableUuid
} = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);

function sampleState() {
  return {
    spaces: [
      {
        id: 'space-work',
        name: 'Work',
        icon: '💼',
        theme: 'indigo',
        customColors: ['#112233', '#445566'],
        favorites: [{ id: 'fav-1', title: 'GitHub', url: 'https://github.com' }],
        pinnedItems: [
          {
            id: 'folder-1',
            type: 'folder',
            title: 'Docs',
            collapsed: false,
            children: [{ id: 'link-1', type: 'link', title: 'Swift', url: 'https://swift.org' }]
          }
        ]
      }
    ],
    activeSpaceId: 'space-work',
    favorites: [],
    tabSpaceMap: { 101: 'space-work' },
    tabLastAccessed: {},
    settings: {
      targetLanguage: 'en',
      translateOnSelectMode: 'pill',
      peekTrigger: 'shift-click',
      peekMode: 'overlay',
      leftSidebarMode: 'hover',
      syncChromeTabGroups: false,
      autoArchiveHours: 12
    },
    routingRules: [{ id: 'rule-1', pattern: 'github.com', spaceId: 'space-work' }],
    siteSearches: [{ id: 'yt', name: 'YouTube', shortcut: 'yt', url: 'https://youtube.com/results?q=%s' }],
    boosts: [{ id: 'boost-1', host: 'news.ycombinator.com', css: 'body { zoom: 1.05; }', enabled: true, invert: false }],
    syncConfig: {
      enabled: true,
      urls: ['http://127.0.0.1:46280'],
      token: 'secret-token',
      deviceId: 'chrome-1',
      deviceName: 'Chrome'
    }
  };
}

test('stableUuid is deterministic and preserves valid UUIDs', () => {
  const existing = '123E4567-E89B-12D3-A456-426614174000';
  assert.equal(stableUuid(existing), existing.toLowerCase());
  assert.equal(stableUuid('space-work'), stableUuid('space-work'));
  assert.notEqual(stableUuid('space-work'), stableUuid('space-play'));
  assert.match(stableUuid('space-work'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('arcStateToCraSidebar and craSnapshotToArcState round-trip spaces, folders, favorites, routes, and boosts', () => {
  const initial = sampleState();
  const doc = arcStateToCraSidebar(initial, 1750000000000);
  assert.equal(doc.spaces.length, 1);
  assert.deepEqual(doc.spaces[0].theme.colors, ['#112233', '#445566']);

  const snapshot = {
    version: 1,
    revision: 7,
    updatedAt: isoNoMs(1750000000000),
    serverDeviceID: 'mac-1',
    serverDeviceName: "Anton's Mac",
    document: doc,
    routes: [{ id: stableUuid('rule-1'), pattern: 'github.com', spaceID: doc.spaces[0].id, matchStyle: 'contains', littleWindow: false, updatedAt: isoNoMs() }],
    siteSearches: [{ id: 'gh', shortcut: 'gh', label: 'GitHub', urlTemplate: 'https://github.com/search?q=%s' }],
    boosts: [{ id: stableUuid('boost-1'), host: 'news.ycombinator.com', name: 'HN', enabled: true, hue: 15, strength: 0.2, invert: false, contrast: 50, brightness: 50, saturation: 50, textScale: 100, textCase: 'none', zapped: ['.ad'], css: 'body {}', js: '' }],
    devices: [
      { id: 'mac-1', name: "Anton's Mac", platform: 'mac', lastSeenAt: isoNoMs(), activeTabs: [{ id: stableUuid('tab-mac'), url: 'https://apple.com', title: 'Apple', spaceID: doc.spaces[0].id, fromDeviceID: 'mac-1', fromDeviceName: "Anton's Mac", createdAt: isoNoMs() }] },
      { id: 'chrome-1', name: 'Chrome', platform: 'chrome', lastSeenAt: isoNoMs(), activeTabs: [] }
    ],
    pendingHandoffs: []
  };

  const restored = craSnapshotToArcState(snapshot, initial);
  assert.equal(restored.spaces[0].title ?? restored.spaces[0].name, 'Work');
  assert.deepEqual(restored.spaces[0].customColors, ['#112233', '#445566']);
  assert.equal(restored.spaces[0].favorites.length, 1);
  assert.equal(restored.spaces[0].favorites[0].url, 'https://github.com');
  assert.equal(restored.spaces[0].pinnedItems[0].type, 'folder');
  assert.equal(restored.spaces[0].pinnedItems[0].children[0].url, 'https://swift.org');
  assert.equal(restored.remoteDevices.length, 1);
  assert.equal(restored.remoteDevices[0].name, "Anton's Mac");
  assert.deepEqual(restored.boosts[0].zappedSelectors, ['.ad']);
  assert.equal(restored.syncConfig.lastRevision, 7);
});

test('parsePairingUri validates and extracts endpoints', () => {
  const parsed = parsePairingUri('arcsync://pair?name=Studio&token=deadbeef&urls=http://192.168.1.2:46280,http://100.64.0.9:46280');
  assert.deepEqual(parsed, {
    name: 'Studio',
    token: 'deadbeef',
    urls: ['http://192.168.1.2:46280', 'http://100.64.0.9:46280']
  });
  assert.equal(parsePairingUri('https://example.com'), null);
  assert.equal(parsePairingUri('arcsync://pair?name=NoToken&urls=http://127.0.0.1:46280'), null);
});

test('cleanUrl strips UTM and ad tracker params while preserving query args and hash', () => {
  assert.equal(
    cleanUrl('https://example.com/post?id=42&utm_source=x&fbclid=abc#section'),
    'https://example.com/post?id=42#section'
  );
  assert.equal(cleanUrl('https://example.com/path'), 'https://example.com/path');
});
