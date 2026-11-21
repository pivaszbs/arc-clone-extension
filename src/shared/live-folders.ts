export interface LiveFeedEntry {
  title: string;
  url: string;
  subtitle?: string;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tagValue(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function atomLink(block: string): string {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (alt?.[1]) return decodeEntities(alt[1]);
  const href = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (href?.[1]) return decodeEntities(href[1]);
  return tagValue(block, 'link');
}

export function parseLiveFeed(content: string, limit = 15): LiveFeedEntry[] {
  const text = content.trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];
      const entries: LiveFeedEntry[] = [];
      for (const row of list.slice(0, limit)) {
        const url = String(row?.html_url || row?.url || row?.link || '').trim();
        const title = String(row?.title || row?.name || url).trim();
        if (!url) continue;
        const subtitle = row?.user?.login
          ? `@${row.user.login}`
          : typeof row?.subtitle === 'string'
            ? row.subtitle
            : undefined;
        entries.push({ title, url, subtitle });
      }
      return entries;
    } catch {
      return [];
    }
  }

  const out: LiveFeedEntry[] = [];
  const itemMatches = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  if (itemMatches.length > 0) {
    for (const m of itemMatches.slice(0, limit)) {
      const block = m[0];
      const title = tagValue(block, 'title');
      const url = tagValue(block, 'link') || tagValue(block, 'guid');
      if (url.startsWith('http')) {
        out.push({ title: title || url, url });
      }
    }
    return out;
  }

  const entryMatches = [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
  for (const m of entryMatches.slice(0, limit)) {
    const block = m[0];
    const title = tagValue(block, 'title');
    const url = atomLink(block);
    const author = tagValue(block, 'name');
    if (url.startsWith('http')) {
      out.push({ title: title || url, url, subtitle: author || undefined });
    }
  }
  return out;
}
