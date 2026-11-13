import type { PinnedFolder, PinnedItem, PinnedLink } from './types';

export function pinnedRows(items: PinnedItem[], visibleOnly = false) {
  const rows: { item: PinnedItem; depth: number; rootIndex: number; folder?: PinnedFolder }[] = [];
  function visit(item: PinnedItem, depth: number, rootIndex: number, folder?: PinnedFolder) {
    rows.push({ item, depth, rootIndex, folder });
    if (item.type === 'folder' && (!visibleOnly || !item.collapsed)) {
      for (const child of item.children) visit(child, depth + 1, rootIndex, item);
    }
  }
  items.forEach((item, index) => visit(item, 0, index));
  return rows;
}

export function pinnedLinks(items: PinnedItem[]) {
  return pinnedRows(items).map(({ item }) => item).filter((item): item is PinnedLink => item.type === 'link');
}

export function findFolder(items: PinnedItem[], id: string) {
  const item = pinnedRows(items).find(({ item }) => item.id === id)?.item;
  return item?.type === 'folder' ? item : undefined;
}

export function removePin(items: PinnedItem[], id: string): PinnedItem[] {
  return items.filter(item => item.id !== id).map(item =>
    item.type === 'folder' ? { ...item, children: removePin(item.children, id) } : item);
}
