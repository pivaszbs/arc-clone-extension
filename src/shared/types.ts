export type SpaceThemeId = 'indigo' | 'sunset' | 'emerald' | 'ocean' | 'rose' | 'midnight';

export interface SpaceTheme {
  id: SpaceThemeId;
  name: string;
  gradient: string;
  accent: string;
  surface: string;
  border: string;
  chromeColor: chrome.tabGroups.ColorEnum;
}

export const SPACE_THEMES: Record<SpaceThemeId, SpaceTheme> = {
  indigo: {
    id: 'indigo',
    name: 'Cosmic Indigo',
    gradient: 'linear-gradient(155deg, #3b354e 0%, #2d293d 48%, #262432 100%)',
    accent: '#8b7cf8',
    surface: 'rgba(139, 124, 248, 0.14)',
    border: 'rgba(165, 152, 255, 0.22)',
    chromeColor: 'purple'
  },
  sunset: {
    id: 'sunset',
    name: 'Solar Sunset',
    gradient: 'linear-gradient(155deg, #59404f 0%, #443240 50%, #342936 100%)',
    accent: '#f472b6',
    surface: 'rgba(244, 114, 182, 0.14)',
    border: 'rgba(249, 168, 212, 0.22)',
    chromeColor: 'pink'
  },
  emerald: {
    id: 'emerald',
    name: 'Forest Canopy',
    gradient: 'linear-gradient(155deg, #304b43 0%, #293e38 50%, #23322f 100%)',
    accent: '#34d399',
    surface: 'rgba(52, 211, 153, 0.14)',
    border: 'rgba(110, 231, 183, 0.22)',
    chromeColor: 'green'
  },
  ocean: {
    id: 'ocean',
    name: 'Pacific Tide',
    gradient: 'linear-gradient(155deg, #304858 0%, #293946 50%, #222f3a 100%)',
    accent: '#38bdf8',
    surface: 'rgba(56, 189, 248, 0.14)',
    border: 'rgba(125, 211, 252, 0.22)',
    chromeColor: 'blue'
  },
  rose: {
    id: 'rose',
    name: 'Warm Terracotta',
    gradient: 'linear-gradient(155deg, #59403e 0%, #44312f 50%, #352929 100%)',
    accent: '#fb7185',
    surface: 'rgba(251, 113, 133, 0.14)',
    border: 'rgba(253, 164, 175, 0.22)',
    chromeColor: 'red'
  },
  midnight: {
    id: 'midnight',
    name: 'Obsidian Dark',
    gradient: 'linear-gradient(155deg, #1e2028 0%, #14161c 50%, #0d0e12 100%)',
    accent: '#a1a1aa',
    surface: 'rgba(255, 255, 255, 0.08)',
    border: 'rgba(255, 255, 255, 0.15)',
    chromeColor: 'grey'
  }
};

export interface PinnedLink {
  id: string;
  type: 'link';
  title: string;
  url: string;
  favIconUrl?: string;
  parentId?: string;
  tabId?: number;
}

export interface PinnedFolder {
  id: string;
  type: 'folder';
  title: string;
  collapsed?: boolean;
  children: PinnedItem[];
}

export type PinnedItem = PinnedLink | PinnedFolder;

export interface LinkRoute {
  id: string;
  match: 'host' | 'contains' | 'prefix';
  text: string;
  spaceId: string;
}

export interface SiteBoost {
  origin: string;
  css: string;
}

export interface Space {
  id: string;
  name: string;
  icon: string;
  theme: SpaceThemeId;
  favorites?: FavoriteItem[];
  pinnedItems: PinnedItem[];
  chromeGroupId?: number;
}

export interface FavoriteItem {
  id: string;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  audible: boolean;
  muted: boolean;
  pinned: boolean;
  groupId: number;
  spaceId: string;
  lastAccessed?: number;
}

export interface ExtensionSettings {
  targetLanguage: string;
  translateOnSelectMode: 'pill' | 'instant' | 'shortcut';
  peekTrigger: 'shift-click' | 'alt-click' | 'off';
  peekMode: 'overlay' | 'popup';
  leftSidebarMode: 'hover' | 'pinned' | 'off';
  syncChromeTabGroups: boolean;
  autoArchiveHours: number;
  openaiApiKey?: string;
  voiceAutoSpeak?: boolean;
  voiceContinuous?: boolean;
  linkRoutes?: LinkRoute[];
  siteBoosts?: SiteBoost[];
}

export interface ArchivedTab {
  id: string;
  title: string;
  url: string;
  spaceId: string;
  archivedAt: number;
}

export interface ArcState {
  archive?: ArchivedTab[];
  spaces: Space[];
  activeSpaceId: string;
  favorites: FavoriteItem[];
  tabSpaceMap: Record<number, string>;
  tabLastAccessed: Record<number, number>;
  settings: ExtensionSettings;
}

export interface OmniboxResultItem {
  id: string;
  kind: 'tab' | 'pinned' | 'favorite' | 'bookmark' | 'history' | 'action' | 'search';
  title: string;
  subtitle: string;
  url?: string;
  tabId?: number;
  spaceId?: string;
  favIconUrl?: string;
  actionId?: string;
  shortcut?: string;
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish (Español)' },
  { code: 'fr', name: 'French (Français)' },
  { code: 'de', name: 'German (Deutsch)' },
  { code: 'it', name: 'Italian (Italiano)' },
  { code: 'pt', name: 'Portuguese (Português)' },
  { code: 'ru', name: 'Russian (Русский)' },
  { code: 'uk', name: 'Ukrainian (Українська)' },
  { code: 'ja', name: 'Japanese (日本語)' },
  { code: 'ko', name: 'Korean (한국어)' },
  { code: 'zh-CN', name: 'Chinese Simplified (简体中文)' },
  { code: 'ar', name: 'Arabic (العربية)' },
  { code: 'hi', name: 'Hindi (हिन्दी)' },
  { code: 'tr', name: 'Turkish (Türkçe)' },
  { code: 'pl', name: 'Polish (Polski)' },
  { code: 'nl', name: 'Dutch (Nederlands)' }
];

export function parseCommandBarInput(raw: string): { isUrl: boolean; url: string } {
  const q = raw.trim();
  if (!q) return { isUrl: false, url: '' };

  if (/^(https?:\/\/|chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|file:\/\/)/i.test(q)) {
    return { isUrl: true, url: q };
  }

  if (/^localhost(:\d+)?(\/.*)?$/i.test(q)) {
    return { isUrl: true, url: `http://${q}` };
  }

  if (!q.includes(' ') && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q)) {
    return { isUrl: true, url: `https://${q}` };
  }

  return {
    isUrl: false,
    url: `https://www.google.com/search?q=${encodeURIComponent(q)}`
  };
}

export function getFaviconUrl(url?: string, explicitFavicon?: string): string {
  // The host page's image policy also applies inside the injected shadow root.
  const page = globalThis.location;
  if (page && (page.protocol === 'http:' || page.protocol === 'https:')) {
    try {
      const icon = new URL(explicitFavicon || '');
      return icon.origin === page.origin && icon.protocol === page.protocol ? icon.href : '';
    } catch { return ''; }
  }
  if (explicitFavicon && !explicitFavicon.startsWith('chrome://')) {
    return explicitFavicon;
  }
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=64`;
    }
  } catch {
    // ignore invalid URL
  }
  return '';
}
