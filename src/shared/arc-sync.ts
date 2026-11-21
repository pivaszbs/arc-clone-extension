import type { Boost } from './site-tools';
import type { ArcState, PinnedFolder, PinnedItem, PinnedLink, RemoteDeviceSummary, Space, SpaceThemeId } from './types';
import { SPACE_THEMES } from './types';

export interface CraTabData {
  url: string;
  savedURL: string;
  savedTitle: string;
  muted?: boolean;
  faviconKey?: string;
}

export type CraItemData =
  | { tab: { _0: CraTabData } }
  | { folder: Record<string, never> }
  | { container: Record<string, { spaceID: string }> };

export interface CraSidebarItem {
  id: string;
  parentID?: string | null;
  title?: string | null;
  children: string[];
  isUnread: boolean;
  createdAt: string;
  data: CraItemData;
}

export interface CraSpaceTheme {
  colors: string[];
  intensity: number;
  noise: number;
  appearance: string;
  vibrant: boolean;
  accent?: string;
  solid: boolean;
}

export interface CraSpace {
  id: string;
  title: string;
  emoji: string;
  theme: CraSpaceTheme;
  favoritesContainerID: string;
  pinnedContainerID: string;
  todayContainerID: string;
  createdAt: string;
}

export interface CraSidebarDocument {
  version: number;
  spaceOrder: string[];
  spaces: CraSpace[];
  items: CraSidebarItem[];
}

export interface CraSyncRoute {
  id: string;
  pattern: string;
  spaceID: string;
  matchStyle: 'contains' | 'equals';
  littleWindow: boolean;
  updatedAt: string;
}

export interface CraSyncSiteSearch {
  id: string;
  shortcut: string;
  label: string;
  urlTemplate: string;
}

export interface CraSyncBoost {
  id: string;
  host: string;
  name: string;
  enabled: boolean;
  hue: number;
  strength: number;
  invert: boolean;
  contrast: number;
  brightness: number;
  saturation: number;
  font?: number;
  textScale: number;
  textCase: string;
  zapped: string[];
  css: string;
  js: string;
}

export interface CraSyncSnapshot {
  version: number;
  revision: number;
  updatedAt: string;
  serverDeviceID: string;
  serverDeviceName: string;
  document: CraSidebarDocument;
  routes: CraSyncRoute[];
  siteSearches: CraSyncSiteSearch[];
  boosts: CraSyncBoost[];
  devices: {
    id: string;
    name: string;
    platform: string;
    lastSeenAt: string;
    activeSpaceID?: string;
    activeTabs: {
      id: string;
      url: string;
      title: string;
      spaceID?: string;
      fromDeviceID: string;
      fromDeviceName: string;
      targetDeviceID?: string;
      createdAt: string;
    }[];
  }[];
  pendingHandoffs: {
    id: string;
    url: string;
    title: string;
    spaceID?: string;
    fromDeviceID: string;
    fromDeviceName: string;
    targetDeviceID?: string;
    createdAt: string;
  }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stableUuid(seed: string): string {
  const trimmed = seed.trim();
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();

  function hashPart(input: string, salt: number): number {
    let h = (2166136261 ^ salt) >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  const p1 = hashPart(trimmed, 0x11111111).toString(16).padStart(8, '0');
  const p2 = hashPart(trimmed, 0x22222222).toString(16).padStart(8, '0');
  const p3 = hashPart(trimmed, 0x33333333).toString(16).padStart(8, '0');
  const p4 = hashPart(trimmed, 0x44444444).toString(16).padStart(8, '0');
  const ver = `4${p2.slice(5, 8)}`;
  const variant = ((parseInt(p3.slice(0, 2), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${p1}-${p2.slice(0, 4)}-${ver}-${variant}${p3.slice(2, 4)}-${p3.slice(4, 8)}${p4}`;
}

export function isoNoMs(input: number | Date = Date.now()): string {
  const d = typeof input === 'number' ? new Date(input) : input;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'msclkid',
  '_hsenc',
  '_hsmi',
  'ref_src',
  'ref_url',
  '_ga',
  '_gl',
  's_kwcid'
]);

export function cleanUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return raw;
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? parsed.toString() : raw;
  } catch {
    return raw;
  }
}

export function parsePairingUri(uri: string): { name: string; token: string; urls: string[] } | null {
  try {
    const parsed = new URL(uri.trim());
    if (parsed.protocol !== 'arcsync:' || parsed.hostname !== 'pair') return null;
    const token = (parsed.searchParams.get('token') || '').trim();
    if (!token) return null;
    const name = (parsed.searchParams.get('name') || 'Mac').trim() || 'Mac';
    const urls = (parsed.searchParams.get('urls') || '')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => {
        try {
          const endpoint = new URL(u);
          return endpoint.protocol === 'http:' || endpoint.protocol === 'https:';
        } catch {
          return false;
        }
      });
    if (urls.length === 0) return null;
    return { name, token, urls };
  } catch {
    return null;
  }
}

const THEME_DEFAULT_COLORS: Record<SpaceThemeId, string[]> = {
  indigo: ['#3f42c8', '#1f1e3f'],
  rose: ['#ff3b6b', '#411b2a'],
  emerald: ['#18a374', '#16382f'],
  sunset: ['#f97316', '#4a1d32'],
  ocean: ['#0284c7', '#132f4c'],
  midnight: ['#5d7290', '#202631']
};

function extractGradientColors(theme: SpaceThemeId, customColors?: string[]): string[] {
  if (customColors && customColors.length > 0) return customColors;
  return THEME_DEFAULT_COLORS[theme] || THEME_DEFAULT_COLORS.indigo;
}

function nearestThemePreset(colors: string[]): SpaceThemeId {
  const first = (colors[0] || '').toLowerCase();
  if (first.includes('ff3b') || first.includes('e11') || first.includes('dc2') || first.includes('f43')) return 'rose';
  if (first.includes('18a') || first.includes('10b') || first.includes('059') || first.includes('22c')) return 'emerald';
  if (first.includes('f97') || first.includes('fb9') || first.includes('ea5') || first.includes('ff7')) return 'sunset';
  if (first.includes('028') || first.includes('0ea') || first.includes('38b')) return 'ocean';
  if (first.includes('5d7') || first.includes('475') || first.includes('334') || first.includes('202')) return 'midnight';
  return 'indigo';
}

function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function arcStateToCraSidebar(state: ArcState, now = Date.now()): CraSidebarDocument {
  const stamp = isoNoMs(now);
  const spaceOrder: string[] = [];
  const spaces: CraSpace[] = [];
  const items: CraSidebarItem[] = [];

  for (const space of state.spaces) {
    const sid = stableUuid(space.id);
    const favContainerId = stableUuid(`container:fav:${sid}`);
    const pinContainerId = stableUuid(`container:pin:${sid}`);
    const todayContainerId = stableUuid(`container:today:${sid}`);

    spaceOrder.push(sid);
    spaces.push({
      id: sid,
      title: space.name,
      emoji: space.icon || '✨',
      theme: {
        colors: extractGradientColors(space.theme, space.customColors),
        intensity: 0.85,
        noise: 0.15,
        appearance: space.appearance || 'auto',
        vibrant: false,
        solid: false
      },
      favoritesContainerID: favContainerId,
      pinnedContainerID: pinContainerId,
      todayContainerID: todayContainerId,
      createdAt: stamp
    });

    const favChildren: string[] = [];
    for (const fav of space.favorites || []) {
      const fid = stableUuid(`fav:${sid}:${fav.id || fav.url}`);
      favChildren.push(fid);
      items.push({
        id: fid,
        parentID: favContainerId,
        title: fav.title || null,
        children: [],
        isUnread: false,
        createdAt: stamp,
        data: {
          tab: {
            _0: {
              url: fav.url,
              savedURL: fav.url,
              savedTitle: fav.title || '',
              faviconKey: hostFromUrl(fav.url)
            }
          }
        }
      });
    }

    items.push({
      id: favContainerId,
      parentID: null,
      title: null,
      children: favChildren,
      isUnread: false,
      createdAt: stamp,
      data: { container: { favorites: { spaceID: sid } } }
    });

    const emitPinned = (nodes: PinnedItem[], parentID: string): string[] => {
      const ids: string[] = [];
      for (const node of nodes) {
        const nid = stableUuid(node.id);
        ids.push(nid);
        if (node.type === 'folder') {
          const childIds = emitPinned(node.children, nid);
          items.push({
            id: nid,
            parentID,
            title: node.title,
            children: childIds,
            isUnread: false,
            createdAt: stamp,
            data: { folder: {} }
          });
        } else {
          items.push({
            id: nid,
            parentID,
            title: node.title || null,
            children: [],
            isUnread: false,
            createdAt: stamp,
            data: {
              tab: {
                _0: {
                  url: node.url,
                  savedURL: node.url,
                  savedTitle: node.title || '',
                  faviconKey: hostFromUrl(node.url)
                }
              }
            }
          });
        }
      }
      return ids;
    };

    const pinChildren = emitPinned(space.pinnedItems || [], pinContainerId);
    items.push({
      id: pinContainerId,
      parentID: null,
      title: null,
      children: pinChildren,
      isUnread: false,
      createdAt: stamp,
      data: { container: { pinned: { spaceID: sid } } }
    });

    items.push({
      id: todayContainerId,
      parentID: null,
      title: null,
      children: [],
      isUnread: false,
      createdAt: stamp,
      data: { container: { today: { spaceID: sid } } }
    });
  }

  return { version: 1, spaceOrder, spaces, items };
}

export function craSnapshotToArcState(snapshot: CraSyncSnapshot, current: ArcState): ArcState {
  const byID = new Map(snapshot.document.items.map((it) => [it.id, it]));
  const existingSpaceById = new Map(current.spaces.map((s) => [stableUuid(s.id), s]));

  const tabFromItem = (it: CraSidebarItem): { url: string; title: string } | null => {
    if ('tab' in it.data) {
      const t = it.data.tab._0;
      const url = t.savedURL || t.url;
      if (!url) return null;
      return { url, title: it.title || t.savedTitle || url };
    }
    return null;
  };

  const buildPinned = (ids: string[], oldFolders: Map<string, PinnedFolder>): PinnedItem[] => {
    const out: PinnedItem[] = [];
    for (const id of ids) {
      const item = byID.get(id);
      if (!item) continue;
      if ('folder' in item.data) {
        const prev = oldFolders.get(item.id);
        out.push({
          id: item.id,
          type: 'folder',
          title: item.title || 'Folder',
          collapsed: prev?.collapsed,
          icon: prev?.icon,
          iconColor: prev?.iconColor,
          liveFeed: prev?.liveFeed,
          children: buildPinned(item.children, oldFolders)
        });
      } else {
        const td = tabFromItem(item);
        if (td) {
          out.push({
            id: item.id,
            type: 'link',
            title: td.title,
            url: td.url
          } satisfies PinnedLink);
        }
      }
    }
    return out;
  };

  const collectFolderMap = (nodes: PinnedItem[], out: Map<string, PinnedFolder>) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        out.set(n.id, n);
        collectFolderMap(n.children, out);
      }
    }
  };

  const orderedSpaceIds = snapshot.document.spaceOrder.length > 0
    ? snapshot.document.spaceOrder
    : snapshot.document.spaces.map((s) => s.id);

  const spaceById = new Map(snapshot.document.spaces.map((s) => [s.id, s]));
  const nextSpaces: Space[] = [];

  for (const sid of orderedSpaceIds) {
    const craSpace = spaceById.get(sid);
    if (!craSpace) continue;
    const prev = existingSpaceById.get(sid);
    const oldFolders = new Map<string, PinnedFolder>();
    if (prev) collectFolderMap(prev.pinnedItems, oldFolders);

    const favContainer = byID.get(craSpace.favoritesContainerID);
    const favorites = (favContainer?.children || []).flatMap((cid) => {
      const it = byID.get(cid);
      const td = it ? tabFromItem(it) : null;
      return td ? [{ id: cid, title: td.title, url: td.url }] : [];
    });

    const pinContainer = byID.get(craSpace.pinnedContainerID);
    const pinnedItems = buildPinned(pinContainer?.children || [], oldFolders);

    const colors = craSpace.theme?.colors || [];
    const matchedPreset = nearestThemePreset(colors);
    const isExactPreset =
      colors.length === 2 &&
      THEME_DEFAULT_COLORS[matchedPreset][0].toLowerCase() === colors[0].toLowerCase() &&
      THEME_DEFAULT_COLORS[matchedPreset][1].toLowerCase() === colors[1].toLowerCase();

    nextSpaces.push({
      id: sid,
      name: craSpace.title || prev?.name || 'Space',
      icon: craSpace.emoji || prev?.icon || '✨',
      theme: prev?.theme && !colors.length ? prev.theme : matchedPreset,
      customColors: isExactPreset ? prev?.customColors : colors,
      appearance: (craSpace.theme?.appearance as Space['appearance']) || prev?.appearance,
      favorites,
      pinnedItems
    });
  }

  const routes = (snapshot.routes || []).map((r) => ({
    id: r.id,
    pattern: r.pattern,
    spaceId: r.spaceID
  }));

  const existingBoosts = new Map((current.boosts || []).map((b) => [stableUuid(b.id), b]));
  const boosts: Boost[] = (snapshot.boosts || []).map((b) => {
    const prev = existingBoosts.get(b.id);
    return {
      id: b.id,
      host: b.host,
      name: b.name,
      css: b.css,
      enabled: b.enabled,
      hue: b.hue,
      invert: b.invert,
      brightness: b.brightness !== 50 ? b.brightness : prev?.brightness,
      contrast: b.contrast !== 50 ? b.contrast : prev?.contrast,
      saturate: b.saturation !== 50 ? b.saturation : prev?.saturate,
      textCase: (b.textCase as Boost['textCase']) || 'none',
      zappedSelectors: b.zapped,
      js: b.js,
      fontFamily: prev?.fontFamily,
      fontSize: prev?.fontSize,
      tintColor: prev?.tintColor,
      tintIntensity: prev?.tintIntensity
    };
  });

  const siteSearches = snapshot.siteSearches?.length
    ? snapshot.siteSearches.map((s) => ({
        id: s.id,
        name: s.label,
        shortcut: s.shortcut,
        url: s.urlTemplate
      }))
    : current.siteSearches;

  const myDeviceId = current.syncConfig?.deviceId;
  const remoteDevices: RemoteDeviceSummary[] = (snapshot.devices || [])
    .filter((d) => d.id !== myDeviceId)
    .map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastSeenAt: d.lastSeenAt,
      activeTabs: (d.activeTabs || []).map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        spaceId: t.spaceID,
        fromDeviceId: t.fromDeviceID,
        fromDeviceName: t.fromDeviceName
      }))
    }));

  const activeExists = nextSpaces.some((s) => s.id === stableUuid(current.activeSpaceId) || s.id === current.activeSpaceId);
  const nextActive = nextSpaces.length > 0
    ? activeExists
      ? nextSpaces.find((s) => s.id === stableUuid(current.activeSpaceId) || s.id === current.activeSpaceId)!.id
      : nextSpaces[0].id
    : current.activeSpaceId;

  // Remap open tabSpaceMap entries to canonical UUID space IDs if needed.
  const nextTabSpaceMap: Record<number, string> = {};
  const validSet = new Set(nextSpaces.map((s) => s.id));
  for (const [tabId, spId] of Object.entries(current.tabSpaceMap)) {
    const uuid = stableUuid(spId);
    nextTabSpaceMap[Number(tabId)] = validSet.has(uuid) ? uuid : nextActive;
  }

  return {
    ...current,
    spaces: nextSpaces.length > 0 ? nextSpaces : current.spaces,
    activeSpaceId: nextActive,
    tabSpaceMap: nextTabSpaceMap,
    routingRules: routes.length > 0 ? routes : current.routingRules,
    siteSearches,
    boosts: boosts.length > 0 ? boosts : current.boosts,
    remoteDevices,
    syncConfig: current.syncConfig
      ? {
          ...current.syncConfig,
          peerName: snapshot.serverDeviceName,
          lastRevision: snapshot.revision,
          lastSyncedAt: Date.now(),
          lastError: undefined
        }
      : current.syncConfig
  };
}
