import { japaneseCaptions, parseCaptionResponse } from './captions';
import { findEpisodeDownloads, isAnimeSubtitleSite } from './page-captions';
import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from 'parse5';

export const AUTO_FALLBACK = '__auto__';

export interface SeriesEpisodeVariant {
  team: string;
  page: string;
  video?: { url: string; height: number };
  subtitle?: string;
}

export interface SeriesEpisode {
  page: string;
  label: string;
  team?: string;
  video?: { url: string; height: number };
  subtitle?: string;
  variants?: SeriesEpisodeVariant[];
}

export interface SeriesPlan {
  series: string;
  title: string;
  edition?: string;
  primaryTeam?: string;
  episodes: SeriesEpisode[];
}

export function seriesRoot(value: string) {
  const url = new URL(value);
  const path = url.pathname.match(/^\/catalog\/([\w-]+-\d+)(?:\/|$)/i)?.[1];
  if (!path || url.protocol !== 'https:' || url.port || url.username || url.password || !isAnimeSubtitleSite(url.hostname)) {
    throw new Error('Open an Anime365 series or episode.');
  }
  return new URL(`/catalog/${path}`, url);
}

function safeName(name: string) {
  return name.replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 60) || 'Series';
}

export type SeriesFile = { url: string; name: string; kind: 'video' | 'subtitle' };

/**
 * The folder and file names for the chosen episodes, shared by Chrome and the phone so a series
 * downloaded on either one has the same names (progress and skip timings are keyed by them).
 */
export function seriesFiles(plan: SeriesPlan, selectedPages: string[]): { folder: string; files: SeriesFile[] } {
  const series = seriesRoot(plan.series);
  const edition = plan.edition && plan.edition !== 'Japanese subtitles' ? ` - ${safeName(plan.edition)}` : '';
  const folder = `${safeName(plan.title)} - ${series.pathname.match(/\d+$/)![0]}${edition}`;
  const files: SeriesFile[] = [];
  const selection = new Set(selectedPages);
  for (const [index, episode] of plan.episodes.entries()) {
    if (!episode.video || !selection.has(episode.page)) continue;
    const video = new URL(episode.video.url);
    const videoId = video.pathname.match(/^\/translations\/mp4\/(\d+)\/?$/i)?.[1];
    if (video.origin !== series.origin || video.username || video.password || !videoId) throw new Error('An episode has an invalid video link.');
    const name = `Episode ${String(index + 1).padStart(3, '0')} - ${videoId}`;
    if (episode.subtitle) {
      const subtitle = new URL(episode.subtitle);
      const sub = subtitle.pathname.match(/^\/translations\/(ass|ssa|srt|vtt)\/(\d+)\/?$/i);
      if (subtitle.origin !== series.origin || subtitle.username || subtitle.password || sub?.[2] !== videoId) throw new Error('An episode has mismatched download links.');
      files.push({ url: subtitle.href, name: `${name}.${sub[1].toLowerCase()}`, kind: 'subtitle' });
    }
    files.push({ url: video.href, name: `${name}.mp4`, kind: 'video' });
  }
  if (!files.length) throw new Error('There are no downloadable episodes in this edition.');
  return { folder, files };
}

type CatalogLink ={ href: string; textContent: string; className: string };
type CatalogPage = { links: CatalogLink[]; title: string; editionTitle: string };
type CatalogNode = DefaultTreeAdapterTypes.Node;

function pageMetadata(html: string): CatalogPage {
  const page: CatalogPage = { links: [], title: '', editionTitle: '' };
  function text(node: CatalogNode): string {
    if (defaultTreeAdapter.isTextNode(node)) return node.value;
    if (defaultTreeAdapter.isElementNode(node) && node.tagName === 'i') return '';
    return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  }
  function visit(node: CatalogNode, inEdition = false) {
    if (defaultTreeAdapter.isElementNode(node)) {
      const className = node.attrs.find(attr => attr.name === 'class')?.value || '';
      inEdition ||= className.split(/\s+/).includes('m-translation-view-title');
      if (node.tagName === 'a') {
        const href = node.attrs.find(attr => attr.name === 'href')?.value;
        if (href) page.links.push({ href, className, textContent: text(node).trim().replace(/\s+/g, ' ') });
      }
      if (node.tagName === 'h1' && !page.title) page.title = text(node).trim();
      if (node.tagName === 'h3' && inEdition && !page.editionTitle) page.editionTitle = text(node).trim();
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, inEdition);
  }
  visit(parse(html));
  return page;
}

async function readPage(url: URL) {
  const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(12000) });
  if (!response.ok || new URL(response.url).origin !== url.origin) throw new Error('Anime365 did not return the page.');
  return { ...pageMetadata(await response.text()), url: new URL(response.url) };
}

export async function currentEpisodeDownloads(value: string) {
  const root = seriesRoot(value);
  const source = new URL(value);
  const path = source.pathname.slice(root.pathname.length);
  if (!/^\/[\w-]+-\d+\/[\w-]+-\d+\/?$/.test(path)) return null;
  const { links, url } = await readPage(source);
  if (url.pathname !== source.pathname) return null;
  return findEpisodeDownloads(links, url);
}

function allEditionLinks(page: CatalogPage & { url: URL }, episode: URL, category: string): { url: URL; label: string }[] {
  const prefix = `${episode.pathname}/${category}-`;
  const byPath = new Map<string, { url: URL; label: string; preferred: boolean }>();
  for (const anchor of page.links) {
    let link: URL;
    try { link = new URL(anchor.href, page.url); } catch { continue; }
    if (link.origin !== episode.origin || !link.pathname.startsWith(prefix) || !/^\d+\/?$/.test(link.pathname.slice(prefix.length))) continue;
    const label = anchor.textContent;
    if (!label) continue;
    const preferred = anchor.className.split(/\s+/).includes('truncate');
    const existing = byPath.get(link.pathname);
    if (!existing || (preferred && !existing.preferred)) {
      byPath.set(link.pathname, { url: link, label, preferred });
    }
  }
  return [...byPath.values()].map(({ url, label }) => ({ url, label }));
}

function editionLink(page: CatalogPage & { url: URL }, episode: URL, category: string, team?: string) {
  const links = allEditionLinks(page, episode, category);
  if (team) return links.find(link => link.label.toLowerCase() === team.toLowerCase()) || null;
  return links.find(link => link.url.pathname === page.url.pathname) || null;
}

export async function planSeries(value: string, onProgress: (checked: number, total: number) => void): Promise<SeriesPlan> {
  const series = seriesRoot(value);
  const source = new URL(value);
  const [, episodeSlug, editionSlug] = source.pathname.slice(series.pathname.length).split('/');
  const category = editionSlug?.replace(/-\d+$/, '') || 'yaponskie-subtitry';
  const studyEdition = category === 'yaponskie-subtitry';
  const isDub = category === 'ozvuchka' || category === 'angliyskaya-ozvuchka';
  const sourceEpisode = episodeSlug && new URL(`${series.pathname}/${episodeSlug}`, series);
  const exactEdition = !!sourceEpisode && !!editionSlug && /-\d+$/.test(editionSlug);
  const selected = exactEdition ? await readPage(source) : null;
  const team = selected && sourceEpisode && isDub
    ? editionLink(selected, sourceEpisode, category)?.label : undefined;
  const edition = studyEdition ? 'Japanese subtitles'
    : team || selected?.editionTitle || category;
  const catalog = await readPage(series);
  const episodes = new Map<string, SeriesEpisode>();
  for (const link of catalog.links) {
    let url: URL;
    try { url = new URL(link.href, series); } catch { continue; }
    if (url.origin !== series.origin || !url.pathname.startsWith(series.pathname + '/')) continue;
    const slug = url.pathname.slice(series.pathname.length + 1).replace(/\/$/, '');
    if (!/^[\w-]+-\d+$/.test(slug)) continue;
    const label = link.textContent?.replace(/^\s*play_circle_filled\s*/, '').trim().replace(/\s+/g, ' ').slice(0, 90) || slug;
    if (!episodes.has(slug)) episodes.set(slug, { page: new URL(series.pathname + '/' + slug, series).href, label });
  }
  const list = [...episodes.values()].sort((a, b) => a.page.localeCompare(b.page, undefined, { numeric: true }));
  if (!list.length) throw new Error('No episodes were listed on this series page.');
  for (const [index, episode] of list.entries()) {
    onProgress(index, list.length);
    try {
      const episodeUrl = new URL(episode.page);
      const variant = new URL(`${episode.page}/${category}`);
      const isSelectedEpisode = sourceEpisode && episodeUrl.pathname === sourceEpisode.pathname;
      if (exactEdition && isDub && !team && !isSelectedEpisode) continue;
      let page = isSelectedEpisode && selected ? selected : await readPage(variant);
      const variants: SeriesEpisodeVariant[] = !studyEdition
        ? allEditionLinks(page, episodeUrl, category).map(link => ({ team: link.label, page: link.url.href }))
        : [];
      const cacheDownloads = (loaded: CatalogPage & { url: URL }) => {
        const found = findEpisodeDownloads(loaded.links, loaded.url);
        if (!found?.video) return null;
        const active = variants.find(item => new URL(item.page).pathname === loaded.url.pathname);
        if (active) {
          active.video = found.video;
          active.subtitle = found.subtitle;
        }
        return { downloads: found, team: active?.team || editionLink(loaded, episodeUrl, category)?.label };
      };
      const initialCached = !studyEdition ? cacheDownloads(page) : null;
      if (variants.length) episode.variants = variants;

      if (team && !isSelectedEpisode) {
        const match = editionLink(page, episodeUrl, category, team);
        if (!match) continue;
        if (match.url.pathname !== page.url.pathname) page = await readPage(match.url);
        if (page.url.pathname !== match.url.pathname) continue;
      }
      const { links, url } = page;
      if (url.pathname !== variant.pathname && !url.pathname.startsWith(variant.pathname + '-')) continue;
      if (isSelectedEpisode && exactEdition && url.pathname !== source.pathname) continue;
      const resolved = !studyEdition ? cacheDownloads(page) : null;
      const downloads = resolved?.downloads || findEpisodeDownloads(links, url);
      if (!downloads?.video) continue;
      if (!studyEdition) {
        episode.video = downloads.video;
        episode.team = resolved?.team || initialCached?.team || editionLink(page, episodeUrl, category)?.label;
        continue;
      }
      if (!downloads.subtitle) continue;
      if (new URL(downloads.video.url).pathname.split('/').filter(Boolean).at(-1) !==
          new URL(downloads.subtitle).pathname.split('/').filter(Boolean).at(-1)) continue;
      const response = await fetch(downloads.subtitle, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (!response.ok || Number(response.headers.get('content-length')) > 5000000) continue;
      if (!japaneseCaptions(parseCaptionResponse(await response.text()))) continue;
      Object.assign(episode, downloads);
    } catch { /* Keep the episode visible as unavailable. */ }
  }
  onProgress(list.length, list.length);
  return { series: series.href, title: catalog.title || series.pathname.split('/').at(-1)!, edition, primaryTeam: team, episodes: list };
}

async function loadVariant(variant: SeriesEpisodeVariant): Promise<SeriesEpisodeVariant> {
  if (variant.video) return variant;
  const target = new URL(variant.page);
  const page = await readPage(target);
  if (page.url.pathname !== target.pathname) return variant;
  const downloads = findEpisodeDownloads(page.links, page.url);
  if (downloads?.video) {
    variant.video = downloads.video;
    variant.subtitle = downloads.subtitle;
  }
  return variant;
}

export async function resolveSeriesTeam(
  plan: SeriesPlan,
  fallbackTeam: string | undefined,
  onProgress?: (checked: number, total: number) => void
): Promise<SeriesPlan> {
  const primaryTeam = plan.primaryTeam;
  const counts = new Map<string, number>();
  for (const episode of plan.episodes) {
    for (const variant of episode.variants || []) {
      const key = variant.team.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const targets: { episode: SeriesEpisode; variant?: SeriesEpisodeVariant }[] = [];
  for (const episode of plan.episodes) {
    const variants = episode.variants || [];
    if (!variants.length) continue;
    let chosen = primaryTeam
      ? variants.find(v => v.team.toLowerCase() === primaryTeam.toLowerCase())
      : undefined;
    if (!chosen && fallbackTeam) {
      if (fallbackTeam === AUTO_FALLBACK) {
        chosen = [...variants].sort((a, b) =>
          (counts.get(b.team.toLowerCase()) || 0) - (counts.get(a.team.toLowerCase()) || 0)
        )[0];
      } else {
        chosen = variants.find(v => v.team.toLowerCase() === fallbackTeam.toLowerCase());
      }
    }
    targets.push({ episode, variant: chosen });
  }

  const toFetch = targets.filter(item => item.variant && !item.variant.video);
  let checked = 0;
  for (const { episode, variant } of targets) {
    if (!variant) {
      episode.video = undefined;
      episode.subtitle = undefined;
      episode.team = undefined;
      continue;
    }
    if (!variant.video) {
      onProgress?.(checked, toFetch.length);
      try { await loadVariant(variant); } catch { /* Keep unavailable if fetch fails. */ }
      checked += 1;
    }
    if (variant.video) {
      episode.video = variant.video;
      episode.subtitle = variant.subtitle;
      episode.team = variant.team;
    } else {
      episode.video = undefined;
      episode.subtitle = undefined;
      episode.team = undefined;
    }
  }
  if (toFetch.length) onProgress?.(toFetch.length, toFetch.length);
  return { ...plan, episodes: [...plan.episodes] };
}

export async function resolveEpisodeVariant(
  plan: SeriesPlan,
  episodePage: string,
  team: string
): Promise<SeriesPlan> {
  const episode = plan.episodes.find(item => item.page === episodePage);
  if (!episode) return plan;
  if (!team) {
    episode.video = undefined;
    episode.subtitle = undefined;
    episode.team = undefined;
    return { ...plan, episodes: [...plan.episodes] };
  }
  const variant = episode.variants?.find(v => v.team.toLowerCase() === team.toLowerCase());
  if (!variant) return plan;
  try { await loadVariant(variant); } catch { /* Keep unavailable if fetch fails. */ }
  if (variant.video) {
    episode.video = variant.video;
    episode.subtitle = variant.subtitle;
    episode.team = variant.team;
  }
  return { ...plan, episodes: [...plan.episodes] };
}
