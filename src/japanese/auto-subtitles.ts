import { requestArc } from './client';
import { japaneseCaptions, parseCaptionResponse, subtitleUrl, youtubeTracks } from './captions';
import type { Cue } from './study';

export class AutoSubtitles {
  cues: Cue[] = [];
  source = '';
  private key = '';
  private generation = 0;
  private attempts = new Map<string, number>();
  private hidden = new Map<TextTrack, TextTrackMode>();
  private scanning = false;
  private resourceStart = performance.now();
  reset(key = '') {
    if (this.key) this.resourceStart = performance.now();
    this.generation++; this.key = key; this.cues = []; this.source = ''; this.attempts.clear(); this.scanning = false;
    for (const [track, previous] of this.hidden) if (track.mode === 'hidden') track.mode = previous;
    this.hidden.clear();
  }
  async scan(video: HTMLVideoElement) {
    const key = `${location.href}|${video.currentSrc}`;
    if (key !== this.key) this.reset(key);
    if (this.scanning) return;
    const generation = this.generation;
    this.scanning = true;
    try {
      for (const track of Array.from(video.textTracks)) {
        const japanese = /^ja(?:[-_]|$)/i.test(track.language) || /日本語|japanese/i.test(track.label);
        if (japanese && track.mode === 'disabled') { this.hidden.set(track, track.mode); track.mode = 'hidden'; }
        const cues = Array.from(track.cues || []).flatMap((cue) => {
          const text = (cue as VTTCue).text;
          return typeof text === 'string' ? [{ start: cue.startTime, end: cue.endTime, text: text.replace(/<[^>]*>/g, '') }] : [];
        });
        if (japaneseCaptions(cues, japanese)) { this.cues = cues; this.source = 'Player’s Japanese subtitles'; return; }
      }
      if (this.cues.length) return;
      const candidates: { url: string; label: string; japanese: boolean }[] = [];
      for (const track of Array.from(video.querySelectorAll('track[src]'))) {
        const language = track.getAttribute('srclang') || '';
        if (language && !/^ja(?:[-_]|$)/i.test(language)) continue;
        const url = new URL(track.getAttribute('src')!, location.href).href;
        if (subtitleUrl(url)) candidates.push({ url, label: 'Player subtitle file', japanese: /^ja/i.test(language) });
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
          if (japaneseCaptions(cues, candidate.japanese)) { this.cues = cues; this.source = candidate.label; return; }
        } catch { /* Try another player-provided source; never grade a missing transcript. */ }
      }
    } finally { if (generation === this.generation) this.scanning = false; }
  }
}
