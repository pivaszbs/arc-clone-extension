// The TV set itself (power, volume, keys) through the Mac (native/tv/samsung_remote.py), and the
// Movies & TV catalog the Mac relays (native/tv/stremio.py).
import { normalizeTvServerUrl } from './tv-sync';

export type TvDevice = {
  known: boolean;
  ip?: string;
  /** The Mac has the TV's remote-control token (the TV's Allow prompt was accepted). */
  paired?: boolean;
  /** The TV is showing its Allow prompt right now. */
  pairing?: boolean;
  power?: 'on' | 'standby' | 'off';
  name?: string;
  model?: string;
  /** The Anime Study app is open on the TV and connected to the Mac. */
  appOpen?: boolean;
};

export type TvKey =
  | 'KEY_POWER' | 'KEY_VOLUP' | 'KEY_VOLDOWN' | 'KEY_MUTE' | 'KEY_UP' | 'KEY_DOWN' | 'KEY_LEFT' | 'KEY_RIGHT'
  | 'KEY_ENTER' | 'KEY_RETURN' | 'KEY_HOME' | 'KEY_SOURCE' | 'KEY_MENU' | 'KEY_INFO' | 'KEY_PLAY' | 'KEY_PAUSE'
  | 'KEY_FF' | 'KEY_REWIND' | 'KEY_EXIT';

export type TvRemoteAction = { key: TvKey } | { power: 'on' | 'off' } | { open: true };

async function request(url: string, init?: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTvDevice(serverUrl: string): Promise<TvDevice> {
  const res = await request(`${normalizeTvServerUrl(serverUrl)}tv/device.json`, undefined, 6000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as TvDevice;
}

/** Sends one action to the TV set. Resolves to an error message, or null when it was sent. */
export async function sendTvRemote(serverUrl: string, action: TvRemoteAction): Promise<string | null> {
  try {
    // Pairing waits for the Allow prompt on the TV, so give the first press time.
    const res = await request(`${normalizeTvServerUrl(serverUrl)}tv/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    }, 40_000);
    if (res.ok) return null;
    const body = await res.json().catch(() => ({})) as { error?: string };
    return body.error || `The Mac answered HTTP ${res.status}`;
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? 'The TV did not answer in time.' : 'The Mac did not answer.';
  }
}

/** A Movies & TV relay call (paths from shared/tv-stremio.ts). */
export async function fetchStremio<T>(serverUrl: string, path: string): Promise<T> {
  const res = await request(`${normalizeTvServerUrl(serverUrl)}${path}`, undefined, 40_000);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export type TvStream = { id: string; title: string; label: string; path: string };

/** Plays a Movies & TV stream on the TV, turning it on and opening Anime Study first when needed. */
export async function playOnTv(serverUrl: string, stream: TvStream): Promise<{ state?: 'playing' | 'starting'; error?: string }> {
  try {
    const res = await request(`${normalizeTvServerUrl(serverUrl)}tv/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream }),
    });
    const body = await res.json().catch(() => ({})) as { state?: 'playing' | 'starting'; error?: string };
    return res.ok ? body : { error: body.error || `The Mac answered HTTP ${res.status}` };
  } catch {
    return { error: 'The Mac did not answer.' };
  }
}
