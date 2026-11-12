import { japaneseCaptions, parseCaptionResponse, subtitleUrl } from './captions';

export function isAnimeSubtitleSite(host: string) {
  return ['smotret-anime.com', 'smotret-anime.net'].some(domain => host === domain || host.endsWith('.' + domain));
}

export interface EpisodeDownloads {
  video?: { url: string; height: number };
  subtitle?: string;
}

function translationId(page: URL) {
  return page.pathname.match(/^\/translations\/embed\/(\d+)\/?$/)?.[1]
    || page.pathname.match(/-(\d{4,10})\/?$/)?.[1];
}

export function findEpisodeDownloads(links: Iterable<{ href: string; textContent: string | null }>, page: URL): EpisodeDownloads | null {
  if (!isAnimeSubtitleSite(page.hostname)) return null;
  const episodeId = translationId(page);
  let video: { url: string; height: number } | undefined;
  let subtitle: string | undefined;
  for (const link of links) {
    let url: URL;
    try { url = new URL(link.href, page); } catch { continue; }
    if (url.origin !== page.origin) continue;
    const match = url.pathname.match(/^\/translations\/(mp4|ass|ssa|srt|vtt)\/(\d+)\/?$/i);
    if (!match || (episodeId && match[2] !== episodeId)) continue;
    if (match[1].toLowerCase() === 'mp4') {
      const height = Number(url.searchParams.get('height') || link.textContent?.match(/(\d{3,4})\s*p\b/i)?.[1] || 0);
      if (Number.isFinite(height) && height >= 0 && (!video || height > video.height)) video = { url: url.href, height };
    } else if (subtitleUrl(url.href) && (!subtitle || url.searchParams.get('download') === '1')) {
      subtitle = url.href;
    }
  }
  return video || subtitle ? { video, subtitle } : null;
}

export async function loadPageCaptions(doc: Document) {
  const page = new URL(doc.URL);
  if (!isAnimeSubtitleSite(page.hostname)) return null;
  const downloads = findEpisodeDownloads(doc.querySelectorAll<HTMLAnchorElement>('a[href]'), page);
  const episodeId = translationId(page);
  const links = new Map<string, number>();
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!subtitleUrl(link.href)) continue;
    const url = new URL(link.href);
    if (url.origin !== page.origin) continue;
    const id = url.pathname.match(/^\/translations\/(?:ass|ssa|srt|vtt)\/(\d+)\/?$/i)?.[1];
    if (!id || (episodeId && id !== episodeId)) continue;
    const isDownload = url.searchParams.get('download') === '1' || link.hasAttribute('download')
      || /скачать\s+субтитры|download\s+subtitles/i.test(link.textContent || '');
    links.set(url.href, Number(isDownload));
  }
  const candidates = [...links].sort((a, b) => b[1] - a[1]).map(([url]) => url);
  if (episodeId) {
    const direct = new URL(`/translations/ass/${episodeId}?download=1`, page).href;
    if (!links.has(direct)) candidates.unshift(direct);
  }

  for (const url of candidates.slice(0, 5)) {
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok || Number(response.headers.get('content-length')) > 5000000) continue;
      const body = await response.text();
      if (doc.URL !== page.href) return null;
      if (body.length > 5000000) continue;
      const cues = parseCaptionResponse(body);
      if (japaneseCaptions(cues)) return { cues, source: 'Episode subtitle download', downloads: { ...downloads, subtitle: url }, body };
    } catch { /* Try another link from this episode. */ }
  }
  return downloads ? { cues: [], source: '', downloads } : null;
}

/**
 * Find the next episode of the current Anime365 series from the episode page's links.
 * Keeps the edition category (for example Japanese subtitles) so the site picks a matching translation.
 */
export function findNextEpisode(doc: { querySelectorAll(selector: string): Iterable<{ href: string; textContent: string | null; getAttribute(name: string): string | null }> }, page: URL): string | null {
  if (!isAnimeSubtitleSite(page.hostname)) return null;
  const series = page.pathname.match(/^\/catalog\/[\w-]+-\d+/)?.[0];
  if (!series) return null;
  const [current, edition] = page.pathname.slice(series.length).split('/').filter(Boolean);
  if (!current) return null;
  const category = edition?.replace(/-\d+$/, '');
  const target = (slug: string) => new URL(`${series}/${slug}${category ? `/${category}` : ''}`, page).href;
  const slugs = new Set<string>();
  let labelled: string | undefined;
  for (const link of doc.querySelectorAll('a[href]')) {
    let url: URL;
    try { url = new URL(link.href, page); } catch { continue; }
    if (url.origin !== page.origin || !url.pathname.startsWith(series + '/')) continue;
    const slug = url.pathname.slice(series.length + 1).split('/')[0];
    if (!/^[\w-]+-\d+$/.test(slug)) continue;
    slugs.add(slug);
    const label = [link.textContent, link.getAttribute('title'), link.getAttribute('aria-label')].join(' ');
    if (slug !== current && /следующ|next\s+episode|next\b/i.test(label)) labelled ??= slug;
  }
  if (labelled) return target(labelled);
  slugs.add(current);
  const ordered = [...slugs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const next = ordered[ordered.indexOf(current) + 1];
  return next ? target(next) : null;
}
