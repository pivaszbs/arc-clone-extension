import { requestArc } from './client';
import { japaneseCaptions, parseCaptionResponse, subtitleUrl, youtubeTracks } from './captions';
import type { EpisodeDownloads } from './page-captions';
import type { Cue } from './study';

export type PageCaptions = { cues: Cue[]; source: string; downloads?: EpisodeDownloads | null; body?: string };

export class AutoSubtitles {
  cues: Cue[] = [];
  source = '';
  body = '';
  downloads: EpisodeDownloads | null = null;
  private key = '';
  private generation = 0;
  private attempts = new Map<string, number>();
  private hidden = new Map<TextTrack, TextTrackMode>();
  private scanning = false;
  private resourceStart = performance.now();
  private nextPageAttempt = 0;
  constructor(private readonly loadEpisodeCaptions?: () => Promise<PageCaptions | null>) {}
  reset(key = '') {
    if (this.key) this.resourceStart = performance.now();
    this.generation++; this.key = key; this.cues = []; this.source = ''; this.attempts.clear(); this.scanning = false;
    this.nextPageAttempt = 0;
    this.downloads = null; this.body = '';
    for (const [track, previous] of this.hidden) if (track.mode === 'hidden') track.mode = previous;
    this.hidden.clear();
  }
  async scan(video?: HTMLVideoElement | null) {
    const key = `${location.href}|${video?.currentSrc || ''}`;
    if (key !== this.key) this.reset(key);
    if (this.scanning) return;
    const generation = this.generation;
    this.scanning = true;
    try {
      if (this.cues.length && this.source === 'Episode subtitle download') return;
      if (this.loadEpisodeCaptions && !this.cues.length && Date.now() >= this.nextPageAttempt) {
        this.nextPageAttempt = Date.now() + 10000;
        const episode = await this.loadEpisodeCaptions().catch(() => null);
        if (generation !== this.generation) return;
        this.downloads = episode?.downloads ?? null;
        if (episode?.cues.length) {
          this.cues = episode.cues;
          this.source = episode.source;
          this.body = episode.body || '';
          return;
        }
      }
      if (video) {
        for (const track of Array.from(video.textTracks)) {
          const japanese = /^ja(?:[-_]|$)/i.test(track.language) || /日本語|japanese/i.test(track.label);
          if (japanese && track.mode === 'disabled') { this.hidden.set(track, track.mode); track.mode = 'hidden'; }
          const cues = Array.from(track.cues || []).flatMap((cue) => {
            const text = (cue as VTTCue).text;
            return typeof text === 'string' ? [{ start: cue.startTime, end: cue.endTime, text: text.replace(/<[^>]*>/g, '') }] : [];
          });
          if (japaneseCaptions(cues, japanese)) { this.cues = cues; this.source = 'Player’s Japanese subtitles'; return; }
        }
      }
      if (this.cues.length) return;
      const candidates: { url: string; label: string; japanese: boolean }[] = [];
      if (video) {
        for (const track of Array.from(video.querySelectorAll('track[src]'))) {
          const language = track.getAttribute('srclang') || '';
          if (language && !/^ja(?:[-_]|$)/i.test(language)) continue;
          const url = new URL(track.getAttribute('src')!, location.href).href;
          if (subtitleUrl(url)) candidates.push({ url, label: 'Player subtitle file', japanese: /^ja/i.test(language) });
        }
      }

      // Check page links for direct subtitle download buttons (e.g. smotret-anime.com /translations/ass/<id>?download=1)
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
        try {
          const href = new URL(a.getAttribute('href') || '', location.href).href;
          if (subtitleUrl(href) && !candidates.some((c) => c.url === href)) {
            const labelText = (a.innerText || a.textContent || '').trim();
            const isAssLink = /\/translations\/(?:ass|ssa|srt|vtt)\/\d+/i.test(href) || /субтитр|subtitle/i.test(labelText);
            candidates.push({
              url: href,
              label: isAssLink ? 'Smotret-Anime ASS Subtitles' : 'Page subtitle link',
              japanese: isAssLink || /yaponsk|japan|日本語/i.test(location.href + ' ' + labelText)
            });
          }
        } catch {
          // ignore malformed href
        }
      }

      // Check smotret-anime.com URL slug for translation ID (e.g. .../yaponskie-subtitry-5842632)
      if (/smotret-anime\.|anime365\./i.test(location.hostname)) {
        const slugMatch = location.pathname.match(/-(\d{4,10})\/?$/);
        if (slugMatch) {
          const constructedAssUrl = `${location.origin}/translations/ass/${slugMatch[1]}?download=1`;
          if (subtitleUrl(constructedAssUrl) && !candidates.some((c) => c.url === constructedAssUrl)) {
            candidates.push({
              url: constructedAssUrl,
              label: `Smotret-Anime ASS (#${slugMatch[1]})`,
              japanese: true
            });
          }
        }
      }

      if (/(^|\.)youtube\.com$/.test(location.hostname)) {
        const videoId = new URL(location.href).searchParams.get('v') || location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
        for (const script of Array.from(document.scripts)) {
          const text = script.textContent || '';
          if (videoId && text.length < 5000000 && text.includes('captionTracks')) for (const track of youtubeTracks(text, videoId)) candidates.push({ ...track, japanese: true });
        }
      }
      for (const resource of performance.getEntriesByType('resource').slice(-500)) {
        if (resource.startTime >= this.resourceStart && subtitleUrl(resource.name)) candidates.push({ url: resource.name, label: 'Japanese subtitles found in player traffic', japanese: /[?&]lang=ja(?:&|$)/.test(resource.name) });
      }
      for (const candidate of candidates.slice(0, 20)) {
        if (generation !== this.generation) return;
        const last = this.attempts.get(candidate.url);
        if (last !== undefined && Date.now() - last < 30000) continue;
        this.attempts.set(candidate.url, Date.now());
        try {
          const response = await requestArc({ type: 'JAPANESE_FETCH_CAPTIONS', url: candidate.url });
          if (generation !== this.generation) return;
          const cues = parseCaptionResponse(response.body);
          if (japaneseCaptions(cues, candidate.japanese)) {
            this.cues = cues;
            this.body = response.body;
            this.source = `${candidate.label} (${cues.length} lines)`;
            return;
          }
        } catch { /* Try another player-provided source; never grade a missing transcript. */ }
      }
    } finally { if (generation === this.generation) this.scanning = false; }
  }
}
