<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import JapaneseStudy from './JapaneseStudy.svelte';
  import SeriesDownloads from './SeriesDownloads.svelte';
  import { parseCaptionResponse } from './captions';
  import type { Cue } from './study';
  import type { VideoThemes } from './video-themes';
  import { VideoThemeQueue, type ScanStatus } from './video-theme-queue';
  import { DesktopVideoStream } from '../video/desktop-stream';
  import { directoryPicker, isEpisodeVideo, readEpisodeFolders, rememberFolder, rememberedFolder, type DownloadFolder, type EpisodeFolder } from './offline-library';

  const preferredParams = new URLSearchParams(location.search).get('series');
  const preferredId = preferredParams?.match(/\/catalog\/[^/]+\/[^/]+\/[^/]+-(\d+)\/?$/)?.[1];
  const preferredEpisodeNumber = Number(preferredParams?.match(/\/catalog\/[^/]+\/(\d+)-seriya-\d+(?:\/|$)/)?.[1] || 0);

  let videoUrl = $state('');
  let fileName = $state('');
  let mediaError = $state(false);
  let localCues = $state<Cue[]>([]);
  let referenceCues = $state<Cue[][]>([]);
  let videoThemes = $state<VideoThemes>({});
  let scanQueue = $state<VideoThemeQueue>();
  let scanStatus = $state<ScanStatus>();
  let scanPaused = $state(false);
  let scanFolder = $state<DownloadFolder>();
  let scanSeries: string | undefined;
  let localBody = $state('');
  let localSource = $state('');
  let episodes = $state<{ path: string; video: File; subtitle?: File }[]>([]);
  let selected = $state('');
  let opening = 0;
  let progressReady = false;
  let lastProgressSave = 0;
  let resumePosition = 0;
  let player = $state<HTMLDivElement>();
  let video = $state<HTMLVideoElement>();
  let fullscreen = $state(false);
  let fullscreenError = $state(false);
  const desktopPipAvailable = /Mac/i.test(navigator.platform);
  let desktopStream: DesktopVideoStream | undefined;
  let desktopPipActive = $state(false);
  let desktopPipStarting = $state(false);
  let desktopPipReady = $state(false);
  let desktopPipError = $state('');
  let learning = $state(false);
  let studying = $state(false);
  let overlayHidden = $state(false);
  let revealOverlayAfter = 0;
  let folder = $state<DownloadFolder>();
  let folderGranted = $state(false);
  let folderBusy = $state(false);
  let folderStatus = $state('');
  let episodeFolders = $state<EpisodeFolder[]>([]);
  let selectedFolder = $state<string>();
  const episodeIndex = $derived(episodes.findIndex(item => item.path === selected));
  const savedPosition = $derived(episodes[episodeIndex] ? episodeProgress(episodes[episodeIndex].video)?.position || 0 : 0);

  function fileIdentity(file: File) {
    return `arc-offline:${encodeURIComponent(file.name)}/${file.size}/${file.lastModified}`;
  }

  // v2 themes have second-accurate edges snapped to picture cuts. v1 results are only a fallback until rechecked.
  function themeStorageKey(id: string, version = 2) {
    return `${id}:video-themes-v${version}`;
  }

  function storedThemes(id: string, legacy = true): VideoThemes {
    try {
      const saved = localStorage.getItem(themeStorageKey(id)) || (legacy ? localStorage.getItem(themeStorageKey(id, 1)) : null);
      return JSON.parse(saved || '{}');
    } catch { return {}; }
  }

  function rememberScanQueue() {
    try {
      if (scanQueue && scanFolder) {
        sessionStorage.setItem('arc-theme-queue', JSON.stringify({ folder: scanFolder.name, series: scanSeries, paused: scanPaused }));
      } else sessionStorage.removeItem('arc-theme-queue');
    } catch { /* The open tab can still run the queue. */ }
  }

  function queueFiles(files: File[]) {
    const ordered = files.filter(file => isEpisodeVideo(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    scanQueue?.update(ordered.map(file => ({ file, id: fileIdentity(file) })));
  }

  function startScanQueue(series = selectedFolder, paused = false) {
    if (scanQueue) return;
    scanFolder = folderGranted ? folder : undefined;
    scanSeries = series;
    scanPaused = paused;
    const queue = new VideoThemeQueue(status => {
      if (scanQueue === queue) scanStatus = status;
    }, (id, match) => {
      if (scanQueue !== queue || !match.op && !match.ed) return;
      const previous = storedThemes(id, false);
      const found = { op: previous.op ?? match.op, ed: previous.ed ?? match.ed };
      if (id === localSource) videoThemes = { op: found.op ?? videoThemes.op, ed: found.ed ?? videoThemes.ed };
      try { localStorage.setItem(themeStorageKey(id), JSON.stringify(found)); } catch { /* Playback still uses the current match. */ }
    });
    scanQueue = queue;
    queue.setPaused(paused);
    queueFiles(scanFolder ? episodeFolders.find(entry => entry.key === scanSeries)?.files || [] : episodes.map(episode => episode.video));
    rememberScanQueue();
  }

  function toggleScanQueue() {
    if (!scanQueue) { startScanQueue(); return; }
    scanPaused = !scanPaused;
    scanQueue.setPaused(scanPaused);
    rememberScanQueue();
  }

  function stopScanQueue() {
    scanQueue?.stop();
    scanQueue = undefined;
    scanFolder = undefined;
    scanStatus = undefined;
    rememberScanQueue();
  }

  function restoreScanQueue(handle: DownloadFolder) {
    if (scanQueue) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem('arc-theme-queue') || 'null');
      if (saved?.folder === handle.name) startScanQueue(saved.series, saved.paused === true);
    } catch { /* The queue can be started again from the library. */ }
  }

  type Progress = { position: number; watchedAt: number; finished: boolean };

  function episodeProgress(file: File): Progress | undefined {
    try {
      const saved = localStorage.getItem(`${fileIdentity(file)}:progress`);
      if (saved) return JSON.parse(saved);
    } catch { /* Playback can still work without storage. */ }
  }

  function saveProgress(force = false) {
    if (!progressReady || !video || video.currentSrc !== videoUrl || video.seeking) return;
    const watchedAt = Date.now();
    if (!force && (video.paused || watchedAt - lastProgressSave < 3000)) return;
    const position = video.ended ? 0 : video.currentTime;
    if (!Number.isFinite(position) || position === 0 && !video.ended && !lastProgressSave && !resumePosition) return;
    try {
      const progress: Progress = { position, watchedAt, finished: video.ended };
      localStorage.setItem(`${localSource}:progress`, JSON.stringify(progress));
      lastProgressSave = watchedAt;
    } catch { /* Playback can still work without storage. */ }
  }

  function restoreProgress() {
    if (!video || video.currentSrc !== videoUrl) return;
    if (resumePosition > 0 && resumePosition < video.duration) video.currentTime = resumePosition;
    progressReady = true;
  }

  function latestWatched<T>(items: T[], files: (item: T) => File[]) {
    let latest: T | undefined;
    let watchedAt = 0;
    for (const item of items) {
      for (const file of files(item)) {
        const progress = episodeProgress(file);
        if (progress && progress.watchedAt > watchedAt) {
          latest = item;
          watchedAt = progress.watchedAt;
        }
      }
    }
    return latest;
  }

  function setEpisodeFiles(files: File[]) {
    const path = (file: File) => file.webkitRelativePath || file.name;
    const stem = (file: File) => path(file).replace(/\.[^.]+$/, '');
    const subtitles = new Map(files.filter(file => /\.(ass|ssa|srt|vtt)$/i.test(file.name)).map(file => [stem(file), file]));
    episodes = files.filter(file => isEpisodeVideo(file.name))
      .sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true }))
      .map(video => ({ path: path(video), video, subtitle: subtitles.get(stem(video)) }));
    if (!episodes.some(item => item.path === selected)) {
      const preferred = episodes.find(item => matchesPreferredEpisode(item.video));
      const latest = latestWatched(episodes, item => [item.video]);
      const next = latest && episodeProgress(latest.video)?.finished ? episodes[episodes.indexOf(latest) + 1] : undefined;
      selected = (preferred || next || latest || episodes[0])?.path || '';
    }
  }

  function matchesPreferredEpisode(file: File) {
    if (preferredId && file.name.match(/ - (\d+)(?: \(\d+\))?\.[^.]+$/)?.[1] === preferredId) return true;
    const episodeNumber = Number(file.name.match(/^Episode\s+(\d+)\b/i)?.[1] || 0);
    return preferredEpisodeNumber > 0 && episodeNumber === preferredEpisodeNumber;
  }

  function rememberSelectedEpisode(file: File) {
    try {
      const existing = episodeProgress(file);
      const progress: Progress = {
        position: existing?.finished ? 0 : (existing?.position || 0),
        watchedAt: Date.now(),
        finished: false
      };
      localStorage.setItem(`${fileIdentity(file)}:progress`, JSON.stringify(progress));
    } catch { /* Playback can still work without storage. */ }
  }

  function resumeRememberedEpisode() {
    const episode = episodes[episodeIndex];
    if (!episode) return false;
    if (preferredId || preferredEpisodeNumber) {
      if (!matchesPreferredEpisode(episode.video)) return false;
    } else {
      const latest = latestWatched(episodes, item => [item.video]);
      if (!latest || (latest.path === episode.path && episodeProgress(latest.video)?.finished)) return false;
    }
    selectEpisode(true);
    return true;
  }

  async function refreshFolder(handle: DownloadFolder) {
    const found = await readEpisodeFolders(handle);
    if (folder !== handle) return;
    episodeFolders = found;
    const chosen = found.find(entry => entry.key === selectedFolder)
      || found.find(entry => entry.files.some(file => isEpisodeVideo(file.name) && matchesPreferredEpisode(file)))
      || latestWatched(found, entry => entry.files.filter(file => isEpisodeVideo(file.name)))
      || found[0];
    if (chosen?.key !== selectedFolder) selected = '';
    selectedFolder = chosen?.key;
    setEpisodeFiles(chosen?.files || []);
    folderStatus = episodes.length ? '' : 'No finished videos in this folder yet.';
    if (scanQueue && scanFolder === handle) {
      if (scanSeries === undefined && chosen) {
        scanSeries = chosen.key;
        rememberScanQueue();
      }
      queueFiles(found.find(entry => entry.key === scanSeries)?.files || []);
    }
  }

  function switchEpisodeFolder() {
    const chosen = episodeFolders.find(entry => entry.key === selectedFolder);
    if (!chosen) return;
    selected = '';
    setEpisodeFiles(chosen.files);
    if (videoUrl) selectEpisode(true);
  }

  async function chooseFolder(reconnect = false) {
    if (!directoryPicker || folderBusy) return;
    folderBusy = true;
    try {
      const handle = reconnect && folder ? folder : await directoryPicker({ id: 'arc-offline', mode: 'read', startIn: 'downloads' });
      if (reconnect && await handle.requestPermission({ mode: 'read' }) !== 'granted') return;
      if (!reconnect && scanQueue) stopScanQueue();
      folder = handle;
      folderGranted = true;
      selected = '';
      selectedFolder = undefined;
      await refreshFolder(handle);
      if (reconnect) restoreScanQueue(handle);
      void rememberFolder(handle).catch(() => { folderStatus = 'This folder could not be remembered for next time.'; });
      if (reconnect && resumeRememberedEpisode()) return;
      if ((preferredId || preferredEpisodeNumber) ? episodes.some(item => matchesPreferredEpisode(item.video)) : episodeFolders.length === 1) selectEpisode(true);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') folderStatus = 'Could not open that folder. Choose the downloaded series folder.';
    } finally { folderBusy = false; }
  }

  onMount(() => {
    let mounted = true;
    if (directoryPicker) void rememberedFolder().then(async handle => {
      if (!mounted || folder || folderBusy || !handle) return;
      folder = handle;
      const granted = await handle.queryPermission({ mode: 'read' }) === 'granted';
      if (!mounted || folder !== handle) return;
      folderGranted = granted;
      if (granted) {
        await refreshFolder(handle);
        if (mounted && folder === handle) {
          restoreScanQueue(handle);
          if (!videoUrl && !opening && !folderBusy) resumeRememberedEpisode();
        }
      }
    }).catch(() => {});
    const refresh = setInterval(() => {
      const handle = folder;
      if (handle && folderGranted && !folderBusy) {
        void refreshFolder(handle).catch(() => {
          if (folder === handle) folderGranted = false;
        });
      }
    }, 5000);
    return () => { mounted = false; clearInterval(refresh); };
  });

  async function playFile(file: File, subtitle?: File, autoplay = false) {
    const request = ++opening;
    const body = subtitle && subtitle.size <= 5000000 ? await subtitle.text().catch(() => '') : '';
    if (request !== opening) return;
    if (desktopStream?.active) desktopStream.stop();
    desktopPipReady = false;
    desktopPipError = '';
    videoThemes = storedThemes(fileIdentity(file));
    saveProgress(true);
    progressReady = false;
    lastProgressSave = 0;
    resumePosition = episodeProgress(file)?.position || 0;
    rememberSelectedEpisode(file);
    const previousUrl = videoUrl;
    mediaError = false;
    localCues = parseCaptionResponse(body);
    referenceCues = [];
    if (localCues.length) {
      const nearby = episodes.map((episode, index) => ({ ...episode, distance: Math.abs(index - episodeIndex) }))
        .filter(episode => episode.distance > 0 && episode.subtitle && episode.subtitle.size <= 5000000)
        .sort((a, b) => a.distance - b.distance).slice(0, 2);
      void Promise.all(nearby.map(async episode => {
        const reference = await episode.subtitle?.text().catch(() => '');
        return reference && reference !== body ? parseCaptionResponse(reference) : [];
      })).then(tracks => {
        if (request === opening) referenceCues = tracks.filter(track => track.length);
      });
    }
    localBody = body;
    localSource = fileIdentity(file);
    videoUrl = URL.createObjectURL(file);
    fileName = file.name;
    await tick();
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if (request !== opening || !video) return;
    if (previousUrl && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200 });
    }
    if (autoplay) void video.play().catch(() => {});
  }

  function openVideo(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) {
      episodes = [];
      selected = '';
      folderGranted = false;
      folder = undefined;
      episodeFolders = [];
      void playFile(file, undefined, true);
    }
  }

  function openFolder(event: Event) {
    const files = Array.from((event.currentTarget as HTMLInputElement).files || []);
    if (!files.length) return;
    folderGranted = false;
    folder = undefined;
    episodeFolders = [];
    selected = '';
    setEpisodeFiles(files);
    selectEpisode(true);
  }

  function selectEpisode(autoplay = !!video && !video.paused) {
    const episode = episodes[episodeIndex];
    if (episode) void playFile(episode.video, episode.subtitle, autoplay);
  }

  function stepEpisode(offset: number, autoplay = !!video && !video.paused) {
    const episode = episodes[episodeIndex + offset];
    if (!episode) return;
    selected = episode.path;
    void playFile(episode.video, episode.subtitle, autoplay);
  }

  function advanceAfterEnding() {
    saveProgress(true);
    const request = opening;
    // Let the study player finish a final phrase before advancing.
    setTimeout(() => {
      if (request === opening && video?.ended && !studying) stepEpisode(1, true);
    }, 150);
  }

  async function toggleFullscreen(hideControls = false) {
    if (!player) return;
    fullscreenError = false;
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player.requestFullscreen();
      if (hideControls) hideOverlay();
      else video?.focus({ preventScroll: true });
    } catch { fullscreenError = true; }
  }

  async function toggleDesktopPip() {
    if (desktopPipStarting || !video) return;
    if (desktopStream?.active) {
      desktopStream.stop();
      return;
    }
    desktopPipError = '';
    desktopPipStarting = true;
    const stream = new DesktopVideoStream(video, () => {
      if (desktopStream === stream) desktopPipActive = stream.active;
    }, message => {
      if (desktopStream === stream) desktopPipError = message;
    });
    desktopStream = stream;
    try {
      await stream.start();
      if (desktopStream !== stream) stream.stop();
    } catch (error) {
      if (desktopStream === stream) desktopPipError = error instanceof Error ? error.message : 'Desktop Picture in Picture could not start.';
    } finally {
      if (desktopStream === stream) desktopPipStarting = false;
    }
  }

  function hideOverlay() {
    video?.focus({ preventScroll: true });
    revealOverlayAfter = performance.now() + 500;
    overlayHidden = true;
  }

  function revealOverlayOnPointerMove() {
    if (overlayHidden && performance.now() >= revealOverlayAfter) overlayHidden = false;
  }

  onDestroy(() => {
    scanQueue?.stop();
    if (desktopStream?.active) desktopStream.stop();
    desktopStream = undefined;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  });
</script>

<svelte:document onfullscreenchange={() => { fullscreen = document.fullscreenElement === player; }} />
<svelte:window onpagehide={() => saveProgress(true)} onpointermove={revealOverlayOnPointerMove} />

<h1>Offline study</h1>
{#if directoryPicker}
  <div class="episode-bar library">
    <button disabled={folderBusy} onclick={() => chooseFolder()}>{folder ? 'Change download folder' : 'Connect download folder'}</button>
    {#if folder && !folderGranted}<button disabled={folderBusy} onclick={() => chooseFolder(true)}>Reconnect {folder.name}</button>{/if}
    {#if folderGranted && episodeFolders.length > 1}
      <select aria-label="Series folder" bind:value={selectedFolder} onchange={switchEpisodeFolder}>
        {#each episodeFolders as entry (entry.key)}<option value={entry.key}>{entry.name}</option>{/each}
      </select>
    {/if}
    {#if !videoUrl && episodes.length}
      <select aria-label="Saved episode" bind:value={selected}>
        {#each episodes as episode (episode.path)}<option value={episode.path}>{episode.video.name}</option>{/each}
      </select>
      <button onclick={() => selectEpisode(true)}>{savedPosition ? 'Resume episode' : 'Play saved episode'}</button>
    {/if}
  </div>
  {#if folderStatus}<p role="status">{folderStatus}</p>
  {:else if !folder}<p>Choose Arc Anime or a series folder inside it.</p>{/if}
{/if}
  {#if folderGranted || episodes.length || scanQueue}
  <div class="episode-bar scan-queue" aria-label="Frame checking queue">
    <button onclick={toggleScanQueue}>{scanQueue ? (scanPaused ? 'Resume frame checking' : 'Pause frame checking') : 'Queue frame checking'}</button>
    {#if scanQueue && scanStatus}
      <button onclick={stopScanQueue}>Stop frame checking</button>
      <span role="status">
        {scanStatus.scanned} / {scanStatus.total} episodes checked{scanStatus.failed ? ` · ${scanStatus.failed} failed` : ''}
        {#if scanStatus.active} · Checking {scanStatus.active}{:else if scanPaused} · Paused{:else if scanFolder} · Watching for finished downloads{/if}
      </span>
    {/if}
  </div>
{/if}
<details class="local-files" open={!directoryPicker}>
    <summary>Open files manually</summary>
    <div class="files">
      <div><label for="series-folder">Open a downloaded series folder</label><input id="series-folder" type="file" webkitdirectory onchange={openFolder} /></div>
      <div><label for="episode">Episode video</label><input id="episode" type="file" accept="video/*,.mp4,.webm,.m4v" onchange={openVideo} /></div>
    </div>
  </details>
{#if videoUrl}
  <div class="player" bind:this={player}>
    <video bind:this={video} src={videoUrl} playsinline tabindex="-1" onloadedmetadata={restoreProgress}
      onloadeddata={() => { desktopPipReady = true; }}
      ontimeupdate={() => saveProgress()} onpause={() => saveProgress(true)} onseeked={() => saveProgress(true)}
      onended={advanceAfterEnding} onerror={() => { mediaError = true; }}>
      <track kind="captions" />
    </video>
    {#if mediaError}<p role="alert">Chrome could not play this file. Try an MP4 or WebM file.</p>{/if}
    {#if fullscreenError}<p role="alert">Fullscreen could not open.</p>{/if}
    {#key videoUrl}
      <div class="offline-controls">
        <JapaneseStudy inline {overlayHidden} {localCues} {localBody} {localSource} {referenceCues} {videoThemes} title={fileName} bind:learning bind:studying onResumeAtEnd={() => stepEpisode(1, true)} onNextEpisode={episodeIndex >= 0 && episodeIndex < episodes.length - 1 ? () => stepEpisode(1, true) : undefined} onToggleFullscreen={() => toggleFullscreen(true)}>
          {#snippet playerOptions()}
            {#if desktopPipAvailable}
              <button class="theme-scan" disabled={desktopPipStarting || !desktopPipReady} onclick={toggleDesktopPip}>
                {desktopPipStarting ? 'Opening desktop window…' : desktopPipActive ? 'Exit picture in picture across desktops' : 'Picture in picture across desktops'}
              </button>
              {#if desktopPipError}<span role="alert">{desktopPipError}</span>{/if}
            {/if}
            {#if episodes.length > 1}
              <button class="theme-scan" onclick={toggleScanQueue}>{scanQueue ? (scanPaused ? 'Resume frame checking' : 'Pause frame checking') : 'Queue frame checking'}</button>
              {#if scanStatus}<span>{scanStatus.scanned} / {scanStatus.total} episodes checked</span>{/if}
            {/if}
          {/snippet}
          {#snippet playerActions()}
            <div class="episode-controls">
              {#if episodes.length > 1}
                <button aria-label="Previous" title="Previous episode" disabled={episodeIndex <= 0} onclick={() => stepEpisode(-1)}>‹</button>
                <select aria-label="Episode" bind:value={selected} onchange={() => selectEpisode()}>
                  {#each episodes as episode (episode.path)}
                    <option value={episode.path}>{episode.video.name}</option>
                  {/each}
                </select>
                <button aria-label="Next" title="Next episode" disabled={episodeIndex >= episodes.length - 1} onclick={() => stepEpisode(1)}>›</button>
              {/if}
              <button onclick={() => toggleFullscreen()} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>⛶</button>
              <button onclick={hideOverlay} title="Hide controls and subtitles until you move the pointer">Hide</button>
            </div>
          {/snippet}
        </JapaneseStudy>
      </div>
    {/key}
  </div>
{/if}
<SeriesDownloads />

<style>
  :global(body) { margin: 0; background: #14131a; color: #f4f3fa; font: 15px/1.5 system-ui, sans-serif; color-scheme: dark; }
  :global(#app) { max-width: 1440px; padding: 28px; margin: auto; }
  h1 { margin: 0; }
  label { display: block; margin-bottom: 6px; }
  .files { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
  .library { margin-top: 12px; }
  .local-files { margin-top: 10px; }
  .local-files summary { cursor: pointer; }
  .player { position: relative; max-width: 1040px; margin: 18px auto 0; }
  .episode-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .episode-controls { display: flex; align-items: center; gap: 6px; margin-inline-start: auto; min-width: 0; }
  .offline-controls { position: absolute; bottom: 8px; left: 8px; right: 8px; pointer-events: none; }
  .episode-bar select { min-width: 0; max-width: 45%; }
  .episode-controls select { min-width: 0; max-width: 220px; text-overflow: ellipsis; }
  .episode-controls button, .episode-controls select { font: inherit; color: inherit; border: 1px solid #ffffff24; border-radius: 6px; background: #ffffff09; padding: 4px 8px; cursor: pointer; }
  .theme-scan { font: inherit; color: inherit; border: 1px solid #ffffff24; border-radius: 6px; background: #ffffff09; padding: 4px 8px; cursor: pointer; }
  .episode-controls button:hover:not(:disabled) { background: #ffffff19; }
  .episode-controls button:disabled { opacity: .4; cursor: default; }
  .episode-controls :is(button, select):focus-visible { outline: 2px solid #cfb6ff; outline-offset: 2px; }
  .episode-bar button, .episode-bar select { font: inherit; color: inherit; background: #25232d; border: 1px solid #ffffff30; border-radius: 6px; padding: 4px 8px; }
  .episode-bar button:disabled { opacity: 0.4; }
  video { display: block; width: 100%; max-height: 64dvh; background: #08080b; border-radius: 12px; }
  video:focus { outline: none; }
  .player:fullscreen { display: flex; flex-direction: column; max-width: none; margin: 0; background: #08080b; }
  .player:fullscreen video { flex: 1 1 0; min-height: 0; max-height: none; border-radius: 0; object-fit: contain; }
  .player:fullscreen :global(.study.inline .panel) { max-height: 35dvh; }
</style>
