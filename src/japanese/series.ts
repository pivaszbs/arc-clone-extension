import { japaneseCaptions, parseCaptionResponse } from './captions';
import { findEpisodeDownloads, isAnimeSubtitleSite } from './page-captions';
import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from 'parse5';

export interface SeriesEpisode {
  page: string;
  label: string;
  video?: { url: string; height: number };
  subtitle?: string;
}

export interface SeriesPlan {
  series: string;
  title: string;
  edition?: string;
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

type CatalogLink = { href: string; textContent: string; className: string };
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

function editionLink(page: CatalogPage & { url: URL }, episode: URL, category: string, team?: string) {
  const prefix = `${episode.pathname}/${category}-`;
  let fallback: { url: URL; label: string } | null = null;
  for (const anchor of page.links) {
    let link: URL;
    try { link = new URL(anchor.href, page.url); } catch { continue; }
    if (link.origin !== episode.origin || !link.pathname.startsWith(prefix) || !/^\d+\/?$/.test(link.pathname.slice(prefix.length))) continue;
    const label = anchor.textContent;
    if (!label) continue;
    if (team && label.toLowerCase() === team.toLowerCase()) return { url: link, label };
    if (team || link.pathname !== page.url.pathname) continue;
    if (anchor.className.split(/\s+/).includes('truncate')) return { url: link, label };
    fallback ??= { url: link, label };
  }
  return fallback;
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
      if (team && !isSelectedEpisode) {
        const match = editionLink(page, episodeUrl, category, team);
        if (!match) continue;
        if (match.url.pathname !== page.url.pathname) page = await readPage(match.url);
        if (page.url.pathname !== match.url.pathname) continue;
      }
      const { links, url } = page;
      if (url.pathname !== variant.pathname && !url.pathname.startsWith(variant.pathname + '-')) continue;
      if (isSelectedEpisode && exactEdition && url.pathname !== source.pathname) continue;
      const downloads = findEpisodeDownloads(links, url);
      if (!downloads?.video) continue;
      if (!studyEdition) {
        episode.video = downloads.video;
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
  return { series: series.href, title: catalog.title || series.pathname.split('/').at(-1)!, edition, episodes: list };
}
