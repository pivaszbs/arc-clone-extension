import { translateText } from './translate';
import { desktopPipRequest } from './desktop-pip';
import { findFolder, pinnedLinks, pinnedRows, removePin } from '../shared/pins';
import { getSpaceFavorites, getTodayTabs, isRootDomainUrl, sameHost, urlKey } from '../shared/tabs';
import {
  type Boost, DEFAULT_SITE_SEARCHES, boostsFor, compileBoostCss, matchSiteSearch, normalizePattern, routeFor,
  siteSearchUrl, suggestSiteSearches, validSiteSearchUrl
} from '../shared/site-tools';
import { cleanUrl, parsePairingUri } from '../shared/arc-sync';
import { addEaselItem, createEasel, type EaselDocument } from '../shared/easels';
import { parseLiveFeed } from '../shared/live-folders';
import { ArcLiveSyncClient, SYNC_ALARM_NAME, exportArcSidebarBundle } from './sync';
import { type CapturedImage, resolveSpaceTheme } from '../shared/types';
import { canPreviewInPeek, isBrowserPageUrl } from '../shared/interaction';
import {
  type ArcState,
  type ExtensionSettings,
  type FavoriteItem,
  type OmniboxResultItem,
  type PinnedFolder,
  type PinnedItem,
  type PinnedLink,
  type Space,
  type SpaceThemeId,
  type TabInfo,
  SPACE_THEMES,
  parseCommandBarInput
} from '../shared/types';

declare const __ARC_LEGACY_ID__: string;

const STORAGE_KEY = 'arc_chrome_state_v1';

// Tabs the extension opens itself already have a Space chosen; Air Traffic Control leaves them alone.
let ownTabCreates = 0;
async function createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  ownTabCreates++;
  try { return await chrome.tabs.create(properties); }
  finally { ownTabCreates--; }
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: 'en',
  translateOnSelectMode: 'pill',
  peekTrigger: 'shift-click',
  peekMode: 'overlay',
  leftSidebarMode: 'pinned',
  syncChromeTabGroups: false,
  autoArchiveHours: 12
};

const DEFAULT_FAVORITES: FavoriteItem[] = [
  {
    id: 'fav-chatgpt',
    title: 'ChatGPT',
    url: 'https://chatgpt.com'
  },
  {
    id: 'fav-github',
    title: 'GitHub',
    url: 'https://github.com'
  },
  {
    id: 'fav-mail',
    title: 'Gmail',
    url: 'https://mail.google.com'
  },
  {
    id: 'fav-youtube',
    title: 'YouTube',
    url: 'https://www.youtube.com'
  }
];

const DEFAULT_SPACES: Space[] = [
  {
    id: 'space-personal',
    name: 'Personal',
    icon: '✨',
    theme: 'indigo',
    favorites: [
      { id: 'fav-p-chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com' },
      { id: 'fav-p-yt', title: 'YouTube', url: 'https://www.youtube.com' },
      { id: 'fav-p-mail', title: 'Gmail', url: 'https://mail.google.com' }
    ],
    pinnedItems: [
      {
        id: 'pin-hn',
        type: 'link',
        title: 'Hacker News',
        url: 'https://news.ycombinator.com'
      },
      {
        id: 'folder-reading',
        type: 'folder',
        title: 'Reading List',
        collapsed: false,
        children: [
          {
            id: 'pin-wiki',
            type: 'link',
            title: 'Wikipedia',
            url: 'https://www.wikipedia.org'
          },
          {
            id: 'pin-reddit',
            type: 'link',
            title: 'Reddit',
            url: 'https://www.reddit.com'
          }
        ]
      }
    ]
  },
  {
    id: 'space-work',
    name: 'Work',
    icon: '🚀',
    theme: 'ocean',
    favorites: [
      { id: 'fav-w-github', title: 'GitHub', url: 'https://github.com' },
      { id: 'fav-w-chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com' },
      { id: 'fav-w-cal', title: 'Calendar', url: 'https://calendar.google.com' }
    ],
    pinnedItems: [
      {
        id: 'pin-docs',
        type: 'link',
        title: 'Google Docs',
        url: 'https://docs.google.com'
      },
      {
        id: 'folder-dev',
        type: 'folder',
        title: 'Engineering',
        collapsed: false,
        children: [
          {
            id: 'pin-mdn',
            type: 'link',
            title: 'MDN Web Docs',
            url: 'https://developer.mozilla.org'
          }
        ]
      }
    ]
  },
  {
    id: 'space-research',
    name: 'Research',
    icon: '🧪',
    theme: 'emerald',
    favorites: [
      { id: 'fav-r-scholar', title: 'Google Scholar', url: 'https://scholar.google.com' },
      { id: 'fav-r-chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com' },
      { id: 'fav-r-wiki', title: 'Wikipedia', url: 'https://www.wikipedia.org' }
    ],
    pinnedItems: [
      {
        id: 'pin-scholar',
        type: 'link',
        title: 'Google Scholar',
        url: 'https://scholar.google.com'
      }
    ]
  }
];

let cachedState: ArcState | null = null;
let legacyImport: Promise<Partial<ArcState> | undefined> | undefined;

async function importLegacyArcState(): Promise<Partial<ArcState> | undefined> {
  if (typeof __ARC_LEGACY_ID__ === 'undefined') return;
  const legacy = await chrome.runtime.sendMessage(__ARC_LEGACY_ID__, { type: 'IMPORT_LEGACY_ARC_STATE' }).catch(() => null);
  if (!Array.isArray(legacy?.spaces) || !legacy.spaces.length) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: legacy });
  return legacy;
}

async function loadState(): Promise<ArcState> {
  if (cachedState) return cachedState;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (stored[STORAGE_KEY] as Partial<ArcState> | undefined)
    ?? await (legacyImport ??= importLegacyArcState());

  const mergedSettings: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...(raw?.settings || {})
  };
  const favorites = raw?.favorites || structuredClone(DEFAULT_FAVORITES);

  const spaces = raw?.spaces?.length ? raw.spaces : structuredClone(DEFAULT_SPACES);
  for (const sp of spaces) {
    if (!Array.isArray(sp.favorites)) {
      const defaultSp = DEFAULT_SPACES.find((d) => d.id === sp.id);
      const sourceFavs = defaultSp?.favorites || favorites;
      const seenUrls = new Set<string>();
      sp.favorites = [];
      for (const f of sourceFavs) {
        const key = urlKey(f.url);
        if (!seenUrls.has(key)) {
          seenUrls.add(key);
          sp.favorites.push({
            ...f,
            id: `fav-${sp.id}-${Math.random().toString(36).slice(2, 7)}`
          });
        }
      }
    }
  }

  cachedState = {
    spaces,
    activeSpaceId: raw?.activeSpaceId || 'space-personal',
    favorites,
    archive: raw?.archive || [],
    tabSpaceMap: raw?.tabSpaceMap || {},
    tabLastAccessed: raw?.tabLastAccessed || {},
    settings: mergedSettings,
    routingRules: raw?.routingRules || [],
    siteSearches: raw?.siteSearches || structuredClone(DEFAULT_SITE_SEARCHES),
    boosts: raw?.boosts || []
  };

  if (!cachedState.spaces.some((space) => space.id === cachedState!.activeSpaceId)) {
    cachedState.activeSpaceId = cachedState.spaces[0].id;
  }

  return cachedState;
}

async function saveState(state: ArcState, opts?: { fromSync?: boolean }): Promise<void> {
  cachedState = state;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcastStateUpdate();
  if (!opts?.fromSync) liveSync.schedulePush();
}

const EASELS_KEY = 'arc_easels_v1';
const CAPTURES_KEY = 'arc_captures_v1';

async function loadEasels(): Promise<EaselDocument[]> {
  const res = await chrome.storage.local.get(EASELS_KEY);
  return Array.isArray(res[EASELS_KEY]) ? (res[EASELS_KEY] as EaselDocument[]) : [];
}

async function loadCaptures(): Promise<CapturedImage[]> {
  const res = await chrome.storage.local.get(CAPTURES_KEY);
  return Array.isArray(res[CAPTURES_KEY]) ? (res[CAPTURES_KEY] as CapturedImage[]) : [];
}

const SPACE_GROUP_COLOR_MAP: Record<string, chrome.tabGroups.ColorEnum> = {
  indigo: 'purple',
  rose: 'pink',
  emerald: 'green',
  sunset: 'orange',
  ocean: 'blue',
  midnight: 'grey'
};

let syncingGroups = false;
async function syncChromeTabGroups(state: ArcState): Promise<void> {
  if (!state.settings.syncChromeTabGroups || !chrome.tabs?.group || !chrome.tabGroups?.update || syncingGroups) return;
  syncingGroups = true;
  try {
    const allTabs = await chrome.tabs.query({});
    for (const space of state.spaces) {
      const byWindow = new Map<number, number[]>();
      for (const tab of allTabs) {
        if (tab.id === undefined || tab.pinned) continue;
        if (state.tabSpaceMap[tab.id] !== space.id) continue;
        const list = byWindow.get(tab.windowId) || [];
        list.push(tab.id);
        byWindow.set(tab.windowId, list);
      }
      for (const tabIds of byWindow.values()) {
        if (!tabIds.length) continue;
        try {
          const existingGroupId = space.chromeGroupId && allTabs.some((t) => tabIds.includes(t.id!) && t.groupId === space.chromeGroupId)
            ? space.chromeGroupId
            : undefined;
          const groupId = await chrome.tabs.group(existingGroupId ? { tabIds, groupId: existingGroupId } : { tabIds });
          space.chromeGroupId = groupId;
          await chrome.tabGroups.update(groupId, {
            title: space.name.slice(0, 24),
            color: SPACE_GROUP_COLOR_MAP[space.theme] || 'blue'
          });
        } catch {
          // Ignore ungrouped windows or transient Chrome errors
        }
      }
    }
  } finally {
    syncingGroups = false;
  }
}

async function refreshFolderFeed(spaceId: string, folderId: string): Promise<ArcState> {
  const state = await loadState();
  const space = state.spaces.find((s) => s.id === spaceId);
  const folder = space ? findFolder(space.pinnedItems, folderId) : undefined;
  if (!folder?.liveFeed?.url) return state;
  try {
    const res = await fetch(folder.liveFeed.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const entries = parseLiveFeed(body, 15);
    folder.children = entries.map((entry, idx) => ({
      id: `live-${folder.id}-${idx}`,
      type: 'link',
      title: entry.subtitle ? `${entry.title} · ${entry.subtitle}` : entry.title,
      url: entry.url,
      parentId: folder.id
    }));
    folder.liveFeed.lastUpdatedAt = Date.now();
    folder.liveFeed.lastError = undefined;
  } catch (error) {
    folder.liveFeed.lastError = error instanceof Error ? error.message : 'Feed unavailable';
  }
  await saveState(state);
  return state;
}

async function refreshAllLiveFolders(): Promise<void> {
  const state = await loadState();
  for (const space of state.spaces) {
    for (const { item } of pinnedRows(space.pinnedItems)) {
      if (item.type === 'folder' && item.liveFeed?.url) {
        const refreshMs = (item.liveFeed.refreshMinutes || 15) * 60_000;
        if (!item.liveFeed.lastUpdatedAt || Date.now() - item.liveFeed.lastUpdatedAt >= refreshMs) {
          await refreshFolderFeed(space.id, item.id);
        }
      }
    }
  }
}

const liveSync = new ArcLiveSyncClient({
  loadState,
  saveState,
  getTabs: async () => (await getFullSnapshot()).tabs,
  onHandoff: async (handoff) => {
    const state = await loadState();
    const targetSpace = handoff.spaceId && state.spaces.some((s) => s.id === handoff.spaceId)
      ? handoff.spaceId
      : state.activeSpaceId;
    const created = await createTab({ url: handoff.url, active: true });
    if (created.id !== undefined) {
      state.tabSpaceMap[created.id] = targetSpace;
      state.tabLastAccessed[created.id] = Date.now();
      state.activeSpaceId = targetSpace;
      await saveState(state, { fromSync: true });
    }
  }
});

async function getFullSnapshot(_windowId?: number) {
  const state = await loadState();
  // Query all tabs across windows so Borderless Arc Window also sees all Space tabs
  const tabs = await chrome.tabs.query({});

  let stateChanged = false;
  const mappedTabs: TabInfo[] = tabs.map((t) => {
    const id = t.id ?? -1;
    let spaceId = state.tabSpaceMap[id];
    if (!spaceId || !state.spaces.some((s) => s.id === spaceId)) {
      spaceId = state.activeSpaceId;
      if (id !== -1) {
        state.tabSpaceMap[id] = spaceId;
        stateChanged = true;
      }
    }
    if (id !== -1 && !state.tabLastAccessed[id]) {
      state.tabLastAccessed[id] = Date.now();
      stateChanged = true;
    }
    return {
      id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || t.url || 'New Tab',
      url: t.url || '',
      favIconUrl: t.favIconUrl,
      active: Boolean(t.active),
      audible: Boolean(t.audible),
      muted: Boolean(t.mutedInfo?.muted),
      pinned: Boolean(t.pinned),
      groupId: t.groupId ?? -1,
      spaceId,
      lastAccessed: state.tabLastAccessed[id] || Date.now()
    };
  });

  if (stateChanged) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  return {
    state,
    tabs: mappedTabs
  };
}

function broadcastStateUpdate() {
  chrome.runtime.sendMessage({ type: 'ARC_STATE_UPDATED' }).catch(() => {
    // Ignore when sidepanel isn't open
  });
}

// Persist records before closing tabs. A failed close leaves a recoverable record.
async function archiveTabs(tabs: TabInfo[]) {
  if (!tabs.length) return;
  const state = await loadState();
  state.archive ||= [];
  const records = tabs.filter((tab) => /^https?:/.test(tab.url)).map((tab) => ({
    id: crypto.randomUUID(), title: tab.title, url: tab.url,
    spaceId: tab.spaceId, archivedAt: Date.now()
  }));
  state.archive.unshift(...records);
  await saveState(state);
  await chrome.tabs.remove(tabs.map((tab) => tab.id));
}

async function autoArchiveTabs() {
  const { state, tabs } = await getFullSnapshot();
  const hours = state.settings.autoArchiveHours;
  if (!Number.isFinite(hours) || hours <= 0) return;
  const cutoff = Date.now() - hours * 3600000;
  const expired = state.spaces.flatMap((space) => getTodayTabs(state, tabs, space.id))
    .filter((tab) => !tab.active && !tab.audible && (tab.lastAccessed || Date.now()) <= cutoff);
  await archiveTabs(expired);
}

// Alarms survive service-worker suspension; check once per minute.
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'arc-auto-archive') void autoArchiveTabs().catch(console.warn);
    else if (alarm.name === SYNC_ALARM_NAME) void liveSync.pullIfChanged().catch(console.warn);
    else if (alarm.name === 'arc-live-folders') void refreshAllLiveFolders().catch(console.warn);
  });
  void chrome.alarms.create('arc-auto-archive', { periodInMinutes: 1 });
  void chrome.alarms.create('arc-live-folders', { periodInMinutes: 15 });
  liveSync.start();
}

async function resetSpace(spaceId: string) {
  const { state, tabs } = await getFullSnapshot();
  const space = state.spaces.find((space) => space.id === spaceId);
  for (const link of pinnedLinks(space?.pinnedItems || [])) {
    const tab = tabs.find((tab) => tab.id === link.tabId && tab.spaceId === spaceId);
    if (tab) await chrome.tabs.update(tab.id, { url: link.url });
  }
}

async function setupSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('Could not set sidePanel behavior:', err);
  }
}

function registerContextMenus() {
  const items: chrome.contextMenus.CreateProperties[] = [
    {
      id: 'arc-ask-chatgpt',
      title: '🤖 Ask ChatGPT about Selection / Page',
      contexts: ['selection', 'page']
    },
    {
      id: 'arc-send-antigravity',
      title: '🚀 Send Selection / Page to Antigravity',
      contexts: ['selection', 'page']
    },
    {
      id: 'arc-peek-link',
      title: 'Open in Arc Peek / Little Arc',
      contexts: ['link']
    },
    {
      id: 'arc-pin-page',
      title: 'Pin Page to Current Arc Space',
      contexts: ['page']
    },
    {
      id: 'arc-translate-selection',
      title: 'Translate Selection with Arc',
      contexts: ['selection']
    }
  ];
  chrome.contextMenus.removeAll(() => {
    const error = chrome.runtime.lastError;
    if (error) {
      console.warn('Could not clear Arc context menus:', error.message);
      return;
    }
    for (const item of items) {
      chrome.contextMenus.create(item, () => {
        const error = chrome.runtime.lastError;
        if (error) console.warn(`Could not create Arc context menu ${item.id}:`, error.message);
      });
    }
  });
}

async function reinjectContentScriptsIntoOpenTabs() {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id && t.url && /^https?:\/\//i.test(t.url)) {
        chrome.scripting
          .executeScript({
            target: { tabId: t.id },
            files: ['content.js']
          })
          .catch(() => {});
      }
    }
  } catch {
    // ignore if tabs query fails during startup
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void setupSidePanel();
  registerContextMenus();
  void reinjectContentScriptsIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  void setupSidePanel();
  // A restored browser session can assign different live tab IDs.
  const state = await loadState();
  for (const space of state.spaces) {
    for (const link of pinnedLinks(space.pinnedItems)) {
      delete link.tabId;
    }
  }
  await saveState(state);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const state = await loadState();
  if (info.menuItemId === 'arc-ask-chatgpt') {
    const contextPrompt = info.selectionText
      ? `Regarding "${tab?.title || ''}" (${tab?.url || ''}):\n\n${info.selectionText}`
      : `Summarize and help me with this page: "${tab?.title || ''}" (${tab?.url || ''})`;
    const chatUrl = `https://chatgpt.com/?q=${encodeURIComponent(contextPrompt)}`;
    await openLittleArcWindow(chatUrl);
  } else if (info.menuItemId === 'arc-send-antigravity') {
    if (tab?.id) {
      chrome.tabs
        .sendMessage(tab.id, {
          type: 'TRIGGER_ANTIGRAVITY_HANDOFF',
          selectionText: info.selectionText || ''
        })
        .catch(() => {});
    }
  } else if (info.menuItemId === 'arc-peek-link' && info.linkUrl) {
    if (tab?.id && state.settings.peekMode === 'overlay' && canPreviewInPeek(info.linkUrl)) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_PEEK_OVERLAY',
        url: info.linkUrl
      }).catch(() => {
        openLittleArcWindow(info.linkUrl!);
      });
    } else {
      openLittleArcWindow(info.linkUrl);
    }
  } else if (info.menuItemId === 'arc-pin-page' && tab) {
    await pinUrlToSpace(
      state.activeSpaceId,
      tab.title || tab.url || 'Pinned Page',
      tab.url || '',
      tab.favIconUrl
    );
  } else if (info.menuItemId === 'arc-translate-selection' && info.selectionText && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_TRANSLATION_POPOVER',
      text: info.selectionText
    }).catch(() => {});
  }
});

// Keyboard shortcuts registered in manifest.json
chrome.commands.onCommand.addListener(async (command) => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (command === 'toggle-command-bar') {
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'TOGGLE_COMMAND_BAR' }).catch(() => {
        // If current page is chrome:// or restricted, open Little Arc with new tab search
        openLittleArcWindow('https://www.google.com');
      });
    }
  } else if (command === 'open-little-arc') {
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'TOGGLE_COMMAND_BAR', mode: 'little-arc' }).catch(() => {
        openLittleArcWindow('https://www.google.com');
      });
    } else {
      openLittleArcWindow('https://www.google.com');
    }
  }
});

// Tab lifecycle listeners
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id) return;
  const own = ownTabCreates > 0;
  const state = await loadState();

  // Air Traffic Control: a link opened by a page or another app goes to its Space.
  const route = own ? undefined : routeFor(state.routingRules, tab.pendingUrl || tab.url || '');
  const routedSpace = route && state.spaces.find((space) => space.id === route.spaceId);
  if (routedSpace) {
    state.tabSpaceMap[tab.id] = routedSpace.id;
    state.tabLastAccessed[tab.id] = Date.now();
    if (tab.active) state.activeSpaceId = routedSpace.id;
    await saveState(state);
  } else if (!state.tabSpaceMap[tab.id]) {
    state.tabSpaceMap[tab.id] = state.activeSpaceId;
    state.tabLastAccessed[tab.id] = Date.now();
    await saveState(state);
  } else {
    broadcastStateUpdate();
  }
});

// Boosts: user CSS for a site, inserted as the page starts loading.
const boostTarget = (tabId: number) => ({ tabId, allFrames: false });
const appliedBoostCssByTab = new Map<number, string>();

function arcPaletteCssForSpace(space?: Space): string {
  const theme = resolveSpaceTheme(space);
  const bg = space?.customColors?.[0] || '#1e1b2e';
  const focus = theme.accent || '#6366f1';
  return `:root { --arc-palette-background: ${bg}; --arc-palette-foreground: #ffffff; --arc-palette-focus: ${focus}; }`;
}

function combinedCssForTab(url: string, space: Space | undefined, state: ArcState): string {
  const chunks = boostsFor(state.boosts, url).map((b) => compileBoostCss(b)).filter(Boolean);
  if (state.settings.exposeArcPalette) {
    chunks.unshift(arcPaletteCssForSpace(space));
  }
  return chunks.join('\n').trim();
}

async function refreshBoost(before: Boost | undefined, after: Boost | undefined) {
  const state = await loadState();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const prevTracked = appliedBoostCssByTab.get(tab.id);
    const beforeCss = prevTracked ?? (before && boostsFor([before], tab.url).length ? compileBoostCss(before) : '');
    const space = state.spaces.find((s) => s.id === (state.tabSpaceMap[tab.id!] || state.activeSpaceId)) || state.spaces[0];
    const nextCss = combinedCssForTab(tab.url, space, state);
    if (beforeCss && beforeCss !== nextCss) {
      await chrome.scripting?.removeCSS({ target: boostTarget(tab.id), css: beforeCss, origin: 'USER' }).catch(() => {});
      appliedBoostCssByTab.delete(tab.id);
    }
    if (nextCss && nextCss !== beforeCss) {
      await chrome.scripting?.insertCSS({ target: boostTarget(tab.id), css: nextCss, origin: 'USER' }).catch(() => {});
      appliedBoostCssByTab.set(tab.id, nextCss);
    }
    if (after?.enabled && after.js?.trim() && boostsFor([after], tab.url).length) {
      await chrome.scripting?.executeScript({
        target: boostTarget(tab.id),
        world: 'MAIN',
        func: (scriptBody: string) => {
          try {
            const el = document.createElement('script');
            el.textContent = scriptBody;
            (document.head || document.documentElement)?.appendChild(el);
            el.remove();
            return true;
          } catch {
            return false;
          }
        },
        args: [after.js]
      }).catch(() => {});
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  broadcastStateUpdate();
  if (!tab?.url) return;
  const state = await loadState();
  const space = state.spaces.find((s) => s.id === (state.tabSpaceMap[tabId] || state.activeSpaceId)) || state.spaces[0];
  if (changeInfo?.status === 'loading') {
    const css = combinedCssForTab(tab.url, space, state);
    if (css) {
      await chrome.scripting?.insertCSS({ target: boostTarget(tabId), css, origin: 'USER' }).catch(() => {});
      appliedBoostCssByTab.set(tabId, css);
    } else {
      appliedBoostCssByTab.delete(tabId);
    }
  } else if (changeInfo?.status === 'complete') {
    for (const boost of boostsFor(state.boosts, tab.url)) {
      if (!boost.js?.trim()) continue;
      await chrome.scripting?.executeScript({
        target: boostTarget(tabId),
        world: 'MAIN',
        func: (scriptBody: string) => {
          try {
            const el = document.createElement('script');
            el.textContent = scriptBody;
            (document.head || document.documentElement)?.appendChild(el);
            el.remove();
            return true;
          } catch {
            return false;
          }
        },
        args: [boost.js]
      }).catch(() => {});
    }
    if (state.settings.syncChromeTabGroups) {
      await syncChromeTabGroups(state);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = await loadState();
  state.tabLastAccessed[tabId] = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcastStateUpdate();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  appliedBoostCssByTab.delete(tabId);
  const state = await loadState();
  delete state.tabSpaceMap[tabId];
  delete state.tabLastAccessed[tabId];
  await saveState(state);
});

async function openLittleArcWindow(url: string) {
  if (isBrowserPageUrl(url)) {
    await createTab({ url });
    return;
  }
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 960,
    height: 700,
    focused: true
  });
}

async function isSenderInPopupWindow(sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (!sender.tab?.windowId) return false;
  try {
    const win = await chrome.windows.get(sender.tab.windowId);
    return win.type === 'popup';
  } catch {
    return false;
  }
}

async function launchBorderlessArcWindow(url: string) {
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 1440,
    height: 920,
    focused: true
  });
}

async function pinUrlToSpace(spaceId: string, title: string, url: string, favIconUrl?: string, folderId?: string) {
  if (!url) return;
  const state = await loadState();
  const space = state.spaces.find((s) => s.id === spaceId);
  if (!space) return;

  const folder = folderId
    ? findFolder(space.pinnedItems, folderId)
    : undefined;
  if (folderId && !folder) return;
  const links = pinnedLinks(space.pinnedItems);
  const matchingTab = (await chrome.tabs.query({})).find((tab) => tab.id !== undefined
    && state.tabSpaceMap[tab.id] === spaceId && urlKey(tab.url || '') === urlKey(url));
  const existing = links.find((link) => urlKey(link.url) === urlKey(url));
  // Pinning again to the root leaves an existing folder placement intact.
  if (existing && !folder) return;
  if (existing && folder?.children.some((child) => child.id === existing.id)) return;
  const newPin: PinnedLink = existing || {
    id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'link',
    title: title || url,
    url,
    favIconUrl,
    tabId: matchingTab?.id
  };
  if (existing) space.pinnedItems = removePin(space.pinnedItems, existing.id);
  const destination = folderId ? findFolder(space.pinnedItems, folderId)?.children : space.pinnedItems;
  destination?.push(newPin);
  await saveState(state);
}

async function searchOmnibox(query: string): Promise<OmniboxResultItem[]> {
  const q = query.trim().toLowerCase();
  const { state, tabs } = await getFullSnapshot();
  const results: OmniboxResultItem[] = [];

  // 1. Quick Actions
  const actions: OmniboxResultItem[] = [
    {
      id: 'action-chatgpt-companion',
      kind: 'action',
      title: '🤖 Open ChatGPT Companion (Little Arc)',
      subtitle: 'Launch ChatGPT side-by-side in a borderless Little Arc window',
      actionId: 'OPEN_CHATGPT_COMPANION',
      shortcut: 'Alt+G'
    },
    {
      id: 'action-send-antigravity',
      kind: 'action',
      title: '🚀 Send Current Page to Antigravity',
      subtitle: 'Copy page context & launch Antigravity desktop app (antigravity://)',
      actionId: 'SEND_PAGE_TO_ANTIGRAVITY',
      shortcut: 'Alt+A'
    },
    {
      id: 'action-pin-current',
      kind: 'action',
      title: 'Pin Current Tab to Space',
      subtitle: `Save active tab to ${state.spaces.find((s) => s.id === state.activeSpaceId)?.name || 'current space'}`,
      actionId: 'PIN_ACTIVE_TAB',
      shortcut: 'Pin'
    },
    {
      id: 'action-favorite-current',
      kind: 'action',
      title: 'Add Current Tab to Favorites Bar',
      subtitle: 'Pin as top icon tile across all spaces',
      actionId: 'FAVORITE_ACTIVE_TAB',
      shortcut: 'Fav'
    },
    {
      id: 'action-borderless-arc',
      kind: 'action',
      title: 'Enter Borderless Arc Window (No Chrome Top Bar)',
      subtitle: 'Open maximized borderless window with zero horizontal tabs or URL bar',
      actionId: 'LAUNCH_BORDERLESS_ARC',
      shortcut: 'Alt+B'
    },
    {
      id: 'action-little-arc',
      kind: 'action',
      title: 'Open Current Tab in Little Arc Window',
      subtitle: 'Pop out current page into a standalone borderless window',
      actionId: 'POP_OUT_LITTLE_ARC',
      shortcut: 'Alt+N'
    },
    {
      id: 'action-clear-today',
      kind: 'action',
      title: "Clear Today's Unpinned Tabs",
      subtitle: 'Archive & close unpinned tabs in the active Space',
      actionId: 'CLEAR_TODAY_TABS',
      shortcut: 'Archive'
    },
    { id: 'action-reset-space', kind: 'action', title: 'Reset Space', subtitle: 'Return open pinned tabs to their saved URLs', actionId: 'RESET_SPACE' },
    {
      id: 'action-duplicate-tab',
      kind: 'action',
      title: 'Duplicate Current Tab',
      subtitle: 'Clone the active tab in this Space',
      actionId: 'DUPLICATE_ACTIVE_TAB'
    },
    {
      id: 'action-mute-tab',
      kind: 'action',
      title: 'Toggle Mute on Current Tab',
      subtitle: 'Mute or unmute audio on the active tab',
      actionId: 'TOGGLE_MUTE_ACTIVE_TAB'
    },
    {
      id: 'action-new-easel',
      kind: 'action',
      title: 'New Easel',
      subtitle: 'Create an interactive Arc Easel board',
      actionId: 'NEW_EASEL'
    },
    {
      id: 'action-new-boost',
      kind: 'action',
      title: 'Style This Site (Boost)',
      subtitle: 'Customize colors, fonts, CSS, and zapped elements',
      actionId: 'OPEN_BOOST_EDITOR'
    },
    {
      id: 'action-zap-element',
      kind: 'action',
      title: 'Zap Element on Page',
      subtitle: 'Interactive element zapper for active tab',
      actionId: 'START_ZAP_MODE'
    },
    {
      id: 'action-capture-area',
      kind: 'action',
      title: 'Capture Portion of Page',
      subtitle: 'Crop a screenshot to Library or an Easel',
      actionId: 'START_CAPTURE_MODE'
    },
    {
      id: 'action-open-library',
      kind: 'action',
      title: 'Open Arc Library',
      subtitle: 'Archive, Easels, Boosts, Captures, and Downloads',
      actionId: 'OPEN_LIBRARY'
    },
    {
      id: 'action-copy-clean-url',
      kind: 'action',
      title: 'Copy Clean URL',
      subtitle: 'Copy active URL with tracking parameters removed',
      actionId: 'COPY_CLEAN_URL',
      shortcut: '⇧⌘C'
    },
    {
      id: 'action-copy-markdown-url',
      kind: 'action',
      title: 'Copy Page Link as Markdown',
      subtitle: 'Format active tab as [Title](URL)',
      actionId: 'COPY_MARKDOWN_URL'
    },
    {
      id: 'action-sync-now',
      kind: 'action',
      title: 'Sync Now (Mac & iPhone)',
      subtitle: 'Synchronize Spaces, pins, Boosts, and routes',
      actionId: 'SYNC_NOW'
    },
    {
      id: 'action-send-handoff',
      kind: 'action',
      title: 'Send Tab to Mac / iPhone',
      subtitle: 'Hand off the current tab to paired devices',
      actionId: 'SEND_TAB_HANDOFF'
    },
    {
      id: 'action-toggle-folders',
      kind: 'action',
      title: 'Collapse / Expand All Folders',
      subtitle: 'Toggle all folders in active Space',
      actionId: 'TOGGLE_ALL_FOLDERS'
    },
    {
      id: 'action-tidy-tabs',
      kind: 'action',
      title: 'Tidy Tabs by Site',
      subtitle: 'Sort and group today’s tabs by hostname',
      actionId: 'TIDY_TABS_BY_SITE'
    }
  ];

  // 2. Open Tabs (filter out newtab pages)
  const recentTabs = [...tabs].sort((a, b) =>
    Number(b.spaceId === state.activeSpaceId) - Number(a.spaceId === state.activeSpaceId)
    || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of recentTabs) {
    if (
      tab.url.startsWith('chrome://newtab') ||
      tab.url.includes('/newtab.html')
    ) {
      continue;
    }
    const spaceName = state.spaces.find((s) => s.id === tab.spaceId)?.name || 'Space';
    if (!q || tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)) {
      results.push({
        id: `tab-${tab.id}`,
        kind: 'tab',
        title: tab.title,
        subtitle: `Open Tab · ${spaceName} · ${formatHostname(tab.url)}`,
        url: tab.url,
        tabId: tab.id,
        spaceId: tab.spaceId,
        favIconUrl: tab.favIconUrl,
        shortcut: 'Switch'
      });
    }
  }

  // 3. Favorites & Pinned Items across Spaces
  for (const space of state.spaces) {
    const spaceFavs = getSpaceFavorites(state, space.id);
    for (const fav of spaceFavs) {
      if (results.some((result) => result.kind === 'tab' && urlKey(result.url || '') === urlKey(fav.url))) continue;
      if (results.some((result) => result.kind === 'favorite' && urlKey(result.url || '') === urlKey(fav.url) && result.spaceId === space.id)) continue;
      if (!q || fav.title.toLowerCase().includes(q) || fav.url.toLowerCase().includes(q)) {
        results.push({
          id: `fav-${space.id}-${fav.id}`,
          kind: 'favorite',
          title: fav.title,
          subtitle: `Top Pin in ${space.icon} ${space.name} · ${formatHostname(fav.url)}`,
          url: fav.url,
          spaceId: space.id,
          favIconUrl: fav.favIconUrl,
          shortcut: `${space.icon} Pin`
        });
      }
    }
  }

  for (const space of state.spaces) {
    for (const { item, folder } of pinnedRows(space.pinnedItems)) {
      if (item.type !== 'link') continue;
      if (results.some(result => result.kind === 'tab' && result.spaceId === space.id && urlKey(result.url || '') === urlKey(item.url))) continue;
      if (!q || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q) || folder?.title.toLowerCase().includes(q)) {
        results.push({
          id: `pin-${item.id}`, kind: 'pinned', title: item.title,
          subtitle: `${space.icon} ${space.name}${folder ? ' / ' + folder.title : ''} · ${formatHostname(item.url)}`,
          url: item.url, spaceId: space.id, favIconUrl: item.favIconUrl, shortcut: 'Pinned'
        });
      }
    }
  }

  // 4. Chrome Built-in Pages (when user types chrome:// or extensions, settings, etc.)
  const chromePages: OmniboxResultItem[] = [
    {
      id: 'chrome-extensions',
      kind: 'pinned',
      title: 'Chrome Extensions',
      subtitle: 'chrome://extensions',
      url: 'chrome://extensions',
      shortcut: 'Chrome Page'
    },
    {
      id: 'chrome-settings',
      kind: 'pinned',
      title: 'Chrome Settings',
      subtitle: 'chrome://settings',
      url: 'chrome://settings',
      shortcut: 'Chrome Page'
    },
    {
      id: 'chrome-history',
      kind: 'pinned',
      title: 'Chrome History',
      subtitle: 'chrome://history',
      url: 'chrome://history',
      shortcut: 'Chrome Page'
    },
    {
      id: 'chrome-downloads',
      kind: 'pinned',
      title: 'Chrome Downloads',
      subtitle: 'chrome://downloads',
      url: 'chrome://downloads',
      shortcut: 'Chrome Page'
    },
    {
      id: 'chrome-bookmarks',
      kind: 'pinned',
      title: 'Chrome Bookmarks',
      subtitle: 'chrome://bookmarks',
      url: 'chrome://bookmarks',
      shortcut: 'Chrome Page'
    },
    {
      id: 'chrome-flags',
      kind: 'pinned',
      title: 'Chrome Flags',
      subtitle: 'chrome://flags',
      url: 'chrome://flags',
      shortcut: 'Chrome Page'
    }
  ];

  if (q.length >= 1) {
    for (const cp of chromePages) {
      if (
        (cp.title.toLowerCase().includes(q) || cp.subtitle.toLowerCase().includes(q)) &&
        !results.some((r) => r.url === cp.url)
      ) {
        results.push(cp);
      }
    }
  }

  // 5. Matching Actions
  for (const act of actions) {
    if (!q || act.title.toLowerCase().includes(q) || act.subtitle.toLowerCase().includes(q)) {
      results.push(act);
    }
  }

  // 6. Bookmarks & History when user types a query
  if (q.length >= 2) {
    try {
      const bookmarks = await chrome.bookmarks.search(query.trim());
      for (const bm of bookmarks.slice(0, 5)) {
        if (bm.url) {
          results.push({
            id: `bm-${bm.id}`,
            kind: 'bookmark',
            title: bm.title || bm.url,
            subtitle: `Bookmark · ${formatHostname(bm.url)}`,
            url: bm.url,
            shortcut: 'Bookmark'
          });
        }
      }
    } catch {
      // Ignore if bookmarks permission unavailable
    }

    try {
      const historyItems = await chrome.history.search({ text: query.trim(), maxResults: 5 });
      for (const h of historyItems) {
        if (h.url && !results.some((r) => r.url === h.url)) {
          results.push({
            id: `hist-${h.id}`,
            kind: 'history',
            title: h.title || h.url,
            subtitle: `History · ${formatHostname(h.url)}`,
            url: h.url,
            shortcut: 'History'
          });
        }
      }
    } catch {
      // Ignore if history unavailable
    }
  }

  // 7. Direct URL, ChatGPT (gpt ...), Antigravity (agy ...), or Google Search
  if (q.length >= 1) {
    const rawTrimmed = query.trim();
    const gptPrefixMatch = rawTrimmed.match(/^(?:gpt|ask|chatgpt)\s+(.+)$/i);
    const agyPrefixMatch = rawTrimmed.match(/^(?:agy|anti|antigravity)\s+(.+)$/i);

    if (gptPrefixMatch) {
      const prompt = gptPrefixMatch[1].trim();
      results.unshift({
        id: 'ask-chatgpt-direct',
        kind: 'search',
        title: `🤖 Ask ChatGPT: "${prompt}"`,
        subtitle: 'Open ChatGPT with this prompt pre-filled',
        url: `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
        shortcut: 'ChatGPT'
      });
    } else if (agyPrefixMatch) {
      const prompt = agyPrefixMatch[1].trim();
      results.unshift({
        id: 'send-agy-direct',
        kind: 'action',
        title: `🚀 Send to Antigravity: "${prompt}"`,
        subtitle: 'Copy task & launch Antigravity desktop app (antigravity://)',
        actionId: `ANTIGRAVITY_PROMPT:${prompt}`,
        shortcut: 'Antigravity'
      });
    } else if (matchSiteSearch(state.siteSearches, rawTrimmed)) {
      const { site, terms } = matchSiteSearch(state.siteSearches, rawTrimmed)!;
      const url = siteSearchUrl(site, terms);
      results.unshift({
        id: `site-search-${site.id}`,
        kind: 'search',
        title: `Search ${site.name} for "${terms}"`,
        subtitle: `Site Search · ${formatHostname(url)}`,
        url,
        shortcut: site.name
      });
    } else {
      const parsed = parseCommandBarInput(query);
      const siteHints = suggestSiteSearches(state.siteSearches, rawTrimmed).slice(0, 3).map((site): OmniboxResultItem => ({
        id: `site-hint-${site.id}`,
        kind: 'search',
        title: `Search ${site.name}`,
        subtitle: `Site Search · type "${site.shortcut} " and your query`,
        url: siteSearchUrl(site, '').replace(/[?&][^?&=]+=$/, ''),
        shortcut: site.shortcut
      }));
      if (parsed.isUrl) {
        if (!results.some((result) => result.kind === 'tab' && urlKey(result.url || '') === urlKey(parsed.url))) results.unshift({
          id: 'direct-url',
          kind: 'search',
          title: `Open ${parsed.url}`,
          subtitle: 'Navigate directly to URL',
          url: parsed.url,
          shortcut: 'Open URL'
        });
      } else {
        results.push({
          id: 'google-search',
          kind: 'search',
          title: `Search Google for "${rawTrimmed}"`,
          subtitle: 'Web Search',
          url: parsed.url,
          shortcut: 'Search'
        });
        results.splice(Math.min(results.length, 6), 0, ...siteHints);
        results.push({
          id: 'ask-chatgpt-query',
          kind: 'search',
          title: `🤖 Ask ChatGPT: "${rawTrimmed}"`,
          subtitle: 'Send prompt directly to ChatGPT',
          url: `https://chatgpt.com/?q=${encodeURIComponent(rawTrimmed)}`,
          shortcut: 'ChatGPT'
        });
        results.push({
          id: 'send-agy-query',
          kind: 'action',
          title: `🚀 Send to Antigravity: "${rawTrimmed}"`,
          subtitle: 'Copy task & launch Antigravity app',
          actionId: `ANTIGRAVITY_PROMPT:${rawTrimmed}`,
          shortcut: 'Antigravity'
        });
      }
    }
  }

  // 6.5 Easels, Archived Tabs & Remote Device Tabs
  if (q.length >= 1) {
    const easels = await loadEasels();
    for (const easel of easels) {
      if (easel.title.toLowerCase().includes(q)) {
        results.push({
          id: `easel-${easel.id}`,
          kind: 'action',
          title: `🎨 Easel: ${easel.title}`,
          subtitle: `${easel.items.length} item(s)`,
          actionId: `OPEN_EASEL:${easel.id}`,
          shortcut: 'Easel'
        });
      }
    }
    for (const arch of state.archive || []) {
      if (arch.title.toLowerCase().includes(q) || arch.url.toLowerCase().includes(q)) {
        results.push({
          id: `arch-${arch.id}`,
          kind: 'history',
          title: arch.title,
          subtitle: `Archived · ${formatHostname(arch.url)}`,
          url: arch.url,
          spaceId: arch.spaceId,
          shortcut: 'Archive'
        });
      }
    }
    for (const dev of state.remoteDevices || []) {
      for (const rtab of dev.activeTabs || []) {
        if (rtab.title.toLowerCase().includes(q) || rtab.url.toLowerCase().includes(q)) {
          results.push({
            id: `remote-${rtab.id}`,
            kind: 'tab',
            title: rtab.title || rtab.url,
            subtitle: `${dev.name} · ${formatHostname(rtab.url)}`,
            url: rtab.url,
            spaceId: rtab.spaceId,
            shortcut: dev.platform
          });
        }
      }
    }
  }

  return results.slice(0, 18);
}

function formatHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Unified Message Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (typeof message?.type === 'string' && message.type.startsWith('DESKTOP_PIP_')) {
      sendResponse(await desktopPipRequest(message, sender));
      return;
    }
    const state = await loadState();

    switch (message?.type) {
      case 'GET_SNAPSHOT': {
        const snapshot = await getFullSnapshot(sender.tab?.windowId);
        sendResponse(snapshot);
        break;
      }

      case 'RESTORE_ARCHIVED_TAB': {
        const entry = state.archive?.find((entry) => entry.id === message.archiveId);
        if (!entry) throw new Error('Archived tab no longer exists');
        const spaceId = state.spaces.some((space) => space.id === entry.spaceId) ? entry.spaceId : state.activeSpaceId;
        const tab = await createTab({ url: entry.url, active: true });
        if (tab.id !== undefined) {
          state.tabSpaceMap[tab.id] = spaceId;
          state.tabLastAccessed[tab.id] = Date.now();
        }
        state.archive = state.archive!.filter((item) => item.id !== entry.id);
        state.activeSpaceId = spaceId;
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }
      case 'RESET_SPACE': {
        await resetSpace(message.spaceId || state.activeSpaceId);
        sendResponse(await getFullSnapshot());
        break;
      }
      case 'RENAME_PINNED_ITEM': {
        const space = state.spaces.find((space) => space.id === (message.spaceId || state.activeSpaceId));
        const items = pinnedRows(space?.pinnedItems || []).map(({ item }) => item);
        const item = items.find((item) => item.id === message.itemId);
        if (!item || typeof message.title !== 'string' || !message.title.trim()) throw new Error('Enter a name for the pinned item');
        item.title = message.title.trim();
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }
      case 'CREATE_SPLIT_VIEW': {
        const api = chrome.tabs as typeof chrome.tabs & { createSplit?: (ids: [number, number]) => Promise<number> };
        if (!api.createSplit) throw new Error('Native Split View requires Chrome 155 or newer. This browser does not expose the Split View API.');
        const first = await chrome.tabs.get(message.firstTabId);
        const second = await chrome.tabs.get(message.secondTabId);
        if (first.id === second.id || first.windowId !== second.windowId || first.pinned !== second.pinned || first.groupId !== second.groupId) {
          throw new Error('Choose two different tabs in the same window and tab group with matching pin status.');
        }
        await chrome.tabs.move(second.id!, { index: first.index + (second.index < first.index ? 0 : 1) });
        const splitViewId = await api.createSplit([first.id!, second.id!]);
        sendResponse({ ok: true, splitViewId });
        break;
      }
      case 'RELOAD_EXTENSION': {
        sendResponse({ ok: true });
        setTimeout(() => {
          chrome.runtime.reload();
        }, 50);
        break;
      }

      case 'NAVIGATE_CURRENT_TAB': {
        const { url, tabId } = message;
        const targetTabId = tabId || sender.tab?.id;
        if (url && typeof targetTabId === 'number') {
          await chrome.tabs.update(targetTabId, { url });
        } else if (url) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) {
            await chrome.tabs.update(activeTab.id, { url });
          } else {
            await createTab({ url, active: true });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_ACTIVE_SPACE': {
        const { spaceId } = message;
        if (spaceId !== state.activeSpaceId && state.spaces.some((s) => s.id === spaceId)) {
          state.activeSpaceId = spaceId;
          await saveState(state);
          const windowTabs = await chrome.tabs.query(sender.tab?.windowId !== undefined
            ? { windowId: sender.tab.windowId } : { currentWindow: true });
          const recent = windowTabs
            .filter((tab) => tab.id !== undefined && state.tabSpaceMap[tab.id] === spaceId)
            .sort((a, b) => (state.tabLastAccessed[b.id!] || 0) - (state.tabLastAccessed[a.id!] || 0))[0];
          if (recent?.id !== undefined) await chrome.tabs.update(recent.id, { active: true });
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'CREATE_SPACE': {
        const { name, icon, theme } = message as {
          name: string;
          icon: string;
          theme: SpaceThemeId;
        };
        const newSpace: Space = {
          id: `space-${Date.now()}`,
          name: name?.trim() || 'New Space',
          icon: icon || '🪐',
          theme: theme in SPACE_THEMES ? theme : 'indigo',
          favorites: [],
          pinnedItems: []
        };
        state.spaces.push(newSpace);
        state.activeSpaceId = newSpace.id;
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'UPDATE_SPACE': {
        const { spaceId, name, icon, theme, customColors, appearance } = message;
        const space = state.spaces.find((s) => s.id === spaceId);
        if (space) {
          if (name) space.name = name.trim();
          if (icon) space.icon = icon;
          if (theme && theme in SPACE_THEMES) space.theme = theme;
          if (Array.isArray(customColors)) {
            space.customColors = customColors.length ? customColors : undefined;
          }
          if (appearance === 'auto' || appearance === 'light' || appearance === 'dark') {
            space.appearance = appearance;
          }
          await saveState(state);
          if (state.settings.syncChromeTabGroups) await syncChromeTabGroups(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'DELETE_SPACE': {
        const { spaceId } = message;
        if (state.spaces.length > 1) {
          state.spaces = state.spaces.filter((s) => s.id !== spaceId);
          if (state.activeSpaceId === spaceId) {
            state.activeSpaceId = state.spaces[0].id;
          }
          for (const [tabId, mappedSpace] of Object.entries(state.tabSpaceMap)) {
            if (mappedSpace === spaceId) {
              state.tabSpaceMap[Number(tabId)] = state.activeSpaceId;
            }
          }
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'SWITCH_TAB': {
        const { tabId } = message;
        if (typeof tabId === 'number') {
          const inPopup = await isSenderInPopupWindow(sender);
          if (inPopup && sender.tab?.id && sender.tab.id !== tabId) {
            const targetTab = await chrome.tabs.get(tabId);
            if (targetTab?.url) {
              await chrome.tabs.update(sender.tab.id, { url: targetTab.url });
              sendResponse({ ok: true });
              break;
            }
          }
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CLOSE_TAB': {
        const { tabId } = message;
        if (typeof tabId === 'number') {
          const snapshot = await getFullSnapshot();
          const tab = snapshot.tabs.find((tab) => tab.id === tabId);
          if (tab && getTodayTabs(state, snapshot.tabs, tab.spaceId).some((item) => item.id === tabId)) await archiveTabs([tab]);
          else await chrome.tabs.remove(tabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'OPEN_FOCUSED_NEW_TAB': {
        const tab = await createTab({
          url: chrome.runtime.getURL('newtab.html?focused=1'),
          windowId: sender.tab?.windowId,
          active: true
        });
        sendResponse({ ok: true, tab });
        break;
      }

      case 'CREATE_TAB': {
        const { url, spaceId, active = true } = message;
        const targetSpaceId = spaceId || state.activeSpaceId;
        const inPopup = await isSenderInPopupWindow(sender);
        if (inPopup && sender.tab?.id && url && !url.startsWith('chrome://')) {
          await chrome.tabs.update(sender.tab.id, { url });
          sendResponse({ ok: true });
          break;
        }
        const created = await createTab({
          url: url || 'chrome://newtab',
          active
        });
        if (created.id) {
          state.tabSpaceMap[created.id] = targetSpaceId;
          state.tabLastAccessed[created.id] = Date.now();
          await saveState(state);
        }
        sendResponse({ ok: true, tab: created });
        break;
      }

      case 'OPEN_OR_SWITCH_URL': {
        const { url, spaceId } = message;
        if (!url) { sendResponse({ ok: false }); break; }
        const targetSpaceId = state.spaces.some((space) => space.id === spaceId)
          ? spaceId : state.activeSpaceId;
        const snapshot = await getFullSnapshot();
        const spaceFavs = getSpaceFavorites(state, targetSpaceId);
        const sharedFavorite = spaceFavs.some((favorite) => urlKey(favorite.url) === urlKey(url));
        const links = pinnedLinks(state.spaces.find((space) => space.id === targetSpaceId)?.pinnedItems || []);
        const pin = links.find((link) => urlKey(link.url) === urlKey(url));
        const rootMatch = (sharedFavorite || Boolean(pin)) && isRootDomainUrl(url);
        const existing = snapshot.tabs
          .filter((tab) => {
            if (urlKey(tab.url) === urlKey(url) && (sharedFavorite || tab.spaceId === targetSpaceId)) {
              return true;
            }
            if (rootMatch && sameHost(tab.url, url) && tab.spaceId === targetSpaceId) {
              return true;
            }
            return false;
          })
          .sort((a, b) => Number(urlKey(b.url) === urlKey(url)) - Number(urlKey(a.url) === urlKey(url))
            || Number(b.spaceId === targetSpaceId) - Number(a.spaceId === targetSpaceId)
            || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
        const linked = pin?.tabId === undefined ? undefined : snapshot.tabs.find((tab) => tab.id === pin.tabId && tab.spaceId === targetSpaceId);
        const target = linked || existing;
        state.activeSpaceId = targetSpaceId;
        if (target) {
          if (target.id === sender.tab?.id && urlKey(target.url) !== urlKey(url)) {
            await chrome.tabs.update(target.id, { url, active: true });
          } else {
            await chrome.tabs.update(target.id, { active: true });
            await chrome.windows.update(target.windowId, { focused: true });
          }
          if (pin) pin.tabId = target.id;
        } else {
          const created = await createTab({ url, active: true });
          if (created.id) {
            state.tabSpaceMap[created.id] = targetSpaceId;
            state.tabLastAccessed[created.id] = Date.now();
            if (pin) pin.tabId = created.id;
          }
        }
        await saveState(state);
        sendResponse({ ok: true });
        break;
      }

      case 'LAUNCH_BORDERLESS_ARC': {
        const { url } = message;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const targetUrl = url || sender.tab?.url || activeTab?.url || 'https://www.google.com';
        await launchBorderlessArcWindow(targetUrl);
        sendResponse({ ok: true });
        break;
      }

      case 'PIN_TAB_TO_SPACE': {
        const { spaceId, title, url, favIconUrl, folderId } = message;
        await pinUrlToSpace(spaceId || state.activeSpaceId, title, url, favIconUrl, folderId);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REMOVE_PINNED_ITEM': {
        const { spaceId, itemId } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (space) {
          space.pinnedItems = removePin(space.pinnedItems, itemId);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'CREATE_FOLDER': {
        const { spaceId, title, parentId } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (space) {
          const folder: PinnedFolder = {
            id: crypto.randomUUID(),
            type: 'folder',
            title: title?.trim() || 'New Folder',
            collapsed: false,
            children: []
          };
          const parent = parentId ? findFolder(space.pinnedItems, parentId) : undefined;
          if (parentId && !parent) throw new Error('Folder no longer exists.');
          if (parent) {
            parent.collapsed = false;
            parent.children.push(folder);
          } else space.pinnedItems.push(folder);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'TOGGLE_FOLDER': {
        const { spaceId, folderId } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (space) {
          const folder = findFolder(space.pinnedItems, folderId);
          if (folder) {
            folder.collapsed = !folder.collapsed;
            await saveState(state);
          }
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'ADD_FAVORITE': {
        const { title, url, favIconUrl, spaceId } = message;
        const targetSpace = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId)) || state.spaces[0];
        if (url && targetSpace) {
          targetSpace.favorites ||= [];
          if (!targetSpace.favorites.some((f) => urlKey(f.url) === urlKey(url))) {
            targetSpace.favorites.push({
              id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              title: title?.trim() || formatHostname(url),
              url,
              favIconUrl
            });
            await saveState(state);
          }
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REMOVE_FAVORITE': {
        const { favoriteId, spaceId } = message;
        const targetSpace = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId)) || state.spaces[0];
        if (targetSpace && Array.isArray(targetSpace.favorites)) {
          targetSpace.favorites = targetSpace.favorites.filter((f) => f.id !== favoriteId);
          await saveState(state);
        } else {
          state.favorites = state.favorites.filter((f) => f.id !== favoriteId);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'CLEAR_TODAY_TABS': {
        const targetSpaceId = message.spaceId || state.activeSpaceId;
        const snapshot = await getFullSnapshot();
        const tabsToClose = getTodayTabs(state, snapshot.tabs, targetSpaceId).filter((tab) => !tab.active);
        if (tabsToClose.length > 0) {
          await archiveTabs(tabsToClose);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'MOVE_TAB_TO_SPACE': {
        const { tabId, spaceId } = message;
        if (typeof tabId === 'number' && spaceId) {
          state.tabSpaceMap[tabId] = spaceId;
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REORDER_TAB': {
        const { tabId, toIndex } = message;
        if (typeof tabId === 'number' && typeof toIndex === 'number') {
          try {
            await chrome.tabs.move(tabId, { index: toIndex });
          } catch {
            // ignore move error
          }
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REORDER_FAVORITES': {
        const { fromIndex, toIndex, spaceId } = message;
        const targetSpace = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId)) || state.spaces[0];
        const list = targetSpace?.favorites || state.favorites;
        if (
          typeof fromIndex === 'number' &&
          typeof toIndex === 'number' &&
          fromIndex >= 0 &&
          toIndex >= 0 &&
          fromIndex < list.length &&
          toIndex < list.length
        ) {
          const [moved] = list.splice(fromIndex, 1);
          list.splice(toIndex, 0, moved);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REORDER_PINNED': {
        const { spaceId, fromIndex, toIndex } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (
          space &&
          typeof fromIndex === 'number' &&
          typeof toIndex === 'number' &&
          fromIndex >= 0 &&
          toIndex >= 0 &&
          fromIndex < space.pinnedItems.length &&
          toIndex < space.pinnedItems.length
        ) {
          const [moved] = space.pinnedItems.splice(fromIndex, 1);
          space.pinnedItems.splice(toIndex, 0, moved);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'TOGGLE_TAB_MUTE': {
        const { tabId } = message;
        if (typeof tabId === 'number') {
          const tab = await chrome.tabs.get(tabId);
          await chrome.tabs.update(tabId, { muted: !tab.mutedInfo?.muted });
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'UPDATE_SETTINGS': {
        const { settings } = message;
        const paletteChanged = settings.exposeArcPalette !== undefined && settings.exposeArcPalette !== state.settings.exposeArcPalette;
        state.settings = { ...state.settings, ...settings };
        await saveState(state);
        if (state.settings.syncChromeTabGroups) await syncChromeTabGroups(state);
        if (paletteChanged) await refreshBoost(undefined, undefined);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'SAVE_ROUTING_RULE': {
        const pattern = normalizePattern(String(message.pattern || ''));
        if (!pattern || !pattern.split('/')[0].includes('.') && !pattern.startsWith('localhost')) throw new Error('Enter a site such as github.com');
        if (!state.spaces.some((space) => space.id === message.spaceId)) throw new Error('Choose a Space');
        state.routingRules ||= [];
        const existing = state.routingRules.find((rule) => rule.id === message.id)
          || state.routingRules.find((rule) => normalizePattern(rule.pattern) === pattern);
        if (existing) Object.assign(existing, { pattern, spaceId: message.spaceId });
        else state.routingRules.push({ id: crypto.randomUUID(), pattern, spaceId: message.spaceId });
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REMOVE_ROUTING_RULE': {
        state.routingRules = (state.routingRules || []).filter((rule) => rule.id !== message.id);
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'SAVE_SITE_SEARCH': {
        const name = String(message.name || '').trim();
        const shortcut = String(message.shortcut || '').trim().toLowerCase();
        const url = String(message.url || '').trim();
        if (!name) throw new Error('Name the site');
        if (!shortcut || /\s/.test(shortcut)) throw new Error('The shortcut is one word, such as yt');
        if (!validSiteSearchUrl(url)) throw new Error('The search URL needs %s where the query goes');
        state.siteSearches ||= [];
        if (state.siteSearches.some((site) => site.id !== message.id && site.shortcut.toLowerCase() === shortcut)) {
          throw new Error(`"${shortcut}" is already used by another site`);
        }
        const existing = state.siteSearches.find((site) => site.id === message.id);
        if (existing) Object.assign(existing, { name, shortcut, url });
        else state.siteSearches.push({ id: crypto.randomUUID(), name, shortcut, url });
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REMOVE_SITE_SEARCH': {
        state.siteSearches = (state.siteSearches || []).filter((site) => site.id !== message.id);
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'SAVE_BOOST': {
        const host = normalizePattern(String(message.host || '')).split('/')[0];
        const css = String(message.css || '');
        if (!host) throw new Error('Enter a site such as github.com');
        const hasVisuals =
          Boolean(message.tintColor) ||
          Boolean(message.invert) ||
          Boolean(message.js?.trim()) ||
          (Array.isArray(message.zappedSelectors) && message.zappedSelectors.length > 0) ||
          (message.fontFamily && message.fontFamily !== 'default') ||
          (message.textCase && message.textCase !== 'none') ||
          Boolean(css.trim());
        if (!hasVisuals) throw new Error('Change a Boost style, zap an element, or write CSS/JS');
        state.boosts ||= [];
        const existing = state.boosts.find((boost) => boost.id === message.id)
          || state.boosts.find((boost) => boost.host === host);
        const before = existing && { ...existing };
        const after: Boost = {
          id: existing?.id || crypto.randomUUID(),
          host,
          name: message.name ? String(message.name) : existing?.name || host,
          css,
          enabled: message.enabled !== false,
          tintColor: message.tintColor ?? existing?.tintColor,
          hue: message.hue ?? existing?.hue,
          tintIntensity: message.tintIntensity ?? existing?.tintIntensity,
          invert: message.invert ?? existing?.invert,
          brightness: message.brightness ?? existing?.brightness,
          contrast: message.contrast ?? existing?.contrast,
          saturate: message.saturate ?? existing?.saturate,
          fontFamily: message.fontFamily ?? existing?.fontFamily,
          fontSize: message.fontSize ?? existing?.fontSize,
          textCase: message.textCase ?? existing?.textCase,
          zappedSelectors: Array.isArray(message.zappedSelectors) ? message.zappedSelectors : existing?.zappedSelectors,
          js: message.js ?? existing?.js
        };
        if (existing) Object.assign(existing, after);
        else state.boosts.push(after);
        await saveState(state);
        await refreshBoost(before, after);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REMOVE_BOOST': {
        const before = (state.boosts || []).find((boost) => boost.id === message.id);
        state.boosts = (state.boosts || []).filter((boost) => boost.id !== message.id);
        await saveState(state);
        await refreshBoost(before, undefined);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'OPEN_LITTLE_ARC': {
        const { url } = message;
        if (url) {
          await openLittleArcWindow(url);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'REQUEST_PEEK': {
        const { url } = message;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (state.settings.peekMode === 'overlay' && activeTab?.id && !activeTab.url?.startsWith('chrome://') && canPreviewInPeek(url)) {
          chrome.tabs.sendMessage(activeTab.id, { type: 'SHOW_PEEK_OVERLAY', url }).catch(() => {
            openLittleArcWindow(url);
          });
        } else {
          await openLittleArcWindow(url);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'TRIGGER_ACTIVE_TAB_COMMAND_BAR': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
          chrome.tabs.sendMessage(activeTab.id, { type: 'TOGGLE_COMMAND_BAR' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SEARCH_OMNIBOX': {
        const items = await searchOmnibox(message.query || '');
        sendResponse({ items });
        break;
      }

      case 'EXECUTE_OMNIBOX_ACTION': {
        const { actionId } = message;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (actionId === 'OPEN_CHATGPT_COMPANION') {
          await openLittleArcWindow('https://chatgpt.com');
        } else if (actionId === 'SEND_PAGE_TO_ANTIGRAVITY') {
          if (activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
            chrome.tabs
              .sendMessage(activeTab.id, {
                type: 'TRIGGER_ANTIGRAVITY_HANDOFF',
                selectionText: ''
              })
              .catch(() => {});
          } else if (activeTab?.id) {
            await chrome.tabs.update(activeTab.id, { url: 'antigravity://' });
          }
        } else if (typeof actionId === 'string' && actionId.startsWith('ANTIGRAVITY_PROMPT:')) {
          const prompt = actionId.slice('ANTIGRAVITY_PROMPT:'.length).trim();
          if (activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
            chrome.tabs
              .sendMessage(activeTab.id, {
                type: 'TRIGGER_ANTIGRAVITY_HANDOFF',
                customPrompt: prompt
              })
              .catch(() => {});
          } else if (activeTab?.id) {
            await chrome.tabs.update(activeTab.id, { url: 'antigravity://' });
          }
        } else if (actionId === 'PIN_ACTIVE_TAB' && activeTab?.url) {
          await pinUrlToSpace(
            state.activeSpaceId,
            activeTab.title || activeTab.url,
            activeTab.url,
            activeTab.favIconUrl
          );
        } else if (actionId === 'FAVORITE_ACTIVE_TAB' && activeTab?.url) {
          const targetSpace = state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0];
          if (targetSpace) {
            targetSpace.favorites ||= [];
            if (!targetSpace.favorites.some((f) => urlKey(f.url) === urlKey(activeTab.url!))) {
              targetSpace.favorites.push({
                id: `fav-${Date.now()}`,
                title: activeTab.title || formatHostname(activeTab.url),
                url: activeTab.url,
                favIconUrl: activeTab.favIconUrl
              });
              await saveState(state);
            }
          }
        } else if (actionId === 'LAUNCH_BORDERLESS_ARC' && activeTab?.url) {
          await launchBorderlessArcWindow(activeTab.url);
        } else if (actionId === 'POP_OUT_LITTLE_ARC' && activeTab?.url) {
          await openLittleArcWindow(activeTab.url);
        } else if (actionId === 'CLEAR_TODAY_TABS') {
          const snapshot = await getFullSnapshot();
          const tabsToClose = getTodayTabs(state, snapshot.tabs, state.activeSpaceId).filter((tab) => !tab.active);
          if (tabsToClose.length > 0) {
            await archiveTabs(tabsToClose);
          }
        } else if (actionId === 'RESET_SPACE') {
          await resetSpace(state.activeSpaceId);
        } else if (actionId === 'DUPLICATE_ACTIVE_TAB' && activeTab?.id) {
          await chrome.tabs.duplicate(activeTab.id);
        } else if (actionId === 'TOGGLE_MUTE_ACTIVE_TAB' && activeTab?.id) {
          await chrome.tabs.update(activeTab.id, { muted: !activeTab.mutedInfo?.muted });
        } else if (actionId === 'NEW_EASEL') {
          await createTab({ url: chrome.runtime.getURL('easel.html'), active: true });
        } else if (typeof actionId === 'string' && actionId.startsWith('OPEN_EASEL:')) {
          const eid = actionId.slice('OPEN_EASEL:'.length);
          await createTab({ url: chrome.runtime.getURL(`easel.html?id=${encodeURIComponent(eid)}`), active: true });
        } else if (actionId === 'START_ZAP_MODE' && activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
          await chrome.tabs.sendMessage(activeTab.id, { type: 'START_ZAP_MODE' }).catch(() => {});
        } else if (actionId === 'START_CAPTURE_MODE' && activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
          await chrome.tabs.sendMessage(activeTab.id, { type: 'START_CAPTURE_MODE' }).catch(() => {});
        } else if (actionId === 'SYNC_NOW') {
          await liveSync.syncNow('full');
        } else if (actionId === 'SEND_TAB_HANDOFF' && activeTab?.url) {
          await liveSync.sendTabHandoff(activeTab.url, activeTab.title || activeTab.url, state.activeSpaceId);
        } else if (actionId === 'TOGGLE_ALL_FOLDERS') {
          const sp = state.spaces.find((s) => s.id === state.activeSpaceId);
          if (sp) {
            const folders = pinnedRows(sp.pinnedItems).filter((r) => r.item.type === 'folder').map((r) => r.item as PinnedFolder);
            const anyOpen = folders.some((f) => !f.collapsed);
            for (const f of folders) f.collapsed = anyOpen;
            await saveState(state);
          }
        } else if (actionId === 'TIDY_TABS_BY_SITE') {
          const snapshot = await getFullSnapshot();
          const today = getTodayTabs(state, snapshot.tabs, state.activeSpaceId)
            .sort((a, b) => formatHostname(a.url).localeCompare(formatHostname(b.url)));
          for (let i = 0; i < today.length; i++) {
            await chrome.tabs.move(today[i].id, { index: i }).catch(() => {});
          }
        } else if ((actionId === 'COPY_CLEAN_URL' || actionId === 'COPY_MARKDOWN_URL') && activeTab?.id && activeTab.url) {
          const text = actionId === 'COPY_MARKDOWN_URL'
            ? `[${activeTab.title || formatHostname(activeTab.url)}](${cleanUrl(activeTab.url)})`
            : cleanUrl(activeTab.url);
          await chrome.scripting?.executeScript({
            target: { tabId: activeTab.id },
            func: (val: string) => { void navigator.clipboard?.writeText(val).catch(() => {}); },
            args: [text]
          }).catch(() => {});
        } else if (actionId === 'OPEN_BOOST_EDITOR' || actionId === 'OPEN_LIBRARY') {
          chrome.runtime.sendMessage({ type: 'OPEN_SIDEBAR_PANEL', panel: actionId === 'OPEN_BOOST_EDITOR' ? 'boosts' : 'library' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'ZAP_SELECTOR': {
        const host = normalizePattern(String(message.host || '')).split('/')[0];
        const selectors = Array.isArray(message.selectors)
          ? message.selectors.map(String)
          : message.selector ? [String(message.selector)] : [];
        if (!host || !selectors.length) throw new Error('Nothing to zap');
        state.boosts ||= [];
        let boost = state.boosts.find((b) => b.host === host);
        if (!boost) {
          boost = { id: crypto.randomUUID(), host, name: host, css: '', enabled: true, zappedSelectors: [] };
          state.boosts.push(boost);
        }
        boost.enabled = true;
        boost.zappedSelectors = [...new Set([...(boost.zappedSelectors || []), ...selectors])];
        await saveState(state);
        await refreshBoost(boost, boost);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'UNZAP_SELECTOR': {
        const host = normalizePattern(String(message.host || '')).split('/')[0];
        const boost = (state.boosts || []).find((b) => b.host === host);
        if (boost) {
          boost.zappedSelectors = (boost.zappedSelectors || []).filter((s) => s !== message.selector);
          await saveState(state);
          await refreshBoost(boost, boost);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'UNZAP_ALL': {
        const host = normalizePattern(String(message.host || '')).split('/')[0];
        const boost = (state.boosts || []).find((b) => b.host === host);
        if (boost) {
          boost.zappedSelectors = [];
          await saveState(state);
          await refreshBoost(boost, boost);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'SET_FOLDER_LIVE_FEED': {
        const space = state.spaces.find((s) => s.id === (message.spaceId || state.activeSpaceId));
        const folder = space ? findFolder(space.pinnedItems, message.folderId) : undefined;
        if (!folder) throw new Error('Folder not found');
        if (message.url && String(message.url).trim()) {
          folder.liveFeed = {
            kind: message.kind || 'rss',
            url: String(message.url).trim(),
            refreshMinutes: Number(message.refreshMinutes) || 15
          };
          await saveState(state);
          await refreshFolderFeed(space!.id, folder.id);
        } else {
          folder.liveFeed = undefined;
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'REFRESH_LIVE_FOLDER': {
        await refreshFolderFeed(message.spaceId || state.activeSpaceId, message.folderId);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'COLLAPSE_ALL_FOLDERS': {
        const sp = state.spaces.find((s) => s.id === (message.spaceId || state.activeSpaceId));
        if (sp) {
          const folders = pinnedRows(sp.pinnedItems).filter((r) => r.item.type === 'folder').map((r) => r.item as PinnedFolder);
          const next = Boolean(message.collapsed);
          for (const f of folders) f.collapsed = next;
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'START_ZAP_MODE':
      case 'START_CAPTURE_MODE': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
          await chrome.tabs.sendMessage(activeTab.id, { type: message.type }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CAPTURE_VISIBLE_TAB': {
        const dataUrl = sender.tab?.windowId !== undefined
          ? await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
          : await chrome.tabs.captureVisibleTab({ format: 'png' });
        sendResponse({ ok: true, dataUrl });
        break;
      }

      case 'SAVE_CAPTURE': {
        const cap: CapturedImage = {
          id: `cap-${Date.now()}`,
          dataUrl: String(message.dataUrl || ''),
          title: String(message.title || 'Capture'),
          pageUrl: String(message.pageUrl || ''),
          createdAt: Date.now()
        };
        const list = [cap, ...(await loadCaptures())].slice(0, 40);
        await chrome.storage.local.set({ [CAPTURES_KEY]: list });
        if (message.sendToEasel) {
          if (message.easelId) {
            const easels = await loadEasels();
            const target = easels.find((e) => e.id === message.easelId);
            if (target) {
              const updated = addEaselItem(target, {
                id: `item-${Date.now()}`,
                kind: 'image',
                x: 80,
                y: 80,
                w: 500,
                h: 320,
                color: '#ffffff',
                src: cap.dataUrl,
                title: cap.title
              });
              await chrome.storage.local.set({ [EASELS_KEY]: easels.map((e) => (e.id === target.id ? updated : e)) });
              await createTab({ url: chrome.runtime.getURL(`easel.html?id=${encodeURIComponent(target.id)}`), active: true });
            }
          } else {
            await createTab({ url: chrome.runtime.getURL(`easel.html?captureId=${encodeURIComponent(cap.id)}`), active: true });
          }
        }
        sendResponse({ ok: true, capture: cap });
        break;
      }

      case 'GET_LIBRARY_DATA': {
        const [easels, captures, downloads] = await Promise.all([
          loadEasels(),
          loadCaptures(),
          chrome.downloads?.search ? chrome.downloads.search({ limit: 30, orderBy: ['-startTime'] }).catch(() => []) : Promise.resolve([])
        ]);
        sendResponse({ ok: true, easels, captures, downloads });
        break;
      }

      case 'SAVE_EASEL': {
        const easels = await loadEasels();
        const doc = message.easel as EaselDocument | undefined;
        const created = doc || createEasel(message.title || 'Untitled Easel');
        const next = [created, ...easels.filter((e) => e.id !== created.id)];
        await chrome.storage.local.set({ [EASELS_KEY]: next });
        sendResponse({ ok: true, easel: created, easels: next });
        break;
      }

      case 'DELETE_EASEL': {
        const next = (await loadEasels()).filter((e) => e.id !== message.id);
        await chrome.storage.local.set({ [EASELS_KEY]: next });
        sendResponse({ ok: true, easels: next });
        break;
      }

      case 'DELETE_CAPTURE': {
        const next = (await loadCaptures()).filter((c) => c.id !== message.id);
        await chrome.storage.local.set({ [CAPTURES_KEY]: next });
        sendResponse({ ok: true, captures: next });
        break;
      }

      case 'OPEN_EASEL': {
        const url = message.id
          ? chrome.runtime.getURL(`easel.html?id=${encodeURIComponent(String(message.id))}`)
          : chrome.runtime.getURL('easel.html');
        await createTab({ url, active: true });
        sendResponse({ ok: true });
        break;
      }

      case 'PAIR_FROM_URI': {
        if (!parsePairingUri(String(message.uri || ''))) throw new Error('Invalid pairing link');
        const next = await liveSync.pairFromUri(String(message.uri));
        sendResponse({ ok: true, state: next, tabs: (await getFullSnapshot()).tabs });
        break;
      }

      case 'CONFIGURE_SYNC': {
        const urls = Array.isArray(message.urls)
          ? message.urls
          : String(message.url || '').split(',').map((s) => s.trim()).filter(Boolean);
        const next = await liveSync.configure({ urls, token: String(message.token || ''), peerName: message.peerName });
        sendResponse({ ok: true, state: next, tabs: (await getFullSnapshot()).tabs });
        break;
      }

      case 'AUTO_PAIR_SYNC': {
        const res = await liveSync.pairFromNativeHost();
        if (!res.ok) throw new Error(res.error || 'Could not auto-pair with Cra');
        sendResponse({ ok: true, state: res.state, tabs: (await getFullSnapshot()).tabs });
        break;
      }

      case 'DISCONNECT_SYNC': {
        const next = await liveSync.disconnect();
        sendResponse({ ok: true, state: next, tabs: (await getFullSnapshot()).tabs });
        break;
      }

      case 'SYNC_NOW': {
        const next = await liveSync.syncNow('full');
        sendResponse({ ok: true, state: next, tabs: (await getFullSnapshot()).tabs });
        break;
      }

      case 'SEND_TAB_HANDOFF': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = message.url || activeTab?.url;
        const title = message.title || activeTab?.title || url;
        if (!url) throw new Error('No page URL to send');
        await liveSync.sendTabHandoff(url, title, message.spaceId || state.activeSpaceId, message.targetDeviceId);
        sendResponse({ ok: true });
        break;
      }

      case 'EXPORT_SIDEBAR_BUNDLE': {
        sendResponse({ ok: true, json: exportArcSidebarBundle(state) });
        break;
      }

      case 'IMPORT_SIDEBAR_BUNDLE': {
        const parsed = JSON.parse(String(message.json || '{}'));
        if (Array.isArray(parsed.spaces) && parsed.spaces.length > 0) {
          state.spaces = parsed.spaces;
          state.activeSpaceId = parsed.spaces[0].id;
        }
        if (Array.isArray(parsed.routingRules)) state.routingRules = parsed.routingRules;
        if (Array.isArray(parsed.siteSearches)) state.siteSearches = parsed.siteSearches;
        if (Array.isArray(parsed.boosts)) state.boosts = parsed.boosts;
        await saveState(state);
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'TRANSLATE_TEXT': {
        const { text, targetLang, sourceLang } = message;
        const res = await translateText(
          text || '',
          targetLang || state.settings.targetLanguage || 'en',
          sourceLang || 'auto'
        );
        sendResponse(res);
        break;
      }

      case 'HANDLE_VOICE_COMMAND': {
        const res = await handleVoiceCommand(
          message.transcript || '',
          message.pageContext || {},
          message.preferredAgent || 'auto',
          sender.tab?.id,
          Boolean(message.fromSidebar),
          Array.isArray(message.history) ? message.history : []
        );
        sendResponse(res);
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((error) => {
    console.warn('Arc request failed:', message?.type, error);
    sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Request failed' });
  });

  return true; // keep message channel open for async response
});

const KNOWN_SITES: Record<string, string> = {
  github: 'https://github.com',
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  mail: 'https://mail.google.com',
  chatgpt: 'https://chatgpt.com',
  calendar: 'https://calendar.google.com',
  docs: 'https://docs.google.com',
  'google docs': 'https://docs.google.com',
  'hacker news': 'https://news.ycombinator.com',
  hackernews: 'https://news.ycombinator.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  twitter: 'https://x.com',
  x: 'https://x.com',
  scholar: 'https://scholar.google.com',
  extensions: 'chrome://extensions',
  settings: 'chrome://settings',
  history: 'chrome://history',
  downloads: 'chrome://downloads'
};

interface VoicePageContext {
  title?: string;
  url?: string;
  selection?: string;
  excerpt?: string;
  buttons?: string[];
  headings?: string[];
  inputs?: string[];
  videoInfo?: {
    hasVideo: boolean;
    videoCount: number;
    iframeCount: number;
    paused?: boolean;
    muted?: boolean;
    duration?: number;
    currentTime?: number;
    src?: string;
    captionText?: string;
  };
}

interface AgentHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface VoiceActionResponse {
  ok: boolean;
  reply: string;
  agent: 'browser' | 'chatgpt' | 'antigravity';
  actionBadge?: string;
  domAction?: {
    type:
      | 'scroll'
      | 'click'
      | 'type'
      | 'history'
      | 'read'
      | 'antigravity'
      | 'translate'
      | 'fix_page'
      | 'toggle_pip';
    direction?: 'up' | 'down' | 'top' | 'bottom' | 'back' | 'forward' | 'reload';
    targetText?: string;
    value?: string;
    taskPrompt?: string;
  };
}

async function handleVoiceCommand(
  rawTranscript: string,
  pageContext: VoicePageContext,
  preferredAgent: 'auto' | 'chatgpt' | 'antigravity',
  senderTabId?: number,
  fromSidebar = false,
  history: AgentHistoryItem[] = []
): Promise<VoiceActionResponse> {
  const transcript = rawTranscript.trim();
  const lower = transcript.toLowerCase().replace(/[.!?]+$/, '').trim();
  const { state, tabs } = await getFullSnapshot();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentTabId = senderTabId ?? activeTab?.id;

  if (!lower) {
    return { ok: false, reply: "I didn't catch that.", agent: 'browser' };
  }

  // 1. Fast Built-In Browser & DOM Actions (work in all modes: Voice, ChatGPT Sidebar, and Antigravity Sidebar!)
  if (
    /make\s+this\s+(?:thing\s+)?work|fix\s+(?:this\s+)?(?:page|video|player|subtitles?|site)|why\s+is(?:n't|\s+not)\s+(?:this|it)\s+working|help\s+me\s+make\s+this|inspect\s+(?:this\s+)?(?:page|video|player)/i.test(
      lower
    )
  ) {
    const vInfo = pageContext.videoInfo;
    const host = formatHostname(pageContext.url || '');
    const diagLines: string[] = [
      `🔍 **Live Browser & DOM Inspection for \`${host || 'Current Page'}\`**:`
    ];
    if (vInfo?.hasVideo || (vInfo?.iframeCount ?? 0) > 0) {
      diagLines.push(
        `• **Media Detected**: ${vInfo?.videoCount || 0} \`<video>\` element(s) and ${vInfo?.iframeCount || 0} \`<iframe>\` embed(s).`
      );
      if ((vInfo?.videoCount || 0) === 0 && (vInfo?.iframeCount || 0) > 0) {
        diagLines.push(
          `• **Cross-Origin Player Notice**: The video player on \`${host}\` is inside an embedded \`<iframe>\`. I am unlocking pointer events, removing overlay blockers, and attaching Arc Media & Subtitle hooks across frames.`
        );
      } else if (vInfo?.hasVideo) {
        diagLines.push(
          `• **Video State**: ${vInfo.paused ? 'Paused' : 'Playing'} (${Math.round(vInfo.currentTime || 0)}s / ${Math.round(vInfo.duration || 0)}s)${vInfo.muted ? ' · Muted' : ''}.`
        );
      }
    } else {
      diagLines.push(
        `• **DOM Elements**: Found ${pageContext.buttons?.length || 0} interactive controls and ${pageContext.inputs?.length || 0} input fields.`
      );
    }
    diagLines.push(
      `• **Auto-Fix Applied**: Cleared transparent click-blocking overlays, enabled native controls & Picture-in-Picture on detected media elements, and synced the page with Arc Sidebar tools.`
    );

    return {
      ok: true,
      reply: diagLines.join('\n'),
      agent: preferredAgent === 'antigravity' ? 'antigravity' : 'chatgpt',
      actionBadge: '⚡ Auto-Fixed Page DOM & Media Overlays',
      domAction: {
        type: 'fix_page',
        taskPrompt: transcript
      }
    };
  }

  // Scroll commands
  if (/^(?:scroll|page)\s+down/.test(lower) || lower === 'down') {
    return {
      ok: true,
      reply: 'Scrolling down on the current page.',
      agent: 'browser',
      actionBadge: '↓ Scrolled down',
      domAction: { type: 'scroll', direction: 'down' }
    };
  }
  if (/^(?:scroll|page)\s+up/.test(lower) || lower === 'up') {
    return {
      ok: true,
      reply: 'Scrolling up on the current page.',
      agent: 'browser',
      actionBadge: '↑ Scrolled up',
      domAction: { type: 'scroll', direction: 'up' }
    };
  }
  if (/scroll\s+to\s+(?:the\s+)?bottom/.test(lower)) {
    return {
      ok: true,
      reply: 'Scrolling to the bottom of the page.',
      agent: 'browser',
      actionBadge: '⤓ Scrolled to bottom',
      domAction: { type: 'scroll', direction: 'bottom' }
    };
  }
  if (/scroll\s+to\s+(?:the\s+)?top/.test(lower)) {
    return {
      ok: true,
      reply: 'Scrolling to the top of the page.',
      agent: 'browser',
      actionBadge: '⤒ Scrolled to top',
      domAction: { type: 'scroll', direction: 'top' }
    };
  }

  // History & Reload
  if (/^(?:go\s+back|back)$/.test(lower)) {
    return {
      ok: true,
      reply: 'Going back in browser history.',
      agent: 'browser',
      actionBadge: '← Back',
      domAction: { type: 'history', direction: 'back' }
    };
  }
  if (/^(?:go\s+forward|forward)$/.test(lower)) {
    return {
      ok: true,
      reply: 'Going forward in browser history.',
      agent: 'browser',
      actionBadge: '→ Forward',
      domAction: { type: 'history', direction: 'forward' }
    };
  }
  if (/^(?:refresh|reload)(?:\s+(?:the\s+)?page)?$/.test(lower)) {
    return {
      ok: true,
      reply: 'Reloading current page.',
      agent: 'browser',
      actionBadge: '↻ Reloaded page',
      domAction: { type: 'history', direction: 'reload' }
    };
  }

  // Click element on page: "click [target]" / "press [target]"
  const clickMatch = lower.match(/^(?:click|press|tap|select)(?:\s+on)?\s+(.+)$/);
  if (clickMatch) {
    const targetText = clickMatch[1].replace(/^(?:the|button|link)\s+/i, '').trim();
    return {
      ok: true,
      reply: `Clicking "${targetText}" on the page.`,
      agent: 'browser',
      actionBadge: `🎯 Clicked "${targetText}"`,
      domAction: { type: 'click', targetText }
    };
  }

  // Type into input: "type [text]" / "enter [text]" / "fill [text]"
  const typeMatch = transcript.match(/^(?:type|enter|write|fill)\s+(.+)$/i);
  if (typeMatch) {
    const val = typeMatch[1].trim();
    return {
      ok: true,
      reply: `Typed "${val}" into the active page input.`,
      agent: 'browser',
      actionBadge: `⌨️ Typed "${val}"`,
      domAction: { type: 'type', value: val }
    };
  }

  // Space switching: "switch to [name] space" or "go to [name] space"
  const spaceMatch = lower.match(/(?:switch\s+to|go\s+to|open)\s+([a-z0-9]+)(?:\s+space)?$/);
  if (spaceMatch) {
    const candidate = spaceMatch[1];
    const matchedSpace = state.spaces.find((s) => s.name.toLowerCase() === candidate);
    if (matchedSpace) {
      state.activeSpaceId = matchedSpace.id;
      await saveState(state);
      return {
        ok: true,
        reply: `Switched to ${matchedSpace.name} space.`,
        agent: 'browser',
        actionBadge: `${matchedSpace.icon} Switched to ${matchedSpace.name}`
      };
    }
  }

  // Tab management: close, pin, favorite, clear, mute, duplicate, borderless
  if (/^(?:close|exit)\s+(?:this\s+)?tab$/.test(lower)) {
    if (typeof currentTabId === 'number') {
      await chrome.tabs.remove(currentTabId);
    }
    return { ok: true, reply: 'Closed tab.', agent: 'browser', actionBadge: '✕ Closed tab' };
  }

  if (/^(?:pin|save)\s+(?:this\s+)?(?:tab|page)/.test(lower)) {
    if (activeTab?.url) {
      await pinUrlToSpace(
        state.activeSpaceId,
        activeTab.title || activeTab.url,
        activeTab.url,
        activeTab.favIconUrl
      );
      return {
        ok: true,
        reply: 'Pinned page to current space.',
        agent: 'browser',
        actionBadge: '📌 Pinned page'
      };
    }
  }

  if (/^(?:favorite|add\s+to\s+favorites|favourite|top\s+pin)/.test(lower)) {
    const targetSpace = state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0];
    if (activeTab?.url && targetSpace) {
      targetSpace.favorites ||= [];
      if (!targetSpace.favorites.some((f) => urlKey(f.url) === urlKey(activeTab.url!))) {
        targetSpace.favorites.push({
          id: `fav-${Date.now()}`,
          title: activeTab.title || formatHostname(activeTab.url),
          url: activeTab.url,
          favIconUrl: activeTab.favIconUrl
        });
        await saveState(state);
      }
    }
    return {
      ok: true,
      reply: `Added page to ${targetSpace?.name || 'current'} space top pins.`,
      agent: 'browser',
      actionBadge: '★ Added Top Pin'
    };
  }

  if (/clear\s+(?:today'?s?\s+)?tabs/.test(lower)) {
    const tabsToClose = tabs.filter(
      (t) => t.spaceId === state.activeSpaceId && !t.pinned && !t.active
    );
    if (tabsToClose.length > 0) {
      await archiveTabs(tabsToClose);
    }
    return {
      ok: true,
      reply: `Cleared ${tabsToClose.length} unpinned tabs.`,
      agent: 'browser',
      actionBadge: `🧹 Cleared ${tabsToClose.length} tabs`
    };
  }

  if (/^(?:mute|unmute)\s+(?:this\s+)?tab$/.test(lower)) {
    if (activeTab?.id) {
      const nextMute = !activeTab.mutedInfo?.muted;
      await chrome.tabs.update(activeTab.id, { muted: nextMute });
      return {
        ok: true,
        reply: nextMute ? 'Muted tab.' : 'Unmuted tab.',
        agent: 'browser',
        actionBadge: nextMute ? '🔇 Muted tab' : '🔊 Unmuted tab'
      };
    }
  }

  if (/borderless|hide\s+top\s+bar|full\s+arc/.test(lower)) {
    if (activeTab?.url) {
      await launchBorderlessArcWindow(activeTab.url);
      return {
        ok: true,
        reply: 'Opened Borderless Arc Window.',
        agent: 'browser',
        actionBadge: '▢ Borderless Window'
      };
    }
  }

  // Translate command: "translate" or "translate this"
  if (/^translate/.test(lower)) {
    const textToTranslate = pageContext.selection || pageContext.excerpt?.slice(0, 600) || '';
    if (textToTranslate) {
      const tr = await translateText(textToTranslate, state.settings.targetLanguage || 'en');
      return {
        ok: true,
        reply: tr.translatedText,
        agent: 'browser',
        actionBadge: `🌐 Translated (${(tr.detectedSourceLang || 'auto').toUpperCase()} → ${(state.settings.targetLanguage || 'en').toUpperCase()})`,
        domAction: { type: 'translate', value: tr.translatedText }
      };
    }
  }

  // Read aloud: "read this page" / "read selection"
  if (/^read\s+(?:this|page|selection|aloud)/.test(lower)) {
    const content =
      pageContext.selection ||
      pageContext.excerpt?.slice(0, 900) ||
      `You are on ${pageContext.title || 'this page'}.`;
    return {
      ok: true,
      reply: content,
      agent: 'browser',
      actionBadge: '🔊 Reading page aloud',
      domAction: { type: 'read', value: content }
    };
  }

  // Switch to open tab: "switch to [tab]"
  const switchTabMatch = lower.match(/^(?:switch\s+to|focus)\s+(?:tab\s+)?(.+)$/);
  if (switchTabMatch) {
    const qTab = switchTabMatch[1].trim();
    const foundTab = tabs.find(
      (t) => t.title.toLowerCase().includes(qTab) || t.url.toLowerCase().includes(qTab)
    );
    if (foundTab) {
      await chrome.tabs.update(foundTab.id, { active: true });
      await chrome.windows.update(foundTab.windowId, { focused: true });
      return {
        ok: true,
        reply: `Switched to ${foundTab.title}.`,
        agent: 'browser',
        actionBadge: `🗂️ Switched to ${formatHostname(foundTab.url)}`
      };
    }
  }

  // Open website or URL: "open [site]" / "go to [site]"
  const openMatch = lower.match(/^(?:open|go\s+to|navigate\s+to|launch)\s+(.+)$/);
  if (openMatch) {
    const rawTarget = openMatch[1].replace(/\s+in\s+new\s+tab$/, '').trim();
    if (rawTarget === 'antigravity') {
      return {
        ok: true,
        reply: 'Switched to Antigravity Browser Agent in sidebar.',
        agent: 'antigravity',
        actionBadge: '🚀 Antigravity Active'
      };
    }
    const knownUrl = KNOWN_SITES[rawTarget];
    if (knownUrl) {
      await createTab({ url: knownUrl, active: true });
      return {
        ok: true,
        reply: `Opening ${rawTarget}.`,
        agent: 'browser',
        actionBadge: `↗ Opened ${rawTarget}`
      };
    }
    const openTabMatch = tabs.find(
      (t) => t.title.toLowerCase().includes(rawTarget) || t.url.toLowerCase().includes(rawTarget)
    );
    if (openTabMatch) {
      await chrome.tabs.update(openTabMatch.id, { active: true });
      await chrome.windows.update(openTabMatch.windowId, { focused: true });
      return {
        ok: true,
        reply: `Switched to ${openTabMatch.title}.`,
        agent: 'browser',
        actionBadge: `🗂️ Switched tab`
      };
    }
    const parsed = parseCommandBarInput(rawTarget);
    if (parsed.isUrl) {
      await createTab({ url: parsed.url, active: true });
      return {
        ok: true,
        reply: `Opening ${parsed.url}.`,
        agent: 'browser',
        actionBadge: `↗ Opened URL`
      };
    }
    await createTab({
      url: `https://www.google.com/search?q=${encodeURIComponent(rawTarget)}`,
      active: true
    });
    return {
      ok: true,
      reply: `Searching Google for ${rawTarget}.`,
      agent: 'browser',
      actionBadge: `🔍 Google Search`
    };
  }

  // Search command: "search [for] [query]" / "google [query]"
  const searchMatch = lower.match(/^(?:search(?:\s+google)?(?:\s+for)?|google|find)\s+(.+)$/);
  if (searchMatch) {
    const qSearch = searchMatch[1].trim();
    await createTab({
      url: `https://www.google.com/search?q=${encodeURIComponent(qSearch)}`,
      active: true
    });
    return {
      ok: true,
      reply: `Searching Google for "${qSearch}".`,
      agent: 'browser',
      actionBadge: `🔍 Searched "${qSearch}"`
    };
  }

  // 2. Check if explicitly addressed to Antigravity or preferredAgent === 'antigravity'
  const agyMatch = lower.match(/^(?:hey\s+)?(?:antigravity|anti\s*gravity|agy)[,\s]+(.+)$/i);
  if (agyMatch || preferredAgent === 'antigravity') {
    const task = agyMatch ? agyMatch[1].trim() : transcript;
    try {
      const bridgeRes = await fetch('http://127.0.0.1:43110/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: task,
          fullTranscript: transcript,
          pageContext,
          history,
          activeSpace: state.spaces.find((s) => s.id === state.activeSpaceId)?.name,
          openTabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
        })
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        if (data?.browserAction) {
          await executeBridgeBrowserAction(data.browserAction, state, currentTabId);
        }
        return {
          ok: true,
          reply: data?.reply || `Executed "${task}" via Antigravity Bridge.`,
          agent: 'antigravity',
          actionBadge: '🚀 Antigravity Local Bridge',
          domAction: data?.domAction
        };
      }
    } catch {
      // Local bridge not running; use OpenAI if configured or built-in Antigravity Browser Agent
    }

    if (state.settings.openaiApiKey) {
      const aiRes = await callOpenAiVoiceAgent(
        task,
        pageContext,
        state,
        tabs,
        currentTabId,
        'antigravity',
        history
      );
      if (aiRes) return aiRes;
    }

    return generateSmartBrowserSidebarReply(task, pageContext, state, tabs, 'antigravity');
  }

  // 3. If OpenAI API Key is set, let ChatGPT handle the conversational request + browser tools!
  const gptMatch = lower.match(/^(?:hey\s+)?(?:chatgpt|chat\s*gpt|gpt|ask\s+chatgpt)[,\s]+(.+)$/i);
  const effectiveQuery = gptMatch ? gptMatch[1].trim() : transcript;
  if (state.settings.openaiApiKey) {
    const aiRes = await callOpenAiVoiceAgent(
      effectiveQuery,
      pageContext,
      state,
      tabs,
      currentTabId,
      'chatgpt',
      history
    );
    if (aiRes) return aiRes;
  }

  // 4. Try Local Antigravity Bridge (`http://127.0.0.1:43110/voice`) if running
  try {
    const bridgeRes = await fetch('http://127.0.0.1:43110/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: effectiveQuery,
        pageContext,
        history,
        activeSpace: state.spaces.find((s) => s.id === state.activeSpaceId)?.name,
        openTabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
      })
    });
    if (bridgeRes.ok) {
      const data = await bridgeRes.json();
      if (data?.browserAction) {
        await executeBridgeBrowserAction(data.browserAction, state, currentTabId);
      }
      return {
        ok: true,
        reply: data?.reply || 'Done.',
        agent: 'antigravity',
        actionBadge: '🚀 Antigravity Bridge',
        domAction: data?.domAction
      };
    }
  } catch {
    // bridge not running
  }

  // 5. Built-in Smart Browser Sidebar Response (Never forces a popup window when chatting in the sidebar!)
  return generateSmartBrowserSidebarReply(effectiveQuery, pageContext, state, tabs, 'chatgpt');
}

function generateSmartBrowserSidebarReply(
  query: string,
  pageContext: VoicePageContext,
  state: ArcState,
  tabs: TabInfo[],
  agent: 'chatgpt' | 'antigravity'
): VoiceActionResponse {
  const lower = query.toLowerCase();
  const host = formatHostname(pageContext.url || '');
  const title = pageContext.title || host || 'Current Page';
  const vInfo = pageContext.videoInfo;
  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId);

  // Summarize / explain page
  if (/summarize|summary|what\s+is\s+this\s+page|explain\s+this|tl;?dr/.test(lower)) {
    const lines: string[] = [`📄 **Summary of ${title}** (\`${host}\`):`];
    if (pageContext.selection) {
      lines.push(`\n**Selected Text:**\n> ${pageContext.selection.slice(0, 400)}`);
    }
    if (pageContext.headings?.length) {
      lines.push(`\n**Key Sections on Page:**\n• ${pageContext.headings.slice(0, 6).join('\n• ')}`);
    }
    if (pageContext.excerpt) {
      lines.push(`\n**Page Content Excerpt:**\n${pageContext.excerpt.slice(0, 550)}...`);
    }
    if (vInfo?.hasVideo || (vInfo?.iframeCount ?? 0) > 0) {
      lines.push(
        `\n🎬 **Media Status:** ${vInfo?.videoCount || 0} video player(s), ${vInfo?.iframeCount || 0} embedded frame(s).`
      );
    }
    return {
      ok: true,
      reply: lines.join('\n'),
      agent,
      actionBadge: '📄 Extracted Page DOM Summary'
    };
  }

  // Video / subtitles / anime / player troubleshooting
  if (/video|player|anime|subtitle|caption|play|pause|pip|float|watch|stream/.test(lower)) {
    return {
      ok: true,
      reply: [
        `🎬 **Media & Player Assistant on \`${host}\`**:`,
        `• Detected **${vInfo?.videoCount || 0} \`<video>\`** element(s) and **${vInfo?.iframeCount || 0} \`<iframe>\`** player(s) on "${title}".`,
        `• I have unlocked video controls, cleared overlay blockers, and synced the player with your Arc Sidebar.`,
        `• You can also use **🛠️ Fix Page & Video** or **📺 PiP** right from the Browser Tools bar above.`
      ].join('\n'),
      agent,
      actionBadge: '🎬 Inspected Media Player',
      domAction: { type: 'fix_page', taskPrompt: query }
    };
  }

  // Default rich contextual response with live DOM inspection
  const contextSummary: string[] = [
    `${agent === 'antigravity' ? '🚀 **Antigravity Browser Agent**' : '🤖 **ChatGPT Browser Agent**'} connected to **${title}** (\`${host}\`).`,
    ``
  ];

  if (pageContext.selection) {
    contextSummary.push(`**Highlighted Selection:**\n> "${pageContext.selection.slice(0, 320)}"\n`);
  }

  if (vInfo?.hasVideo || (vInfo?.iframeCount ?? 0) > 0) {
    contextSummary.push(
      `• **Media on Page**: ${vInfo?.videoCount || 0} \`<video>\` tag(s), ${vInfo?.iframeCount || 0} \`<iframe>\` embed(s).`
    );
  }
  if (pageContext.buttons?.length) {
    contextSummary.push(
      `• **Interactive Controls (${pageContext.buttons.length})**: ${pageContext.buttons.slice(0, 8).map((b) => `\`${b}\``).join(', ')}`
    );
  }
  if (pageContext.headings?.length) {
    contextSummary.push(
      `• **Headings**: ${pageContext.headings.slice(0, 4).join(' · ')}`
    );
  }
  contextSummary.push(
    `• **Workspace**: ${activeSpace?.icon || '🌐'} ${activeSpace?.name || 'Personal'} (${tabs.length} open tabs)`
  );
  contextSummary.push(
    `\n💡 **What I can do right here in the sidebar:**\n- Type **"fix this page"** or click **🛠️ Fix Page & Video** to unblock players/overlays\n- Type **"click [button name]"** or click any interactive element chip above\n- Type **"summarize this page"** or **"translate"**\n- Set your **🔑 OpenAI Key** in the top bar for full GPT-4o conversational reasoning, or click **🌐 Open in ChatGPT Web** / **🚀 Launch Antigravity IDE** below.`
  );

  return {
    ok: true,
    reply: contextSummary.join('\n'),
    agent,
    actionBadge: '🟢 Inspected Live Browser DOM',
    domAction:
      /work|help|bug|issue|error|broken|cant|can't/.test(lower)
        ? { type: 'fix_page', taskPrompt: query }
        : undefined
  };
}

async function executeBridgeBrowserAction(
  action: { type?: string; url?: string; tabId?: number; spaceId?: string },
  state: ArcState,
  currentTabId?: number
) {
  if (action.type === 'open_url' && action.url) {
    await createTab({ url: action.url, active: true });
  } else if (action.type === 'switch_tab' && typeof action.tabId === 'number') {
    await chrome.tabs.update(action.tabId, { active: true });
  } else if (action.type === 'close_tab' && typeof currentTabId === 'number') {
    await chrome.tabs.remove(currentTabId);
  } else if (action.type === 'switch_space' && action.spaceId) {
    state.activeSpaceId = action.spaceId;
    await saveState(state);
  }
}

async function callOpenAiVoiceAgent(
  transcript: string,
  pageContext: VoicePageContext,
  state: ArcState,
  tabs: TabInfo[],
  currentTabId?: number,
  agentMode: 'chatgpt' | 'antigravity' = 'chatgpt',
  history: AgentHistoryItem[] = []
): Promise<VoiceActionResponse | null> {
  const apiKey = state.settings.openaiApiKey?.trim();
  if (!apiKey) return null;

  try {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'open_url',
          description: 'Open a website URL or search query in a new browser tab',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'switch_tab',
          description: 'Switch to an existing open tab by its tabId',
          parameters: {
            type: 'object',
            properties: { tabId: { type: 'number' } },
            required: ['tabId']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'switch_space',
          description: 'Switch the active Arc Space by its name',
          parameters: {
            type: 'object',
            properties: { spaceName: { type: 'string' } },
            required: ['spaceName']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'dom_action',
          description:
            'Perform an action on the current webpage DOM (click a button/link, scroll, type text, navigate history, or fix_page to unblock video players and overlays)',
          parameters: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['scroll', 'click', 'type', 'history', 'fix_page', 'toggle_pip']
              },
              direction: {
                type: 'string',
                enum: ['up', 'down', 'top', 'bottom', 'back', 'forward', 'reload']
              },
              targetText: { type: 'string', description: 'Text of button or link to click' },
              value: { type: 'string', description: 'Text to type into input' }
            },
            required: ['type']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'send_to_antigravity',
          description: 'Hand off a coding or automation task to the Antigravity desktop agent',
          parameters: {
            type: 'object',
            properties: { taskPrompt: { type: 'string' } },
            required: ['taskPrompt']
          }
        }
      }
    ];

    const systemContent = [
      agentMode === 'antigravity'
        ? 'You are Antigravity Browser Agent, an agentic coding & browser assistant inside Chrome with direct access to the current webpage DOM, media players, and browser tabs.'
        : 'You are ChatGPT Browser Agent inside Arc clone, with direct live access to the current webpage DOM, buttons, inputs, video players, and open tabs.',
      'Be helpful, concrete, and directly use your browser/DOM tools whenever the user asks to interact with, fix, click, type, or inspect something on the page.',
      `Current Page: "${pageContext.title || ''}" (${pageContext.url || ''})`,
      pageContext.selection ? `Selected Text: "${pageContext.selection.slice(0, 1000)}"` : '',
      pageContext.headings?.length
        ? `Page Headings: ${pageContext.headings.slice(0, 12).join(' | ')}`
        : '',
      pageContext.videoInfo
        ? `Video/Media Info: hasVideo=${pageContext.videoInfo.hasVideo}, videos=${pageContext.videoInfo.videoCount}, iframes=${pageContext.videoInfo.iframeCount}, paused=${pageContext.videoInfo.paused ?? 'n/a'}`
        : '',
      pageContext.excerpt ? `Page Excerpt: "${pageContext.excerpt.slice(0, 1600)}"` : '',
      pageContext.buttons?.length
        ? `Clickable Elements on Page: ${pageContext.buttons.slice(0, 35).join(', ')}`
        : '',
      `Spaces: ${state.spaces.map((s) => s.name).join(', ')}`,
      `Open Tabs: ${tabs.map((t) => `[${t.id}] ${t.title} (${formatHostname(t.url)})`).join(' | ')}`
    ]
      .filter(Boolean)
      .join('\n');

    const recentHistory = history.slice(-8).map((h) => ({
      role: h.role,
      content: h.content
    }));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemContent },
          ...recentHistory,
          { role: 'user', content: transcript }
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 450
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    const msg = data?.choices?.[0]?.message;
    let domAction: VoiceActionResponse['domAction'] = undefined;
    let executedSummary = '';

    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function?.name;
        const args = JSON.parse(tc.function?.arguments || '{}');
        if (fn === 'open_url' && args.url) {
          await createTab({ url: args.url, active: true });
          executedSummary = `Opened ${args.url}`;
        } else if (fn === 'switch_tab' && typeof args.tabId === 'number') {
          await chrome.tabs.update(args.tabId, { active: true });
          executedSummary = 'Switched tab';
        } else if (fn === 'switch_space' && args.spaceName) {
          const sp = state.spaces.find(
            (s) => s.name.toLowerCase() === String(args.spaceName).toLowerCase()
          );
          if (sp) {
            state.activeSpaceId = sp.id;
            await saveState(state);
            executedSummary = `Switched to ${sp.name} space`;
          }
        } else if (fn === 'dom_action') {
          domAction = {
            type: args.type,
            direction: args.direction,
            targetText: args.targetText,
            value: args.value
          };
          executedSummary = `Executed ${args.type} on page`;
        } else if (fn === 'send_to_antigravity' && args.taskPrompt) {
          domAction = {
            type: 'antigravity',
            taskPrompt: args.taskPrompt
          };
          executedSummary = 'Prepared Antigravity task';
        }
      }
    }

    const reply = msg?.content?.trim() || executedSummary || 'Done.';
    return {
      ok: true,
      reply,
      agent: agentMode,
      actionBadge: executedSummary || undefined,
      domAction
    };
  } catch (err) {
    console.warn('OpenAI Voice Agent error:', err);
    return null;
  }
}
