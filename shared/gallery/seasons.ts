// Season grouping for the library galleries: the extension, the phone app and the TV app
// all show every season and translation of a series under one title.

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
/** "Final Season" sorts after any numbered season. */
const FINAL_SEASON = 1000;
/** A named chapter after a season ("Final Season - Kanketsu-hen") sorts after its parts. */
const CHAPTER_PART = 90;

const SEASON_PATTERNS: [RegExp, (match: RegExpMatchArray) => number][] = [
  [/[\s:,-]*\(?\s*(\d+)(?:st|nd|rd|th)?\s+season\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*season\s+(\d+)\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\s*\)?$/i, match => ORDINALS[match[1].toLowerCase()]],
  [/[\s:,-]*\(?\s*(?:the\s+)?final\s+season\s*\)?$/i, () => FINAL_SEASON],
  [/[\s:,-]*\(?\s*(\d+)(?:-?й)?\s+сезон\s*\)?$/i, match => Number(match[1])],
  [/[\s:,-]*\(?\s*сезон\s+(\d+)\s*\)?$/i, match => Number(match[1])],
  [/\s+(?:TV-?|S)(\d+)$/i, match => Number(match[1])],
  [/\s+(II|III|IV|V|VI)$/, match => ROMAN[match[1].toLowerCase()]],
];
const PART_PATTERN = /[\s:,-]*\(?\s*(?:part|cour)\s+(\d+)\s*\)?$/i;
const SEASON_WORD = /\b(?:season|сезон)\b/i;
/** Long folder names are cut off, sometimes in the middle of "онлайн". */
const CUT_OFF_ONLINE = /\s+о(?:н(?:л(?:а(?:й(?:н)?)?)?)?)?$/i;

/** Names chapters that follow a season, e.g. "Kanketsu-hen" (cut off as "Kankets"). */
function chapterName(text: string) {
  return /^kankets/i.test(text) ? 'Final Chapters' : text;
}

export type Season = {
  /** The series without its season, part or chapter. */
  base: string;
  /** Sort key: seasons in order, then their parts, then named chapters. */
  order: number;
  /** "Season 2", "Final season · Part 2", "Final season · Final Chapters". */
  label: string;
};

/** Splits "Shingeki no Kyojin The Final Season Part 2" into the series and where it falls in it. */
export function seasonOf(title: string): Season {
  let rest = title.replace(CUT_OFF_ONLINE, '').trim();
  let chapter = '';
  // "<series> <season> - <chapter>": the chapter comes after the season it names.
  const dash = rest.match(/^(.*\S)\s+-\s+(\S.*)$/);
  if (dash && SEASON_WORD.test(dash[1])) {
    rest = dash[1].trim();
    chapter = chapterName(dash[2].trim());
  }
  let part = 0;
  const partMatch = rest.match(PART_PATTERN);
  if (partMatch && partMatch.index) {
    part = Number(partMatch[1]);
    rest = rest.slice(0, partMatch.index).trim();
  }
  let season = 1;
  let named = false;
  for (const [pattern, number] of SEASON_PATTERNS) {
    const match = rest.match(pattern);
    const base = match ? rest.slice(0, match.index).trim() : '';
    if (match && base) {
      season = number(match) || 1;
      named = true;
      rest = base;
      break;
    }
  }
  const seasonName = season === FINAL_SEASON ? 'Final season' : `Season ${season}`;
  const label = [named || (!part && !chapter) ? seasonName : '', part ? `Part ${part}` : '', chapter].filter(Boolean).join(' · ');
  return { base: rest || title, order: season * 100 + (chapter ? CHAPTER_PART + part : part), label };
}

export type TitleInfo = {
  title: string;
  credit: string;
  /** The franchise from an anime database (Shikimori), when known: seasons with unrelated names still group. */
  franchise?: string;
  /** When this entry first aired (seconds), from the same database: orders seasons exactly. */
  aired?: number;
};
export type TitleGroup<T> = { key: string; title: string; entries: T[]; seasons: number };

type Placed = TitleInfo & Season;
const place = (info: TitleInfo): Placed => ({ ...info, ...seasonOf(info.title) });
/** Air dates when both have them, otherwise the season named in the title. */
function compareSeasons(left: Placed, right: Placed) {
  return left.aired !== undefined && right.aired !== undefined ? left.aired - right.aired : left.order - right.order;
}
const seasonSlot = (info: Placed) => (info.aired !== undefined ? `aired:${info.aired}` : `order:${info.order}`);

/**
 * One group per series; entries are ordered by season, then by translation. Entries of one
 * franchise group together; the rest group by the title without its season, joining a
 * franchise group whose entries share that title.
 */
export function groupSeasons<T>(items: T[], describe: (item: T) => TitleInfo): TitleGroup<T>[] {
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const info = new Map(items.map(item => [item, place(describe(item))] as const));
  const groups = new Map<string, TitleGroup<T>>();
  const franchiseOfBase = new Map<string, string>();
  for (const item of items) {
    const { franchise, base } = info.get(item)!;
    if (franchise) franchiseOfBase.set(base.toLocaleLowerCase(), `franchise:${franchise}`);
  }
  for (const item of items) {
    const { franchise, base } = info.get(item)!;
    const nameKey = base.toLocaleLowerCase();
    const key = franchise ? `franchise:${franchise}` : franchiseOfBase.get(nameKey) ?? nameKey;
    const group = groups.get(key);
    if (group) group.entries.push(item);
    else groups.set(key, { key, title: base, entries: [item], seasons: 1 });
  }
  return [...groups.values()]
    .map(group => {
      const entries = [...group.entries].sort((a, b) => {
        const left = info.get(a)!;
        const right = info.get(b)!;
        return compareSeasons(left, right) || byName(left.credit, right.credit);
      });
      const seasons = new Set(entries.map(entry => seasonSlot(info.get(entry)!))).size;
      const first = info.get(entries[0])!;
      return {
        ...group,
        // Several seasons are named after the series ("Shingeki no Kyojin"); one season keeps its
        // own name ("Kusuriya no Hitorigoto 3rd Season").
        title: seasons > 1 ? first.base : first.title.replace(CUT_OFF_ONLINE, '').trim(),
        entries,
        seasons,
      };
    })
    .sort((a, b) => byName(a.title, b.title));
}

/**
 * How an entry is named inside its series: its season (when there are several) and translation.
 * A sequel whose title names no season ("Kimetsu no Yaiba: Yuukaku-hen") is named by what its
 * title adds to the series name.
 */
export function seasonLabel(info: TitleInfo, withSeason: boolean, seriesTitle = '') {
  let season = '';
  if (withSeason) {
    const { base, label } = seasonOf(info.title);
    const extra = !seriesTitle ? ''
      : base.toLocaleLowerCase().startsWith(seriesTitle.toLocaleLowerCase()) ? base.slice(seriesTitle.length).replace(/^[\s:,.-]+/, '').trim()
      : base;
    season = extra && label === 'Season 1' ? extra : extra ? `${extra} · ${label}` : label;
  }
  return [season, info.credit || (withSeason ? '' : 'Original')].filter(Boolean).join(' · ');
}

/**
 * Where a series goes once `current` is finished: the next season (or part), in the same
 * translation when it is there.
 */
export function nextSeasonOf<T>(entries: T[], current: T, describe: (item: T) => TitleInfo) {
  const here = place(describe(current));
  const later = entries.map(entry => ({ entry, info: place(describe(entry)) })).filter(({ info }) => compareSeasons(info, here) > 0);
  if (!later.length) return undefined;
  later.sort((a, b) => compareSeasons(a.info, b.info));
  const candidates = later.filter(({ info }) => compareSeasons(info, later[0].info) === 0);
  return (candidates.find(({ info }) => info.credit === here.credit) ?? candidates[0]).entry;
}

// Download folders: "Смотреть аниме <title> онлайн - <id> - <translation>", cut at 60 characters.

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

/** What the anime database knows about a folder's series (see series-catalog.ts). */
export type CatalogEntry = { title?: string; franchise?: string; aired?: number };
/** Catalog entries by folder name. */
export type SeriesCatalog = Record<string, CatalogEntry | undefined>;

/**
 * Folder names are cut at 60 characters, so the catalog's full title (when known) wins:
 * "Shingeki no Kyojin The Final Season - Kankets" is "…Final Season - Kanketsu-hen".
 */
export function folderInfo(name: string, catalog: SeriesCatalog = {}): TitleInfo {
  const { title, credit } = folderTitle(name);
  const known = catalog[name];
  return { title: known?.title || title || name, credit, franchise: known?.franchise, aired: known?.aired };
}

/** One gallery card per series: every season and translation, in season order. */
export function groupByTitle<T extends { name: string }>(entries: T[], catalog: SeriesCatalog = {}) {
  return groupSeasons(entries, entry => folderInfo(entry.name, catalog));
}

/** How a folder is named inside its series: its season (when there are several) and translation. */
export function folderLabel(name: string, withSeason: boolean, catalog: SeriesCatalog = {}, seriesTitle = '') {
  return seasonLabel(folderInfo(name, catalog), withSeason, seriesTitle);
}

/** The folder to continue in once `current` is finished: the next season, same translation if there. */
export function nextSeasonFolder<T extends { name: string }>(entries: T[], current: T, catalog: SeriesCatalog = {}) {
  return nextSeasonOf(entries, current, entry => folderInfo(entry.name, catalog));
}

/** The series a folder belongs to, for finding its other seasons. */
export function sameSeries<T extends { name: string }>(entries: T[], current: T, catalog: SeriesCatalog = {}) {
  return groupByTitle(entries, catalog).find(group => group.entries.includes(current))?.entries ?? [current];
}
