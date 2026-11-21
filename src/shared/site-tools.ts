// Air Traffic Control routes, Site Search templates and Boosts: the pure rules, shared by
// the background worker, the sidebar editor and the tests.

export interface RoutingRule {
  id: string;
  /** A host ("github.com") or a host with a path prefix ("google.com/maps"). */
  pattern: string;
  spaceId: string;
}

export interface SiteSearch {
  id: string;
  name: string;
  /** Typed before the query in the command bar: "yt lofi". */
  shortcut: string;
  /** Search URL with %s where the query goes. */
  url: string;
}

export type BoostTextCase = 'none' | 'upper' | 'lower' | 'capitalize';

export interface Boost {
  id: string;
  /** Host the CSS applies to, subdomains included. */
  host: string;
  name?: string;
  css: string;
  enabled: boolean;
  tintColor?: string;
  hue?: number;
  tintIntensity?: number;
  invert?: boolean;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  fontFamily?: string;
  fontSize?: number;
  textCase?: BoostTextCase;
  zappedSelectors?: string[];
  js?: string;
}

export function compileBoostCss(boost: Boost): string {
  const parts: string[] = [];

  if (boost.zappedSelectors && boost.zappedSelectors.length > 0) {
    const valid = boost.zappedSelectors.map((s) => s.trim()).filter(Boolean);
    if (valid.length > 0) {
      parts.push(`${valid.join(', ')} { display: none !important; }`);
    }
  }

  const filters: string[] = [];
  if (boost.invert) filters.push('invert(1) hue-rotate(180deg)');
  if (typeof boost.hue === 'number' && boost.hue !== 0) {
    filters.push(`hue-rotate(${Math.round(boost.hue)}deg)`);
  }
  if (typeof boost.brightness === 'number' && boost.brightness !== 100 && boost.brightness !== 50) {
    filters.push(`brightness(${Math.max(20, Math.min(250, boost.brightness))}%)`);
  }
  if (typeof boost.contrast === 'number' && boost.contrast !== 100) {
    filters.push(`contrast(${Math.max(20, Math.min(250, boost.contrast))}%)`);
  }
  if (typeof boost.saturate === 'number' && boost.saturate !== 100) {
    filters.push(`saturate(${Math.max(0, Math.min(300, boost.saturate))}%)`);
  }
  if (filters.length > 0) {
    parts.push(`html { filter: ${filters.join(' ')} !important; }`);
    if (boost.invert) {
      parts.push('img, video, picture, canvas, svg { filter: invert(1) hue-rotate(180deg) !important; }');
    }
  }

  if (boost.tintColor && (boost.tintIntensity ?? 0) > 0) {
    const alpha = Math.max(0.05, Math.min(0.65, (boost.tintIntensity ?? 25) / 100));
    parts.push(
      `html::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 2147483640; background: ${boost.tintColor}; opacity: ${alpha.toFixed(2)}; mix-blend-mode: multiply; }`
    );
  }

  const bodyRules: string[] = [];
  if (boost.fontFamily && boost.fontFamily !== 'default') {
    bodyRules.push(`font-family: ${boost.fontFamily} !important;`);
  }
  if (typeof boost.fontSize === 'number' && boost.fontSize !== 100) {
    bodyRules.push(`font-size: ${Math.max(60, Math.min(200, boost.fontSize))}% !important;`);
  }
  if (boost.textCase && boost.textCase !== 'none') {
    const tf = boost.textCase === 'upper' ? 'uppercase' : boost.textCase === 'lower' ? 'lowercase' : 'capitalize';
    bodyRules.push(`text-transform: ${tf} !important;`);
  }
  if (bodyRules.length > 0) {
    parts.push(`body, body * { ${bodyRules.join(' ')} }`);
  }

  if (boost.css && boost.css.trim()) {
    parts.push(boost.css);
  }
  return parts.join('\n').trim();
}

export const DEFAULT_SITE_SEARCHES: SiteSearch[] = [
  { id: 'site-youtube', name: 'YouTube', shortcut: 'yt', url: 'https://www.youtube.com/results?search_query=%s' },
  { id: 'site-wikipedia', name: 'Wikipedia', shortcut: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { id: 'site-github', name: 'GitHub', shortcut: 'gh', url: 'https://github.com/search?q=%s' },
  { id: 'site-reddit', name: 'Reddit', shortcut: 'r', url: 'https://www.reddit.com/search/?q=%s' },
  { id: 'site-duckduckgo', name: 'DuckDuckGo', shortcut: 'ddg', url: 'https://duckduckgo.com/?q=%s' }
];

/** "https://www.GitHub.com/foo/" -> "github.com/foo" */
export function normalizePattern(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

const hostMatches = (host: string, wanted: string) =>
  Boolean(wanted) && (host === wanted || host.endsWith(`.${wanted}`));

function patternMatches(pattern: string, url: string): boolean {
  const host = hostOf(url);
  const wanted = normalizePattern(pattern);
  if (!host || !wanted) return false;
  const slash = wanted.indexOf('/');
  if (slash < 0) return hostMatches(host, wanted);
  if (!hostMatches(host, wanted.slice(0, slash))) return false;
  const prefix = wanted.slice(slash);
  const path = new URL(url).pathname.toLowerCase();
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The most specific matching rule wins: the longest pattern. */
export function routeFor(rules: RoutingRule[] | undefined, url: string): RoutingRule | undefined {
  return (rules || [])
    .filter((rule) => patternMatches(rule.pattern, url))
    .sort((a, b) => normalizePattern(b.pattern).length - normalizePattern(a.pattern).length)[0];
}

export function siteSearchUrl(site: SiteSearch, terms: string): string {
  return site.url.replace(/%s/g, encodeURIComponent(terms.trim()));
}

/** "yt lofi beats" -> YouTube + "lofi beats". The full site name works as well as its shortcut. */
export function matchSiteSearch(sites: SiteSearch[] | undefined, query: string): { site: SiteSearch; terms: string } | undefined {
  const match = query.trim().match(/^(\S+)\s+(.+)$/);
  if (!match) return;
  const key = match[1].toLowerCase();
  const site = (sites || []).find((entry) => entry.shortcut.toLowerCase() === key)
    || (sites || []).find((entry) => entry.name.toLowerCase() === key);
  return site ? { site, terms: match[2].trim() } : undefined;
}

/** Sites whose shortcut or name starts with what has been typed so far (no query yet). */
export function suggestSiteSearches(sites: SiteSearch[] | undefined, query: string): SiteSearch[] {
  const key = query.trim().toLowerCase();
  if (!key || /\s/.test(key)) return [];
  return (sites || []).filter((site) =>
    site.shortcut.toLowerCase().startsWith(key) || site.name.toLowerCase().startsWith(key));
}

export function validSiteSearchUrl(url: string): boolean {
  if (!url.includes('%s')) return false;
  try { return /^https?:$/.test(new URL(url.replace(/%s/g, 'x')).protocol); } catch { return false; }
}

export function boostsFor(boosts: Boost[] | undefined, url: string): Boost[] {
  const host = hostOf(url);
  if (!host) return [];
  return (boosts || []).filter((boost) =>
    boost.enabled && Boolean(compileBoostCss(boost).trim()) && hostMatches(host, normalizePattern(boost.host).split('/')[0]));
}
