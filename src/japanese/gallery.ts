/** Download folders are named "Смотреть аниме <title> онлайн - <id> - <translation>". */
export function folderTitle(name: string) {
  const plain = name.replace(/^Смотреть аниме\s+/i, '');
  const parts = plain.match(/^(.*?) - \d+(?: - (.+))?$/);
  // Without an id, drop a trailing translation credit such as "- NDA Studio Дубляж".
  const credit = parts ? parts[2] || '' : plain.match(/\s+-\s+([^-]*(?:дубляж|озвучка|субтитр|войсовер|dub|sub)[^-]*)$/i)?.[1] || '';
  const title = (parts ? parts[1] : credit ? plain.slice(0, plain.lastIndexOf(credit)).replace(/\s+-\s*$/, '') : plain)
    .replace(/\s+онлайн$/i, '').trim();
  return { title, credit: credit.trim() };
}

/** The smotret-anime series id in a download folder name, if there is one. */
export function folderSeriesId(name: string) {
  return name.match(/^.+? - (\d+)(?: - .+)?$/)?.[1];
}

export type TitleGroup<T> = { key: string; title: string; entries: T[] };

/**
 * One gallery card per title: folders of the same series in different translations
 * share a card, and opening it shows the translations one level deeper.
 */
export function groupByTitle<T extends { name: string }>(entries: T[]): TitleGroup<T>[] {
  const groups = new Map<string, TitleGroup<T>>();
  for (const entry of entries) {
    const title = folderTitle(entry.name).title || entry.name;
    const key = title.toLocaleLowerCase();
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, title, entries: [entry] });
  }
  const order = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...groups.values()]
    .map(group => ({ ...group, entries: [...group.entries].sort((a, b) => order(folderTitle(a.name).credit, folderTitle(b.name).credit)) }))
    .sort((a, b) => order(a.title, b.title));
}
