import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/background/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const storageKey = 'arc_chrome_state_v1';

function fixture() {
  return {
    spaces: [
      { id: 'personal', name: 'Personal', icon: '', theme: 'indigo', pinnedItems: [
        { id: 'pin', type: 'link', title: 'Saved', url: 'https://saved.test' },
        { id: 'folder', type: 'folder', title: 'Folder', children: [
          { id: 'child', type: 'link', title: 'Child', url: 'https://child.test' }
        ] }
      ] },
      { id: 'work', name: 'Work', icon: '', theme: 'ocean', pinnedItems: [] }
    ],
    activeSpaceId: 'personal',
    favorites: [{ id: 'favorite', title: 'Favorite', url: 'https://favorite.test' }],
    tabSpaceMap: { 1: 'personal', 2: 'personal', 3: 'personal', 4: 'personal', 5: 'personal', 6: 'personal', 7: 'work', 8: 'personal' },
    tabLastAccessed: { 7: 100 },
    settings: { leftSidebarMode: 'hover' }
  };
}

function tab(id, url, extra = {}) {
  return { id, url, title: url, windowId: 1, index: id, active: false, pinned: false, ...extra };
}

function harness(state = fixture(), initialTabs = []) {
  let tabs = structuredClone(initialTabs);
  let listener;
  const removed = [];
  const updated = [];
  const created = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: event(), onStartup: event(),
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async () => {}, getURL: (path) => `chrome-extension://arc/${path}`
    },
    storage: { local: { get: async () => ({ [storageKey]: structuredClone(state) }), set: async () => {} } },
    tabs: {
      onCreated: event(), onUpdated: event(), onActivated: event(), onRemoved: event(),
      query: async (query) => tabs.filter((tab) =>
        (!query.active || tab.active) && (!query.currentWindow || tab.windowId === 1)
        && (query.windowId === undefined || tab.windowId === query.windowId)),
      get: async (id) => tabs.find((tab) => tab.id === id),
      update: async (id, change) => {
        const target = tabs.find((tab) => tab.id === id);
        assert.ok(target, `Tab ${id} exists`);
        if (change.active) for (const tab of tabs) if (tab.windowId === target.windowId) tab.active = false;
        Object.assign(target, change);
        updated.push(id);
        return target;
      },
      create: async (options) => {
        const result = tab(100 + created.length, options.url, { ...options });
        tabs.push(result); created.push(result); return result;
      },
      remove: async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        removed.push(...list); tabs = tabs.filter((tab) => !list.includes(tab.id));
      }
    },
    windows: { update: async () => {}, get: async () => ({ type: 'normal' }) },
    contextMenus: { onClicked: event() }, commands: { onCommand: event() }
  };
  vm.runInNewContext(compiled.outputFiles[0].text, { chrome, URL, structuredClone, console, setTimeout, crypto });
  const message = (message, sender = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 1000);
    listener(message, sender, (result) => { clearTimeout(timeout); resolve(result); });
  });
  return { message, removed, updated, created };
}

test('saved hover mode and removed default Favorites survive loading', async () => {
  const state = fixture(); state.favorites = [];
  const { state: loaded } = await harness(state).message({ type: 'GET_SNAPSHOT' });
  assert.equal(loaded.settings.leftSidebarMode, 'hover');
  assert.equal(loaded.favorites.length, 0);
});

test('an obsolete active Space falls back to an existing Space', async () => {
  const state = fixture(); state.activeSpaceId = 'deleted';
  const { state: loaded } = await harness(state).message({ type: 'GET_SNAPSHOT' });
  assert.equal(loaded.activeSpaceId, 'personal');
});

for (const command of [
  { type: 'CLEAR_TODAY_TABS' },
  { type: 'EXECUTE_OMNIBOX_ACTION', actionId: 'CLEAR_TODAY_TABS' }
]) {
  test(`${command.type} preserves saved, native pinned, active and other-Space tabs`, async () => {
    const app = harness(fixture(), [
      tab(1, 'https://saved.test/'), tab(2, 'https://child.test/'), tab(3, 'https://favorite.test/'),
      tab(4, 'https://native.test', { pinned: true }), tab(5, 'https://active.test', { active: true }),
      tab(6, 'https://today.test'), tab(7, 'https://work.test')
    ]);
    await app.message(command);
    assert.deepEqual(app.removed, [6]);
  });
}

test('pinning repeatedly and moving into a folder keeps one saved item and its identity', async () => {
  const app = harness();
  await app.message({ type: 'PIN_TAB_TO_SPACE', title: 'Duplicate', url: 'https://saved.test/' });
  const { state } = await app.message({ type: 'PIN_TAB_TO_SPACE', title: 'Moved', url: 'https://saved.test/', folderId: 'folder' });
  const items = state.spaces[0].pinnedItems;
  assert.equal(items.length, 1);
  assert.equal(items[0].children.length, 2);
  assert.equal(items[0].children[1].id, 'pin');
  assert.equal(items[0].children[1].title, 'Saved');
});

test('opening a URL uses its Space instead of stealing another Space tab', async () => {
  const app = harness(fixture(), [tab(7, 'https://saved.test/')]);
  await app.message({ type: 'OPEN_OR_SWITCH_URL', url: 'https://saved.test', spaceId: 'personal' });
  assert.equal(app.created.length, 1);
  assert.deepEqual(app.updated, []);
});

test('opening a saved URL reuses a matching tab in that Space', async () => {
  const app = harness(fixture(), [tab(1, 'https://saved.test/'), tab(7, 'https://saved.test/')]);
  await app.message({ type: 'OPEN_OR_SWITCH_URL', url: 'https://saved.test', spaceId: 'personal' });
  assert.equal(app.created.length, 0);
  assert.deepEqual(app.updated, [1]);
});

test('Favorites reuse their existing tab across Spaces', async () => {
  const app = harness(fixture(), [tab(7, 'https://favorite.test/')]);
  await app.message({ type: 'OPEN_OR_SWITCH_URL', url: 'https://favorite.test', spaceId: 'personal' });
  assert.equal(app.created.length, 0);
  assert.deepEqual(app.updated, [7]);
});

test('switching Space restores its most recent tab in the sender window', async () => {
  const state = fixture(); state.tabSpaceMap[8] = 'work'; state.tabSpaceMap[9] = 'work';
  state.tabLastAccessed[8] = 200; state.tabLastAccessed[9] = 300;
  const app = harness(state, [tab(7, 'https://old.test'), tab(8, 'https://recent.test'), tab(9, 'https://other-window.test', { windowId: 2 })]);
  await app.message({ type: 'SET_ACTIVE_SPACE', spaceId: 'work' }, { tab: { windowId: 1 } });
  assert.deepEqual(app.updated, [8]);
});

test('refreshing a snapshot does not change the tab usage order', async () => {
  const state = fixture(); state.tabLastAccessed[1] = 1234;
  const app = harness(state, [tab(1, 'https://saved.test', { active: true })]);
  await app.message({ type: 'GET_SNAPSHOT' });
  const snapshot = await app.message({ type: 'GET_SNAPSHOT' });
  assert.equal(snapshot.state.tabLastAccessed[1], 1234);
});

test('a failed tab operation returns an error instead of leaving the UI waiting', async () => {
  const app = harness();
  const response = await app.message({ type: 'SWITCH_TAB', tabId: 999 });
  assert.equal(response.ok, false);
  assert.ok(response.error);
});

test('search shows the open tab once instead of also listing its saved pin', async () => {
  const app = harness(fixture(), [tab(1, 'https://saved.test/')]);
  const { items } = await app.message({ type: 'SEARCH_OMNIBOX', query: 'saved.test' });
  const matches = Array.from(items).filter((item) => item.url === 'https://saved.test/' || item.url === 'https://saved.test');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'tab');
});

test('search keeps matching pinned pages in other Spaces', async () => {
  const state = fixture(); state.spaces[1].pinnedItems.push({ id: 'work-pin', type: 'link', title: 'Saved work', url: 'https://saved.test' });
  const app = harness(state, [tab(1, 'https://saved.test/')]);
  const { items } = await app.message({ type: 'SEARCH_OMNIBOX', query: 'saved' });
  assert.ok(items.some((item) => item.kind === 'pinned' && item.spaceId === 'work'));
});

test('search prioritises the active Space and recently used tabs', async () => {
  const state = fixture(); state.tabLastAccessed = { 1: 100, 2: 200, 7: 300 };
  const app = harness(state, [tab(7, 'https://work.test'), tab(1, 'https://older.test'), tab(2, 'https://recent.test')]);
  const { items } = await app.message({ type: 'SEARCH_OMNIBOX', query: '' });
  assert.deepEqual(Array.from(items).filter((item) => item.kind === 'tab').map((item) => item.tabId), [2, 1, 7]);
});

test('Clear records recoverable URLs with the original Space and restore removes only that entry', async () => {
  const app = harness(fixture(), [tab(5, 'https://active.test', { active: true }), tab(6, 'https://today.test')]);
  const { state } = await app.message({ type: 'CLEAR_TODAY_TABS' });
  assert.equal(state.archive.length, 1);
  assert.equal(state.archive[0].url, 'https://today.test');
  assert.equal(state.archive[0].spaceId, 'personal');
  const restored = await app.message({ type: 'RESTORE_ARCHIVED_TAB', archiveId: state.archive[0].id });
  assert.equal(app.created[0].url, 'https://today.test');
  assert.equal(restored.state.archive.length, 0);
  assert.equal(restored.state.tabSpaceMap[app.created[0].id], 'personal');
});

test('restore into a deleted Space falls back to the active Space', async () => {
  const state = fixture();
  state.archive = [{ id: 'old', title: 'Old', url: 'https://old.test', spaceId: 'deleted', archivedAt: 1 }];
  const app = harness(state);
  const result = await app.message({ type: 'RESTORE_ARCHIVED_TAB', archiveId: 'old' });
  assert.equal(result.state.tabSpaceMap[app.created[0].id], 'personal');
  assert.equal(result.state.archive.length, 0);
});

test('a linked pinned tab stays out of Today after navigation and Reset Space restores its URL', async () => {
  const app = harness(fixture(), [tab(1, 'https://saved.test/')]);
  await app.message({ type: 'OPEN_OR_SWITCH_URL', url: 'https://saved.test', spaceId: 'personal' });
  await app.message({ type: 'NAVIGATE_CURRENT_TAB', tabId: 1, url: 'https://navigated.test' });
  await app.message({ type: 'CLEAR_TODAY_TABS' });
  assert.deepEqual(app.removed, []);
  await app.message({ type: 'RESET_SPACE' });
  const { tabs } = await app.message({ type: 'GET_SNAPSHOT' });
  assert.equal(tabs[0].url, 'https://saved.test');
});

test('rename finds nested pins and rejects blank names without changing the saved URL', async () => {
  const app = harness();
  const result = await app.message({ type: 'RENAME_PINNED_ITEM', itemId: 'child', title: '  Notes  ' });
  const child = result.state.spaces[0].pinnedItems[1].children[0];
  assert.equal(child.title, 'Notes'); assert.equal(child.url, 'https://child.test');
  const bad = await app.message({ type: 'RENAME_PINNED_ITEM', itemId: 'child', title: ' ' });
  assert.equal(bad.ok, false);
});

test('Split View returns an explicit capability error on older browsers', async () => {
  const result = await harness().message({ type: 'CREATE_SPLIT_VIEW', firstTabId: 1, secondTabId: 2 });
  assert.equal(result.ok, false); assert.match(result.error, /does not expose the Split View API/);
});
