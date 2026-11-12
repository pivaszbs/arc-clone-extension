import type { ArcState, TabInfo } from './types';
import { pinnedLinks } from './pins';

// URL serialisation equates host-only URLs with their trailing-slash form,
// while preserving paths, queries and fragments as distinct pages.
export function urlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export function sameHost(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA).hostname.replace(/^www\./i, '').toLowerCase();
    const b = new URL(urlB).hostname.replace(/^www\./i, '').toLowerCase();
    return Boolean(a && a === b);
  } catch {
    return false;
  }
}

export function isRootDomainUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export function getSpaceFavorites(state: ArcState, spaceId?: string) {
  const space = state.spaces.find((s) => s.id === (spaceId || state.activeSpaceId)) || state.spaces[0];
  return Array.isArray(space?.favorites) ? space.favorites : state.favorites;
}

export function getTodayTabs(state: ArcState, tabs: TabInfo[], spaceId: string): TabInfo[] {
  const spaceFavs = getSpaceFavorites(state, spaceId);
  const savedUrls = new Set(spaceFavs.map((favorite) => urlKey(favorite.url)));
  const savedTabIds = new Set<number>();
  const space = state.spaces.find((space) => space.id === spaceId);
  for (const link of pinnedLinks(space?.pinnedItems || [])) {
    savedUrls.add(urlKey(link.url));
    if (link.tabId !== undefined) savedTabIds.add(link.tabId);
  }
  return tabs.filter((tab) =>
    !tab.url.startsWith('chrome-extension://') && tab.spaceId === spaceId && !savedTabIds.has(tab.id) && !tab.pinned && !savedUrls.has(urlKey(tab.url))
  );
}
