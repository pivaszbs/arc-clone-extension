import type { Cue } from './study';
import type { VideoThemes } from './video-themes';

const companion = 'http://127.0.0.1:46157';
export type CastDevice = { id: string; name: string };
export type CastSession = { id: string; title: string };

async function castRequest<T>(path: string, options: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(companion + path, { credentials: 'omit', ...options });
  } catch {
    throw new Error('The Cast companion is unreachable. Start it with npm run cast:serve.');
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'The Cast companion rejected the request.');
  }
  return response.json();
}

export function findCastDevices() {
  return castRequest<{ devices: CastDevice[]; session?: CastSession }>('/devices', { method: 'POST' });
}

function timestamp(seconds: number) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function webVtt(cues: Cue[]) {
  const captions = cues
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start)
    .map(cue => {
      const text = cue.text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
        .split(/\r?\n/).filter(line => line.trim()).join('\n');
      return `${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${text}`;
    });
  return captions.length ? `WEBVTT\n\n${captions.join('\n\n')}\n` : '';
}

export async function castEpisode(device: string, file: File, title: string, position: number, cues: Cue[]) {
  const type = file.name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const { id } = await castRequest<{ id: string }>('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, title, position, type, subtitles: webVtt(cues) })
  });
  try {
    await castRequest(`/session/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: file
    });
  } catch (error) {
    await stopDirectCast(id).catch(() => {});
    throw error;
  }
  return { id, title };
}

export function stopDirectCast(id: string) {
  return castRequest(`/session/${id}`, { method: 'DELETE' });
}

function airplaySkips(themes: VideoThemes) {
  const legacy = localStorage.getItem('arc-offline-auto-skip') !== 'off';
  return Object.fromEntries((['recap', 'op', 'ed'] as const).flatMap(part => {
    const range = themes[part];
    const saved = localStorage.getItem(`arc-offline-auto-skip-${part}`);
    return range ? [[part, { ...range, auto: saved === null ? part === 'recap' || legacy : saved === 'on' }]] : [];
  }));
}

export async function openSafariAirPlay(file: File, title: string, position: number, cues: Cue[], themes: VideoThemes) {
  const skips = airplaySkips(themes);
  const { id } = await castRequest<{ id: string }>('/airplay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, position, skips, subtitles: webVtt(cues) })
  });
  try {
    await castRequest(`/airplay/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    return id;
  } catch (error) {
    await stopSafariAirPlay(id).catch(() => {});
    throw error;
  }
}

export async function updateSafariAirPlay(id: string, file: File, title: string, position: number, cues: Cue[], themes: VideoThemes) {
  const skips = airplaySkips(themes);
  await castRequest(`/airplay/${id}/episode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, position, skips, subtitles: webVtt(cues) })
  });
  await castRequest(`/airplay/${id}/episode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  });
}

export function stopSafariAirPlay(id: string) {
  return castRequest(`/airplay/${id}`, { method: 'DELETE' });
}
