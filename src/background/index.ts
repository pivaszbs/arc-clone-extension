import { desktopPipRequest } from './desktop-pip';
import { getSpaceFavorites, getTodayTabs, urlKey } from '../shared/tabs';
import { studyRequest } from '../japanese/storage';
import { subtitleUrl } from '../japanese/captions';
import { supportedSite } from '../japanese/study';
import { captureCaptionResponses } from '../japanese/network-captions';
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

const STORAGE_KEY = 'arc_chrome_state_v1';
const captionScans = new Map<string, Promise<chrome.scripting.InjectionResult<string[]>[]>>();

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
const activeTabByWindow: Record<number, number> = {};
const previousActiveTabByWindow: Record<number, number> = {};
const programmaticNewTabUrls = new Set<string>();

// Initialize current active tabs per window
chrome.tabs.query({ active: true }).then((activeTabs) => {
  for (const t of activeTabs) {
    if (t.id && t.windowId) {
      activeTabByWindow[t.windowId] = t.id;
    }
  }
}).catch(() => {});

async function loadState(): Promise<ArcState> {
  if (cachedState) return cachedState;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<ArcState> | undefined;

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
    settings: mergedSettings
  };

  if (!cachedState.spaces.some((space) => space.id === cachedState!.activeSpaceId)) {
    cachedState.activeSpaceId = cachedState.spaces[0].id;
  }

  return cachedState;
}

async function saveState(state: ArcState): Promise<void> {
  cachedState = state;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcastStateUpdate();
}

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
  });
  void chrome.alarms.create('arc-auto-archive', { periodInMinutes: 1 });
}

async function resetSpace(spaceId: string) {
  const { state, tabs } = await getFullSnapshot();
  const space = state.spaces.find((space) => space.id === spaceId);
  for (const link of space?.pinnedItems.flatMap((item) => item.type === 'folder' ? item.children : [item]) || []) {
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

chrome.runtime.onInstalled.addListener(() => {
  void setupSidePanel();
  registerContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  void setupSidePanel();
  // A restored browser session can assign different live tab IDs.
  const state = await loadState();
  for (const space of state.spaces) {
    for (const link of space.pinnedItems.flatMap((item) => item.type === 'folder' ? item.children : [item])) {
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
    if (tab?.id && state.settings.peekMode === 'overlay') {
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
  const state = await loadState();

  const rawUrl = tab.pendingUrl || tab.url || '';
  const isNewTab =
    rawUrl === 'chrome://newtab/' ||
    rawUrl === 'chrome://newtab' ||
    rawUrl.endsWith('/newtab.html');

  if (isNewTab && ! rawUrl.includes('focused=1') && !programmaticNewTabUrls.has('allow-next')) {
    const prevTabId =
      activeTabByWindow[tab.windowId] !== tab.id
        ? activeTabByWindow[tab.windowId]
        : previousActiveTabByWindow[tab.windowId];

    if (typeof prevTabId === 'number' && prevTabId !== tab.id) {
      try {
        const prevTab = await chrome.tabs.get(prevTabId);
        const prevUrl = prevTab.url || '';
        if (prevUrl.startsWith('http://') || prevUrl.startsWith('https://')) {
          const response = await chrome.tabs.sendMessage(prevTabId, {
            type: 'OPEN_COMMAND_BAR_FROM_CMDT'
          });
          if (response?.ok) {
            await chrome.tabs.update(prevTabId, { active: true });
            await chrome.tabs.remove(tab.id);
            return;
          }
        }
      } catch {
        // Content script not running on previous tab
      }
    }

    // Replace chrome://newtab with extension URL ?focused=1 so Chrome focuses our URL input instead of Chrome's top Omnibox!
    programmaticNewTabUrls.add('allow-next');
    const focusedTab = await chrome.tabs.create({
      url: chrome.runtime.getURL('newtab.html?focused=1'),
      windowId: tab.windowId,
      active: true
    });
    if (focusedTab.id) {
      state.tabSpaceMap[focusedTab.id] = state.activeSpaceId;
      state.tabLastAccessed[focusedTab.id] = Date.now();
      await saveState(state);
    }
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // ignore if already closed
    }
    return;
  }
  programmaticNewTabUrls.delete('allow-next');

  if (!state.tabSpaceMap[tab.id]) {
    state.tabSpaceMap[tab.id] = state.activeSpaceId;
    state.tabLastAccessed[tab.id] = Date.now();
    await saveState(state);
  } else {
    broadcastStateUpdate();
  }
});

chrome.tabs.onUpdated.addListener(() => {
  broadcastStateUpdate();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (activeTabByWindow[windowId] && activeTabByWindow[windowId] !== tabId) {
    previousActiveTabByWindow[windowId] = activeTabByWindow[windowId];
  }
  activeTabByWindow[windowId] = tabId;

  const state = await loadState();
  state.tabLastAccessed[tabId] = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcastStateUpdate();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  delete state.tabSpaceMap[tabId];
  delete state.tabLastAccessed[tabId];
  await saveState(state);
});

async function openLittleArcWindow(url: string) {
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
    ? space.pinnedItems.find((item): item is PinnedFolder => item.type === 'folder' && item.id === folderId)
    : undefined;
  if (folderId && !folder) return;
  const links = space.pinnedItems.flatMap((item) => item.type === 'folder' ? item.children : [item]);
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
  if (existing) {
    space.pinnedItems = space.pinnedItems.filter((item) => item.id !== existing.id);
    for (const item of space.pinnedItems) {
      if (item.type === 'folder') item.children = item.children.filter((child) => child.id !== existing.id);
    }
  }
  if (folder) folder.children.push(newPin);
  else space.pinnedItems.push(newPin);
  await saveState(state);
}

async function translateText(text: string, targetLang: string, sourceLang = 'auto') {
  const trimmed = text.trim();
  if (!trimmed) {
    return { translatedText: '', detectedSourceLang: sourceLang };
  }

  try {
    const endpoint = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      sourceLang
    )}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(trimmed)}`;

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Translation HTTP status ${response.status}`);
    }
    const data = await response.json();
    // data[0] contains array of [translatedSegment, originalSegment, ...]
    const translatedSegments: string[] = [];
    if (Array.isArray(data?.[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') {
          translatedSegments.push(seg[0]);
        }
      }
    }
    const detectedSourceLang = typeof data?.[2] === 'string' ? data[2] : sourceLang;
    return {
      translatedText: translatedSegments.join('') || trimmed,
      detectedSourceLang
    };
  } catch (err) {
    console.error('Translation error:', err);
    return {
      translatedText: `[Translation unavailable] ${trimmed}`,
      detectedSourceLang: sourceLang,
      error: String(err)
    };
  }
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
    for (const item of space.pinnedItems) {
      if (item.type === 'link') {
        if (results.some((result) => result.kind === 'tab' && result.spaceId === space.id && urlKey(result.url || '') === urlKey(item.url))) continue;
        if (!q || item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)) {
          results.push({
            id: `pin-${item.id}`,
            kind: 'pinned',
            title: item.title,
            subtitle: `Pinned in ${space.icon} ${space.name} · ${formatHostname(item.url)}`,
            url: item.url,
            spaceId: space.id,
            favIconUrl: item.favIconUrl,
            shortcut: 'Pinned'
          });
        }
      } else if (item.type === 'folder') {
        for (const child of item.children) {
          if (results.some((result) => result.kind === 'tab' && result.spaceId === space.id && urlKey(result.url || '') === urlKey(child.url))) continue;
          if (!q || child.title.toLowerCase().includes(q) || child.url.toLowerCase().includes(q)) {
            results.push({
              id: `pin-${child.id}`,
              kind: 'pinned',
              title: child.title,
              subtitle: `${space.icon} ${space.name} / 📁 ${item.title} · ${formatHostname(child.url)}`,
              url: child.url,
              spaceId: space.id,
              favIconUrl: child.favIconUrl,
              shortcut: 'Pinned'
            });
          }
        }
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
    } else {
      const parsed = parseCommandBarInput(query);
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
    if (message?.type === 'JAPANESE_SCAN_NETWORK') {
      const tabId = sender.tab?.id;
      const allowed = [sender.tab?.url, sender.url].some(value => {
        try { return supportedSite(new URL(value || '').hostname); } catch { return false; }
      });
      if (tabId === undefined || sender.frameId === undefined || !allowed) throw new Error('Open the scan from a supported video page.');
      const target = sender.documentId ? { tabId, documentIds: [sender.documentId] } : { tabId, frameIds: [sender.frameId] };
      const key = sender.documentId ?? `${tabId}:${sender.frameId}`;
      let scan = captionScans.get(key);
      if (!scan) {
        scan = chrome.scripting.executeScript({ target, world: 'MAIN', func: captureCaptionResponses })
          .finally(() => captionScans.delete(key));
        captionScans.set(key, scan);
      }
      const [result] = await scan;
      sendResponse({ bodies: result?.result || [] });
      return;
    }
    if (message?.type === 'JAPANESE_FETCH_CAPTIONS') {
      const url = String(message.url || '');
      if (!subtitleUrl(url)) throw new Error('Unsupported subtitle source.');
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 5000000) throw new Error('Subtitle source unavailable.');
      const body = await response.text();
      if (body.length > 5000000) throw new Error('Subtitle source too large.');
      sendResponse({ body });
      return;
    }
    if (typeof message?.type === 'string' && message.type.startsWith('JAPANESE_')) {
      sendResponse(await studyRequest(message));
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
        const tab = await chrome.tabs.create({ url: entry.url, active: true });
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
        const items = space?.pinnedItems.flatMap((item) => item.type === 'folder' ? [item, ...item.children] : [item]) || [];
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
            await chrome.tabs.create({ url, active: true });
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
        const { spaceId, name, icon, theme } = message;
        const space = state.spaces.find((s) => s.id === spaceId);
        if (space) {
          if (name) space.name = name.trim();
          if (icon) space.icon = icon;
          if (theme && theme in SPACE_THEMES) space.theme = theme;
          await saveState(state);
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

      case 'CREATE_TAB': {
        const { url, spaceId, active = true } = message;
        const targetSpaceId = spaceId || state.activeSpaceId;
        const inPopup = await isSenderInPopupWindow(sender);
        if (inPopup && sender.tab?.id && url && !url.startsWith('chrome://')) {
          await chrome.tabs.update(sender.tab.id, { url });
          sendResponse({ ok: true });
          break;
        }
        const created = await chrome.tabs.create({
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
        const existing = snapshot.tabs
          .filter((tab) => urlKey(tab.url) === urlKey(url) && (sharedFavorite || tab.spaceId === targetSpaceId))
          .sort((a, b) => Number(b.spaceId === targetSpaceId) - Number(a.spaceId === targetSpaceId)
            || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
        const links = state.spaces.find((space) => space.id === targetSpaceId)?.pinnedItems
          .flatMap((item) => item.type === 'folder' ? item.children : [item]) || [];
        const pin = links.find((link) => urlKey(link.url) === urlKey(url));
        const linked = pin?.tabId === undefined ? undefined : snapshot.tabs.find((tab) => tab.id === pin.tabId && tab.spaceId === targetSpaceId);
        const target = linked || existing;
        state.activeSpaceId = targetSpaceId;
        if (target) {
          await chrome.tabs.update(target.id, { active: true });
          await chrome.windows.update(target.windowId, { focused: true });
          if (pin) pin.tabId = target.id;
        } else {
          const created = await chrome.tabs.create({ url, active: true });
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
          space.pinnedItems = space.pinnedItems
            .filter((item) => item.id !== itemId)
            .map((item) => {
              if (item.type === 'folder') {
                return {
                  ...item,
                  children: item.children.filter((c) => c.id !== itemId)
                };
              }
              return item;
            });
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'CREATE_FOLDER': {
        const { spaceId, title } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (space) {
          const folder: PinnedFolder = {
            id: `folder-${Date.now()}`,
            type: 'folder',
            title: title?.trim() || 'New Folder',
            collapsed: false,
            children: []
          };
          space.pinnedItems.push(folder);
          await saveState(state);
        }
        sendResponse(await getFullSnapshot());
        break;
      }

      case 'TOGGLE_FOLDER': {
        const { spaceId, folderId } = message;
        const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId));
        if (space) {
          const folder = space.pinnedItems.find(
            (i): i is PinnedFolder => i.type === 'folder' && i.id === folderId
          );
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
        state.settings = { ...state.settings, ...settings };
        await saveState(state);
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
        if (state.settings.peekMode === 'overlay' && activeTab?.id && !activeTab.url?.startsWith('chrome://')) {
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
        }
        sendResponse({ ok: true });
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
          sender.tab?.id
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
}

interface VoiceActionResponse {
  ok: boolean;
  reply: string;
  agent: 'browser' | 'chatgpt' | 'antigravity';
  domAction?: {
    type: 'scroll' | 'click' | 'type' | 'history' | 'read' | 'antigravity' | 'translate';
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
  senderTabId?: number
): Promise<VoiceActionResponse> {
  const transcript = rawTranscript.trim();
  const lower = transcript.toLowerCase().replace(/[.!?]+$/, '').trim();
  const { state, tabs } = await getFullSnapshot();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentTabId = senderTabId ?? activeTab?.id;

  if (!lower) {
    return { ok: false, reply: "I didn't catch that.", agent: 'browser' };
  }

  // 1. Check if explicitly addressed to Antigravity or preferredAgent === 'antigravity'
  const agyMatch = lower.match(/^(?:hey\s+)?(?:antigravity|anti\s*gravity|agy)[,\s]+(.+)$/i);
  if (agyMatch || preferredAgent === 'antigravity') {
    const task = agyMatch ? agyMatch[1].trim() : transcript;
    // Try sending to local Antigravity Bridge first if running on localhost:43110
    try {
      const bridgeRes = await fetch('http://127.0.0.1:43110/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: task,
          fullTranscript: transcript,
          pageContext,
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
          reply: data?.reply || `Sent "${task}" to Antigravity Bridge.`,
          agent: 'antigravity',
          domAction: data?.domAction || {
            type: 'antigravity',
            taskPrompt: task
          }
        };
      }
    } catch {
      // Local bridge not running or unreachable; hand off to Antigravity desktop app
    }

    return {
      ok: true,
      reply: `Sending "${task}" with current page context to Antigravity.`,
      agent: 'antigravity',
      domAction: {
        type: 'antigravity',
        taskPrompt: task
      }
    };
  }

  // 2. If user has an OpenAI API key configured (or explicitly says "Ask ChatGPT ..."), use OpenAI Function Calling if key exists
  const gptMatch = lower.match(/^(?:hey\s+)?(?:chatgpt|chat\s*gpt|gpt|ask\s+chatgpt)[,\s]+(.+)$/i);
  if (state.settings.openaiApiKey && (preferredAgent === 'chatgpt' || gptMatch)) {
    const res = await callOpenAiVoiceAgent(
      gptMatch ? gptMatch[1].trim() : transcript,
      pageContext,
      state,
      tabs,
      currentTabId
    );
    if (res) return res;
  }

  if (gptMatch && !state.settings.openaiApiKey) {
    const question = gptMatch[1].trim();
    const fullPrompt = pageContext.selection
      ? `${question}\n\nContext from ${pageContext.title} (${pageContext.url}):\n${pageContext.selection}`
      : `${question} (Context: ${pageContext.title || ''} ${pageContext.url || ''})`;
    await openLittleArcWindow(`https://chatgpt.com/?q=${encodeURIComponent(fullPrompt)}`);
    return {
      ok: true,
      reply: `Opening ChatGPT with your question: ${question}`,
      agent: 'chatgpt'
    };
  }

  // 3. Fast Built-In Browser & DOM Voice Intents
  // Scroll commands
  if (/^(?:scroll|page)\s+down/.test(lower) || lower === 'down') {
    return {
      ok: true,
      reply: 'Scrolling down.',
      agent: 'browser',
      domAction: { type: 'scroll', direction: 'down' }
    };
  }
  if (/^(?:scroll|page)\s+up/.test(lower) || lower === 'up') {
    return {
      ok: true,
      reply: 'Scrolling up.',
      agent: 'browser',
      domAction: { type: 'scroll', direction: 'up' }
    };
  }
  if (/scroll\s+to\s+(?:the\s+)?bottom/.test(lower)) {
    return {
      ok: true,
      reply: 'Scrolling to the bottom.',
      agent: 'browser',
      domAction: { type: 'scroll', direction: 'bottom' }
    };
  }
  if (/scroll\s+to\s+(?:the\s+)?top/.test(lower)) {
    return {
      ok: true,
      reply: 'Scrolling to the top.',
      agent: 'browser',
      domAction: { type: 'scroll', direction: 'top' }
    };
  }

  // History & Reload
  if (/^(?:go\s+back|back)$/.test(lower)) {
    return {
      ok: true,
      reply: 'Going back.',
      agent: 'browser',
      domAction: { type: 'history', direction: 'back' }
    };
  }
  if (/^(?:go\s+forward|forward)$/.test(lower)) {
    return {
      ok: true,
      reply: 'Going forward.',
      agent: 'browser',
      domAction: { type: 'history', direction: 'forward' }
    };
  }
  if (/^(?:refresh|reload)(?:\s+(?:the\s+)?page)?$/.test(lower)) {
    return {
      ok: true,
      reply: 'Reloading page.',
      agent: 'browser',
      domAction: { type: 'history', direction: 'reload' }
    };
  }

  // Click element on page: "click [target]" / "press [target]"
  const clickMatch = lower.match(/^(?:click|press|tap|select)(?:\s+on)?\s+(.+)$/);
  if (clickMatch) {
    const targetText = clickMatch[1].replace(/^(?:the|button|link)\s+/i, '').trim();
    return {
      ok: true,
      reply: `Clicking "${targetText}".`,
      agent: 'browser',
      domAction: { type: 'click', targetText }
    };
  }

  // Type into input: "type [text]" / "enter [text]"
  const typeMatch = transcript.match(/^(?:type|enter|write)\s+(.+)$/i);
  if (typeMatch) {
    const val = typeMatch[1].trim();
    return {
      ok: true,
      reply: `Typing "${val}".`,
      agent: 'browser',
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
        agent: 'browser'
      };
    }
  }

  // Tab management: close, pin, favorite, clear, mute, duplicate, borderless
  if (/^(?:close|exit)\s+(?:this\s+)?tab$/.test(lower)) {
    if (typeof currentTabId === 'number') {
      await chrome.tabs.remove(currentTabId);
    }
    return { ok: true, reply: 'Closed tab.', agent: 'browser' };
  }

  if (/^(?:pin|save)\s+(?:this\s+)?(?:tab|page)/.test(lower)) {
    if (activeTab?.url) {
      await pinUrlToSpace(
        state.activeSpaceId,
        activeTab.title || activeTab.url,
        activeTab.url,
        activeTab.favIconUrl
      );
      return { ok: true, reply: 'Pinned page to current space.', agent: 'browser' };
    }
  }

  if (/^(?:favorite|add\s+to\s+favorites|favourite)/.test(lower)) {
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
    return { ok: true, reply: `Added page to ${targetSpace?.name || 'current'} space top pins.`, agent: 'browser' };
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
      agent: 'browser'
    };
  }

  if (/^(?:mute|unmute)\s+(?:this\s+)?tab$/.test(lower)) {
    if (activeTab?.id) {
      const nextMute = !activeTab.mutedInfo?.muted;
      await chrome.tabs.update(activeTab.id, { muted: nextMute });
      return {
        ok: true,
        reply: nextMute ? 'Muted tab.' : 'Unmuted tab.',
        agent: 'browser'
      };
    }
  }

  if (/borderless|hide\s+top\s+bar|full\s+arc/.test(lower)) {
    if (activeTab?.url) {
      await launchBorderlessArcWindow(activeTab.url);
      return { ok: true, reply: 'Opened Borderless Arc Window.', agent: 'browser' };
    }
  }

  // Translate command: "translate" or "translate this"
  if (/^translate/.test(lower)) {
    const textToTranslate = pageContext.selection || pageContext.excerpt?.slice(0, 500) || '';
    if (textToTranslate) {
      const tr = await translateText(textToTranslate, state.settings.targetLanguage || 'en');
      return {
        ok: true,
        reply: tr.translatedText,
        agent: 'browser',
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
        agent: 'browser'
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
        reply: 'Launching Antigravity.',
        agent: 'antigravity',
        domAction: { type: 'antigravity', taskPrompt: '' }
      };
    }
    const knownUrl = KNOWN_SITES[rawTarget];
    if (knownUrl) {
      await chrome.tabs.create({ url: knownUrl, active: true });
      return { ok: true, reply: `Opening ${rawTarget}.`, agent: 'browser' };
    }
    // Check if an open tab matches
    const openTabMatch = tabs.find(
      (t) => t.title.toLowerCase().includes(rawTarget) || t.url.toLowerCase().includes(rawTarget)
    );
    if (openTabMatch) {
      await chrome.tabs.update(openTabMatch.id, { active: true });
      await chrome.windows.update(openTabMatch.windowId, { focused: true });
      return { ok: true, reply: `Switched to ${openTabMatch.title}.`, agent: 'browser' };
    }
    const parsed = parseCommandBarInput(rawTarget);
    if (parsed.isUrl) {
      await chrome.tabs.create({ url: parsed.url, active: true });
      return { ok: true, reply: `Opening ${parsed.url}.`, agent: 'browser' };
    }
    // Otherwise open a Google "I'm Feeling Lucky" or search
    await chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(rawTarget)}`,
      active: true
    });
    return { ok: true, reply: `Searching Google for ${rawTarget}.`, agent: 'browser' };
  }

  // Search command: "search [for] [query]" / "google [query]"
  const searchMatch = lower.match(/^(?:search(?:\s+google)?(?:\s+for)?|google|find)\s+(.+)$/);
  if (searchMatch) {
    const qSearch = searchMatch[1].trim();
    await chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(qSearch)}`,
      active: true
    });
    return { ok: true, reply: `Searching Google for "${qSearch}".`, agent: 'browser' };
  }

  // 4. Fallback: If OpenAI API Key is set, let ChatGPT handle the conversational request + browser tools!
  if (state.settings.openaiApiKey) {
    const aiRes = await callOpenAiVoiceAgent(transcript, pageContext, state, tabs, currentTabId);
    if (aiRes) return aiRes;
  }

  // 5. Try Local Antigravity Bridge (`http://127.0.0.1:43110/voice`) for general conversational / agent requests
  try {
    const bridgeRes = await fetch('http://127.0.0.1:43110/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        pageContext,
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
        domAction: data?.domAction
      };
    }
  } catch {
    // bridge not running
  }

  // 6. If user asked a general question without an API key, open ChatGPT in Little Arc with the question + page context!
  const contextualPrompt = pageContext.selection
    ? `${transcript}\n\nContext from "${pageContext.title || ''}" (${pageContext.url || ''}):\n${pageContext.selection}`
    : `${transcript}\n\n(Current page: "${pageContext.title || ''}" ${pageContext.url || ''})`;
  await openLittleArcWindow(`https://chatgpt.com/?q=${encodeURIComponent(contextualPrompt)}`);
  return {
    ok: true,
    reply: `Asking ChatGPT: "${transcript}"`,
    agent: 'chatgpt'
  };
}

async function executeBridgeBrowserAction(
  action: { type?: string; url?: string; tabId?: number; spaceId?: string },
  state: ArcState,
  currentTabId?: number
) {
  if (action.type === 'open_url' && action.url) {
    await chrome.tabs.create({ url: action.url, active: true });
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
  currentTabId?: number
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
          description: 'Perform an action on the current webpage DOM (click a button/link, scroll, type text, or navigate history)',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['scroll', 'click', 'type', 'history'] },
              direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom', 'back', 'forward', 'reload'] },
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
      'You are Arc Voice, an intelligent voice assistant inside Chrome powered by ChatGPT and Antigravity.',
      'Keep your spoken responses concise, natural, and helpful (1-2 short sentences).',
      `Current Page: "${pageContext.title || ''}" (${pageContext.url || ''})`,
      pageContext.selection ? `Selected Text: "${pageContext.selection.slice(0, 800)}"` : '',
      pageContext.excerpt ? `Page Excerpt: "${pageContext.excerpt.slice(0, 1200)}"` : '',
      pageContext.buttons?.length
        ? `Clickable Elements on Page: ${pageContext.buttons.slice(0, 30).join(', ')}`
        : '',
      `Spaces: ${state.spaces.map((s) => s.name).join(', ')}`,
      `Open Tabs: ${tabs.map((t) => `[${t.id}] ${t.title} (${formatHostname(t.url)})`).join(' | ')}`
    ]
      .filter(Boolean)
      .join('\n');

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
          { role: 'user', content: transcript }
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 220
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
          await chrome.tabs.create({ url: args.url, active: true });
          executedSummary = `Opened ${args.url}.`;
        } else if (fn === 'switch_tab' && typeof args.tabId === 'number') {
          await chrome.tabs.update(args.tabId, { active: true });
          executedSummary = 'Switched tab.';
        } else if (fn === 'switch_space' && args.spaceName) {
          const sp = state.spaces.find(
            (s) => s.name.toLowerCase() === String(args.spaceName).toLowerCase()
          );
          if (sp) {
            state.activeSpaceId = sp.id;
            await saveState(state);
            executedSummary = `Switched to ${sp.name} space.`;
          }
        } else if (fn === 'dom_action') {
          domAction = {
            type: args.type,
            direction: args.direction,
            targetText: args.targetText,
            value: args.value
          };
          executedSummary = 'Executed action on page.';
        } else if (fn === 'send_to_antigravity' && args.taskPrompt) {
          domAction = {
            type: 'antigravity',
            taskPrompt: args.taskPrompt
          };
          executedSummary = 'Sent task to Antigravity.';
        }
      }
    }

    const reply = msg?.content?.trim() || executedSummary || 'Done.';
    return {
      ok: true,
      reply,
      agent: 'chatgpt',
      domAction
    };
  } catch (err) {
    console.warn('OpenAI Voice Agent error:', err);
    return null;
  }
}
