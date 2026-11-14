import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';

import { logError } from './crash-log';
import type { Episode, Series } from './library';

/**
 * Copies episodes from the Mac to this device when you tap Download, over the home network.
 * Files go to Documents/<series folder>/, so they appear under Local Files and in the Files app.
 * Nothing is downloaded or deleted on its own.
 */

export type DownloadState =
  | { status: 'queued' }
  | { status: 'downloading'; fraction: number }
  | { status: 'failed'; error: string };

type Job = { folder: string; episode: Episode };

/** Folder and file names come from the Mac; keep them inside Documents. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200);
const keyOf = (folder: string, video: string) => `${folder}/${video}`;

function subtitleExtension(text: string) {
  const head = text.slice(0, 200).replace(/^﻿/, '');
  if (/^\s*\[Script Info\]/i.test(head)) return '.ass';
  if (/^\s*WEBVTT/.test(head)) return '.vtt';
  return '.srt';
}

class EpisodeDownloads {
  private queue: Job[] = [];
  private states = new Map<string, DownloadState>();
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private running = false;
  private revision = 0;
  /** Called after a file is saved or removed, so the local library can be read again. */
  onLibraryChanged: () => void = () => {};

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get version() { return this.revision; }

  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  state(folder: string, video: string) {
    return this.states.get(keyOf(folder, video));
  }

  isOnDevice(folder: string, video: string) {
    try {
      return new File(new Directory(Paths.document, safeName(folder)), safeName(video)).exists;
    } catch { return false; }
  }

  /** Queue episodes of a Mac series that aren't on this device yet. */
  download(series: Series, episodes: Episode[]) {
    for (const episode of episodes) {
      const key = keyOf(series.folder, episode.video);
      const current = this.states.get(key);
      if (this.isOnDevice(series.folder, episode.video) || (current && current.status !== 'failed')) continue;
      this.queue.push({ folder: series.folder, episode });
      this.states.set(key, { status: 'queued' });
    }
    this.changed();
    void this.run();
  }

  /** Stop queued and running downloads of a series (or all of them). */
  cancel(folder?: string) {
    const dropped = this.queue.filter(job => !folder || job.folder === folder);
    this.queue = this.queue.filter(job => folder && job.folder !== folder);
    for (const job of dropped) this.states.delete(keyOf(job.folder, job.episode.video));
    if (this.abort && (!folder || this.current?.folder === folder)) this.abort.abort();
    this.changed();
  }

  /** Remove an episode (video and its subtitles) from this device. */
  remove(folder: string, video: string) {
    const dir = new Directory(Paths.document, safeName(folder));
    try {
      const file = new File(dir, safeName(video));
      if (file.exists) file.delete();
      const stem = safeName(video).replace(/\.[^.]+$/, '');
      for (const ext of ['.ass', '.ssa', '.srt', '.vtt']) {
        const subtitle = new File(dir, stem + ext);
        if (subtitle.exists) subtitle.delete();
      }
      if (dir.exists && !dir.list().some(entry => entry instanceof File && /\.(mp4|m4v|mov)$/i.test(entry.name))) dir.delete();
    } catch (error) {
      logError(`remove ${folder}/${video}`, error);
    }
    this.states.delete(keyOf(folder, video));
    this.changed();
    this.onLibraryChanged();
  }

  private current: Job | null = null;

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        this.current = job;
        const { folder, episode } = job;
        const key = keyOf(folder, episode.video);
        const dir = new Directory(Paths.document, safeName(folder));
        const abort = new AbortController();
        this.abort = abort;
        this.states.set(key, { status: 'downloading', fraction: 0 });
        this.changed();
        try {
          if (!dir.exists) dir.create({ intermediates: true });
          if (episode.subtitleUri) {
            const response = await fetch(episode.subtitleUri, { signal: abort.signal });
            if (response.ok) {
              const text = await response.text();
              new File(dir, safeName(episode.video).replace(/\.[^.]+$/, '') + subtitleExtension(text)).write(text);
            }
          }
          let shown = 0;
          // On iOS the file only appears at its final name once the whole download has succeeded.
          await File.downloadFileAsync(episode.videoUri, new File(dir, safeName(episode.video)), {
            idempotent: true,
            signal: abort.signal,
            onProgress: ({ bytesWritten, totalBytes }) => {
              // Native progress can arrive as BigInt; turn it into a plain number before any arithmetic.
              const total = Number(totalBytes);
              const fraction = total > 0 ? Number(bytesWritten) / total : 0;
              if (fraction - shown < 0.01) return;
              shown = fraction;
              this.states.set(key, { status: 'downloading', fraction });
              this.changed();
            },
          });
          this.states.delete(key);
          this.onLibraryChanged();
        } catch (error) {
          if (abort.signal.aborted) {
            this.states.delete(key);
          } else {
            logError(`download ${key}`, error);
            this.states.set(key, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
          }
        }
        this.changed();
      }
    } finally {
      this.current = null;
      this.abort = null;
      this.running = false;
    }
  }
}

export const episodeDownloads = new EpisodeDownloads();

/** Re-render when any download starts, moves or finishes. */
export function useEpisodeDownloads() {
  const [, setVersion] = useState(episodeDownloads.version);
  useEffect(() => episodeDownloads.subscribe(() => setVersion(episodeDownloads.version)), []);
  return episodeDownloads;
}
