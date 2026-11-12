import type { ArcState, TabInfo } from './types';

// URL serialisation equates host-only URLs with their trailing-slash form,
// while preserving paths, queries and fragments as distinct pages.
export function urlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
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
  for (const item of space?.pinnedItems || []) {
    for (const link of item.type === 'folder' ? item.children : [item]) {
      savedUrls.add(urlKey(link.url));
      if (link.tabId !== undefined) savedTabIds.add(link.tabId);
    }
  }
  return tabs.filter((tab) =>
    !tab.url.startsWith('chrome-extension://') && tab.spaceId === spaceId && !savedTabIds.has(tab.id) && !tab.pinned && !savedUrls.has(urlKey(tab.url))
  );
}
