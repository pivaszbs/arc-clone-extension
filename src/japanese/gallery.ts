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

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
/** "Final Season" sorts after any numbered season. */
const FINAL_SEASON = 1000;
const SEASON_PATTERNS: [RegExp, (match: RegExpMatchArray) => number][] = [
  [/[\s:,-]*\(?\s*(\d+)(?:st|nd|rd|th)?\s+season\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*season\s+(\d+)\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\s*\)?$/i, match => ORDINALS[match[1].toLowerCase()]],
  [/[\s:,-]*\(?\s*final\s+season\s*\)?$/i, () => FINAL_SEASON],
  [/[\s:,-]*\(?\s*(\d+)(?:-?й)?\s+сезон\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*сезон\s+(\d+)\s*\)?$/i, match => Number(match[1])],
  [/\s+(?:TV-?|S)(\d+)$/i, match => Number(match[1])],
  [/\s+(II|III|IV|V|VI)$/, match => ROMAN[match[1].toLowerCase()]],
];

/** Splits "Kusuriya no Hitorigoto 2nd Season" into the series and its season (1 when unnamed). */
export function seasonOf(title: string) {
  for (const [pattern, number] of SEASON_PATTERNS) {
    const match = title.match(pattern);
    const base = match ? title.slice(0, match.index).trim() : '';
    if (match && base) return { base, season: number(match) || 1 };
  }
  return { base: title, season: 1 };
}

/** Season and translation of a download folder, as the gallery groups and orders it. */
export function folderSeason(name: string) {
  const { title, credit } = folderTitle(name);
  const { base, season } = seasonOf(title || name);
  return { title: base, season, credit };
}

/** How a folder is named inside its title: its season (when the title has several) and translation. */
export function folderLabel(name: string, withSeason: boolean) {
  const { season, credit } = folderSeason(name);
  const seasonName = season === FINAL_SEASON ? 'Final season' : `Season ${season}`;
  return [withSeason ? seasonName : '', credit || (withSeason ? '' : 'Original')].filter(Boolean).join(' · ');
}

export type TitleGroup<T> = { key: string; title: string; entries: T[]; seasons: number };

/**
 * One gallery card per title: every season and translation of a series shares a card, and
 * opening it shows them one level deeper, in season order.
 */
export function groupByTitle<T extends { name: string }>(entries: T[]): TitleGroup<T>[] {
  const groups = new Map<string, TitleGroup<T>>();
  for (const entry of entries) {
    const title = folderSeason(entry.name).title || entry.name;
    const key = title.toLocaleLowerCase();
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, title, entries: [entry], seasons: 1 });
  }
  const order = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...groups.values()]
    .map(group => {
      const sorted = [...group.entries].sort((a, b) => {
        const left = folderSeason(a.name);
        const right = folderSeason(b.name);
        return left.season - right.season || order(left.credit, right.credit);
      });
      return { ...group, entries: sorted, seasons: new Set(sorted.map(entry => folderSeason(entry.name).season)).size };
    })
    .sort((a, b) => order(a.title, b.title));
}

/**
 * The folder to continue a title in once `current` is finished: the next season,
 * in the same translation when it is downloaded.
 */
export function nextSeasonFolder<T extends { name: string }>(entries: T[], current: T) {
  const { season, credit } = folderSeason(current.name);
  const later = entries.filter(entry => folderSeason(entry.name).season > season);
  if (!later.length) return undefined;
  const next = Math.min(...later.map(entry => folderSeason(entry.name).season));
  const candidates = later.filter(entry => folderSeason(entry.name).season === next);
  return candidates.find(entry => folderSeason(entry.name).credit === credit) ?? candidates[0];
}
