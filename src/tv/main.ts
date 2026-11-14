import { detectAnimeOpEdIntervals, parseCaptionResponse } from '../japanese/captions';
import { hasJapanese, type Cue } from '../japanese/study';
import { PhraseStops } from '../japanese/study-player';
import type { VideoThemes } from '../japanese/video-themes';
import { tvDiagnostics } from './diagnostics';
import {
  applyTvSyncEvent,
  cleanTitle,
  episodeTitle,
  privateLibraryAddress,
  type Part,
  type Progress,
  type TvEpisode as Episode,
  type TvLibrary as Library,
  type TvSyncMessage
} from './library-client';

type Range = NonNullable<VideoThemes[Part]>;

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const libraryScreen = element('library');
const player = element('player');
const video = element<HTMLVideoElement>('video');
const controls = element('controls');
const connectForm = element<HTMLFormElement>('connect');
const address = element<HTMLInputElement>('address');
const list = element('episodes');
const libraryStatus = element('library-status');
const playbackStatus = element('playback-status');
const caption = element<HTMLButtonElement>('caption');
const skipRow = element('skip-controls');
const skip = element<HTMLButtonElement>('skip');
const keep = element('keep');
const countdown = element('countdown');
const learn = element('learn');
const learning = element('learning');
const replay = element<HTMLButtonElement>('replay');
const continueStudy = element<HTMLButtonElement>('continue');
const skipMenuBtn = element<HTMLButtonElement>('skip-menu-btn');
const skipSettings = element('skip-settings');
const timingRows = element('timing-rows');
const segmentMarkers = element('segment-markers');
const osd = element('osd');
const pauseCircle = element<HTMLButtonElement>('pause-circle');
const toggleOp = element<HTMLButtonElement>('toggle-op');
const toggleEd = element<HTMLButtonElement>('toggle-ed');
const toggleRecap = element<HTMLButtonElement>('toggle-recap');
const skipDelayBtn = element<HTMLButtonElement>('skip-delay-btn');
const play = element<HTMLButtonElement>('play');
const allTitlesBtn = element<HTMLButtonElement>('all-titles');
const change = element('change');
const next = element<HTMLButtonElement>('next');
const progressBar = element<HTMLProgressElement>('progress');
const frequencies = [{ label: 'Off', chance: 0 }, { label: 'Occasionally', chance: 0.15 }, { label: 'Often', chance: 0.4 }, { label: 'Every phrase', chance: 1 }];
const labels = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };
const partNames = { recap: 'Recap', op: 'Opening', ed: 'Ending' };
const parts = ['recap', 'op', 'ed'] as const;
const skipDelays = [0, 3, 5] as const;
const stops = new PhraseStops();
let base = '';
let catalog: Library[] = [];
let seriesIndex = 0;
let showingTitles = false;
let library: Library | undefined;
let index = -1;
let ready = false;
let cues: Cue[] = [];
let timeline: Cue[] = [];
let captionCue: Cue | undefined;
let captured: Cue | undefined;
let rawCaptions = '';
let replayUntil = 0;
let themes: VideoThemes = {};
let activeSkip: { part: Part; range: Range } | undefined;
let skipElapsed = 0;
let lastTime = 0;
let dismissed = new Set<Part>();
let learningEnabled = false;
let skipMenuOpen = false;
let frequency = 0;
let skipDelayIndex = 1;
let hideTimer: number | undefined;
let osdTimer: number | undefined;
let ws: WebSocket | null = null;
let wsTimer: number | undefined;
let scanWasActive = false;
let serverAutoplay = true;
let subtitlesEnabled = stored('tv-subtitles') !== 'off';
let pendingAutoplay = true;
let loadId = 0;
let lastSave = 0;
let lastTvStateSent = 0;

function sendTvState(force = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - lastTvStateSent < 2000) return;
  lastTvStateSent = now;
  const ep = !player.hidden && index >= 0 ? library?.episodes[index] : undefined;
  const payload = ep && library
    ? {
        type: 'tv_state',
        active: true,
        series: seriesIndex,
        seriesName: library.title,
        seriesLabel: cleanTitle(library.title),
        episode: ep.name,
        episodeLabel: episodeTitle(ep.name),
        paused: video.paused,
        position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        subtitles: subtitlesEnabled,
        autoplay: serverAutoplay,
        skipAvailable: Boolean(activeSkip),
      }
    : { type: 'tv_state', active: false };
  try {
    ws.send(JSON.stringify(payload));
  } catch { /* ignore */ }
}

function handleDirectionKey(key: number) {
  if (!player.hidden && controls.hidden) {
    if (key === 37 || key === 39) {
      const delta = key === 37 ? -15 : 15;
      seek(video.currentTime + delta);
      flashOsd(delta < 0 ? '−15s' : '+15s');
    } else {
      // Up or Down opens the Netflix/Crunchyroll-style player menu.
      showControls();
      play.focus();
    }
  } else {
    if (!player.hidden) showControls();
    moveFocus(key);
  }
}

function handleBackAction(): boolean {
  if (!player.hidden && skipMenuOpen) {
    skipMenuOpen = false;
    showControls();
    skipMenuBtn.focus();
    return true;
  }
  if (!player.hidden && !controls.hidden) {
    hideControls();
    return true;
  }
  if (!player.hidden) {
    closeEpisode();
    return true;
  }
  if (!showingTitles && catalog.length > 1 && connectForm.hidden) {
    renderTitles();
    return true;
  }
  if (!connectForm.hidden && library) {
    connectForm.hidden = true;
    change.focus();
    return true;
  }
  return false;
}

function handleOkAction() {
  if (!player.hidden && controls.hidden) {
    togglePlayback();
    sendTvState(true);
  } else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.click();
  } else {
    const root = player.hidden ? libraryScreen : player;
    root.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }
}

function handleMenuAction() {
  if (!player.hidden) {
    if (controls.hidden) {
      showControls();
      play.focus();
    } else {
      hideControls();
    }
  } else if (catalog.length > 1 && !showingTitles) {
    renderTitles();
  } else {
    renderLibrary();
  }
}

function handleTvControl(msg: TvSyncMessage) {
  const action = msg.action;
  if (!action) return;
  if (action === 'playEpisode') {
    const targetSeries = typeof msg.series === 'number'
      ? msg.series
      : typeof msg.seriesName === 'string'
        ? catalog.findIndex(s => s.title === msg.seriesName || s.id === msg.seriesName)
        : seriesIndex;
    if (targetSeries >= 0 && targetSeries < catalog.length && targetSeries !== seriesIndex) {
      if (!player.hidden) saveProgress();
      selectSeries(targetSeries);
    }
    const epIdx = typeof msg.episode === 'string' && library
      ? library.episodes.findIndex(e => e.name === msg.episode)
      : -1;
    if (epIdx >= 0) {
      void openEpisode(epIdx, false, true);
    }
    return;
  }
  if (action === 'up') { handleDirectionKey(38); return; }
  if (action === 'down') { handleDirectionKey(40); return; }
  if (action === 'left') { handleDirectionKey(37); return; }
  if (action === 'right') { handleDirectionKey(39); return; }
  if (action === 'ok') { handleOkAction(); return; }
  if (action === 'back') { handleBackAction(); return; }
  if (action === 'menu') { handleMenuAction(); return; }
  if (action === 'autoplay') {
    serverAutoplay = !serverAutoplay;
    syncToServer({ autoplay: serverAutoplay });
    flashOsd(serverAutoplay ? 'Autoplay on' : 'Autoplay stopped');
    sendTvState(true);
    return;
  }
  if (player.hidden) return;
  if (action === 'play') {
    void startPlayback();
    if (!controls.hidden) flashOsd('▶ Play');
    sendTvState(true);
  } else if (action === 'pause') {
    video.pause();
    if (!controls.hidden) flashOsd('❚❚ Pause');
    sendTvState(true);
  } else if (action === 'toggle') {
    togglePlayback();
    sendTvState(true);
  } else if (action === 'seekBy' && typeof msg.delta === 'number') {
    seek(video.currentTime + msg.delta);
    flashOsd(msg.delta < 0 ? `−${Math.abs(msg.delta)}s` : `+${msg.delta}s`);
    sendTvState(true);
  } else if (action === 'seek' && typeof msg.position === 'number') {
    seek(msg.position);
    sendTvState(true);
  } else if (action === 'restart') {
    seek(0);
    void startPlayback();
    flashOsd('↺ Restart');
    sendTvState(true);
  } else if (action === 'subtitles') {
    subtitlesEnabled = !subtitlesEnabled;
    save('tv-subtitles', subtitlesEnabled ? 'on' : 'off');
    renderCaption();
    flashOsd(subtitlesEnabled ? 'Subtitles on' : 'Subtitles off');
    sendTvState(true);
  } else if (action === 'markWatched') {
    const ep = library?.episodes[index];
    if (ep) {
      const nextFinished = typeof msg.finished === 'boolean' ? msg.finished : !getProgress(ep)?.finished;
      saveProgress(nextFinished);
      flashOsd(nextFinished ? '✓ Marked watched' : 'Marked unwatched');
      sendTvState(true);
    }
  } else if (action === 'next') {
    if (library && index + 1 < library.episodes.length) void openEpisode(index + 1, false, true);
  } else if (action === 'prev') {
    if (library && index > 0) void openEpisode(index - 1, false, true);
  } else if (action === 'skip') {
    if (activeSkip) {
      skipPart(false);
      flashOsd('Skipped');
    } else {
      flashOsd('No intro/outro here');
    }
    sendTvState(true);
  } else if (action === 'stop') {
    closeEpisode();
  }
}
const diagnostics = tvDiagnostics(video, () => [
  library ? `Library: connected · ${library.episodes.length} episodes` : 'Library: disconnected',
  player.hidden ? 'Player: closed' : `Japanese cues: ${cues.length} · Skip ranges: ${parts.filter(part => themes[part]).map(part => labels[part]).join(', ') || 'none'}`
]);

function stored(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Playback can continue without storage. */ }
}

function format(time: number) {
  return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
}

function progressKey(episode: Episode, lib = library) {
  return `tv:${lib?.id}:${episode.name}`;
}

function getProgress(episode: Episode, lib = library): Progress | undefined {
  let local: Progress | null = null;
  try {
    local = JSON.parse(stored(progressKey(episode, lib)) || 'null') as Progress | null;
  } catch { /* ignore */ }
  const remote = episode.saved?.progress;
  if (local && remote) return remote.watchedAt >= local.watchedAt ? remote : local;
  return remote || local || undefined;
}

function syncToServer(payload: Record<string, unknown>) {
  if (!base) return;
  void fetch(`${base}sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ series: seriesIndex, ...payload })
  }).catch(() => { /* Keep playing if sync fails transiently. */ });
}

function saveProgress(finished = false) {
  const episode = library?.episodes[index];
  if (!episode || !ready || !Number.isFinite(video.currentTime)) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
  const progress: Progress = { position: finished ? 0 : video.currentTime, ...(duration ? { duration } : {}), watchedAt: Date.now(), finished };
  save(progressKey(episode), JSON.stringify(progress));
  episode.saved = { ...(episode.saved || {}), progress };
  syncToServer({ episode: episode.name, progress });
  lastSave = Date.now();
}

function selectSeries(i: number) {
  const chosen = catalog[i];
  if (!chosen) return;
  seriesIndex = i;
  library = chosen;
  if (typeof chosen.autoSkipDelay === 'number') {
    const serverDelay = skipDelays.indexOf(chosen.autoSkipDelay as (typeof skipDelays)[number]);
    if (serverDelay >= 0) skipDelayIndex = serverDelay;
  }
  index = -1;
  showingTitles = false;
  element('title').textContent = cleanTitle(chosen.title);
  allTitlesBtn.hidden = catalog.length <= 1;
  renderLibrary();
}

function renderTitles() {
  list.textContent = '';
  list.classList.add('titles-grid');
  showingTitles = true;
  allTitlesBtn.hidden = true;
  element('title').textContent = 'Anime Study';
  catalog.forEach((entry, i) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'title-card';
    if (entry.poster) {
      const img = document.createElement('img');
      img.className = 'title-poster';
      img.src = base + entry.poster;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      button.append(img);
    }
    const meta = document.createElement('div');
    meta.className = 'title-meta';
    const name = document.createElement('span');
    name.className = 'title-name';
    name.textContent = cleanTitle(entry.title);
    const info = document.createElement('small');
    const latest = entry.episodes.reduce((best, ep, idx) =>
      (getProgress(ep, entry)?.watchedAt || 0) > (best < 0 ? 0 : getProgress(entry.episodes[best], entry)?.watchedAt || 0) ? idx : best, -1);
    const resumeText = latest >= 0 ? ` · ${episodeTitle(entry.episodes[latest].name)}` : '';
    info.textContent = `${entry.episodes.length} episodes${resumeText}`;
    meta.append(name, info);
    button.append(meta);
    button.addEventListener('click', () => selectSeries(i));
    row.append(button);
    list.append(row);
  });
  list.querySelectorAll('button')[seriesIndex]?.focus();
}

function renderLibrary() {
  if (showingTitles && catalog.length > 1) {
    renderTitles();
    return;
  }
  list.textContent = '';
  list.classList.remove('titles-grid');
  if (!library) return;
  allTitlesBtn.hidden = catalog.length <= 1;
  const episodes = library.episodes;
  const latest = episodes.reduce((best, episode, i) =>
    (getProgress(episode)?.watchedAt || 0) > (best < 0 ? 0 : getProgress(episodes[best])?.watchedAt || 0) ? i : best, -1);
  episodes.forEach((episode, i) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const progress = getProgress(episode);
    button.textContent = episodeTitle(episode.name);
    if (progress && (progress.position > 0 || progress.finished)) {
      const info = document.createElement('small');
      info.textContent = progress.finished ? 'Watched' : `Resume at ${format(progress.position)}`;
      button.append(info);
    }
    button.addEventListener('click', () => void openEpisode(i));
    row.append(button);
    list.append(row);
  });
  const focusIndex = index >= 0 ? index : latest >= 0 && getProgress(episodes[latest])?.finished && latest + 1 < episodes.length ? latest + 1 : Math.max(0, latest);
  list.querySelectorAll('button')[focusIndex]?.focus();
}

function openWebSocket(url: string) {
  window.clearTimeout(wsTimer);
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  const socket = new WebSocket(url.replace(/^http/, 'ws') + 'ws');
  ws = socket;
  socket.addEventListener('open', () => {
    diagnostics.log('WebSocket connected');
    sendTvState(true);
  });
  socket.addEventListener('message', event => {
    try {
      const msg = JSON.parse(String(event.data)) as TvSyncMessage;
      if (msg.type === 'tv_control') {
        handleTvControl(msg);
        return;
      }
      if (msg.type === 'scan_progress') {
        const matchesSeries = typeof msg.series === 'number'
          ? msg.series === seriesIndex
          : typeof msg.seriesName === 'string' && (msg.seriesName === library?.title || msg.seriesName === library?.id);
        if (matchesSeries && typeof msg.done === 'number' && typeof msg.total === 'number' && msg.total > 0) {
          if (msg.done < msg.total) {
            scanWasActive = true;
            if (player.hidden) libraryStatus.textContent = `Scanning intros on Mac: ${msg.done}/${msg.total}`;
          } else {
            if (player.hidden) libraryStatus.textContent = '';
            if (scanWasActive && !player.hidden) flashOsd('Intro scan complete');
            scanWasActive = false;
          }
        }
        return;
      }
      if (msg.type === 'sync' && typeof msg.autoplay === 'boolean') {
        serverAutoplay = msg.autoplay;
        if (!player.hidden) flashOsd(serverAutoplay ? 'Autoplay on' : 'Autoplay stopped');
      }
      const applied = applyTvSyncEvent(catalog, msg);
      if (!applied) return;
      if (typeof msg.episode === 'string' && msg.progress) {
        const syncedEp = applied.targetLib.episodes.find(e => e.name === msg.episode);
        if (syncedEp) save(progressKey(syncedEp, applied.targetLib), JSON.stringify(msg.progress));
      }
      if (applied.targetIdx !== seriesIndex) return;
      if (typeof msg.autoSkipDelay === 'number') {
        const delayIdx = skipDelays.indexOf(msg.autoSkipDelay as (typeof skipDelays)[number]);
        if (delayIdx >= 0) skipDelayIndex = delayIdx;
      }
      if (!player.hidden && index >= 0) {
        const currentEp = library?.episodes[index];
        if (currentEp && msg.episode === currentEp.name && applied.themesUpdated && msg.themes) {
          themes = { ...themes, ...msg.themes };
          renderSegmentMarkers();
          updateSkips(video.currentTime);
          flashOsd('Skip timings updated');
        }
        if (applied.skipUpdated) renderSkipSettings();
      } else if (player.hidden && library && !showingTitles) {
        renderLibrary();
      }
    } catch { /* Ignore malformed WebSocket frames. */ }
  });
  socket.addEventListener('close', () => {
    if (ws === socket) {
      ws = null;
      wsTimer = window.setTimeout(() => {
        if (base === url) openWebSocket(url);
      }, 3000);
    }
  });
}

async function connect(input: string) {
  libraryStatus.textContent = 'Connecting…';
  let stage = 'checking the address';
  try {
    const url = privateLibraryAddress(input);
    stage = 'reaching the Mac companion';
    const response = await fetch(url + 'catalog.json');
    diagnostics.log(`Catalog request: HTTP ${response.status}`);
    if (!response.ok) throw new Error();
    stage = 'reading the catalog response';
    const payload = await response.json() as { autoplay?: boolean; series?: Library[] };
    serverAutoplay = payload.autoplay !== false;
    const seriesList = Array.isArray(payload.series) ? payload.series.filter(item => Array.isArray(item.episodes) && item.episodes.length) : [];
    if (!seriesList.length) throw new Error();
    base = url;
    catalog = seriesList;
    save('tv-library-address', url);
    openWebSocket(url);
    connectForm.hidden = true;
    change.hidden = false;
    libraryStatus.textContent = '';
    let bestSeries = -1;
    let bestEpisode = -1;
    let bestWatchedAt = 0;
    catalog.forEach((lib, sIdx) => {
      lib.episodes.forEach((ep, eIdx) => {
        const p = getProgress(ep, lib);
        if (p && p.watchedAt > bestWatchedAt) {
          bestWatchedAt = p.watchedAt;
          bestSeries = sIdx;
          bestEpisode = p.finished && eIdx + 1 < lib.episodes.length ? eIdx + 1 : eIdx;
        }
      });
    });
    if (bestSeries >= 0 && bestEpisode >= 0) {
      selectSeries(bestSeries);
      void openEpisode(bestEpisode, false, serverAutoplay);
    } else if (catalog.length > 1) {
      seriesIndex = Math.min(seriesIndex, catalog.length - 1);
      renderTitles();
    } else {
      selectSeries(0);
    }
  } catch {
    diagnostics.log(`Library connection failed while ${stage}`);
    connectForm.hidden = false;
    allTitlesBtn.hidden = true;
    libraryStatus.textContent = 'Could not open the library. Check the address and keep the Mac companion running.';
    address.focus();
  }
}

function flashOsd(text: string) {
  osd.textContent = text;
  osd.hidden = false;
  syncPauseCircle();
  window.clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => {
    osd.hidden = true;
    syncPauseCircle();
  }, 900);
}

function isAutoSkipEnabled(part: Part) {
  if (typeof library?.autoSkip?.[part] === 'boolean') return library.autoSkip[part] as boolean;
  const saved = stored(`tv-autoskip-${part}`);
  if (saved === 'on') return true;
  if (saved === 'off') return false;
  return true;
}

function skipDelaySeconds() {
  return skipDelays[skipDelayIndex] ?? 3;
}

function customThemesKey(episode: Episode) {
  return `tv-themes:${library?.id}:${episode.name}`;
}

function loadCustomThemes(episode: Episode): VideoThemes {
  try {
    return JSON.parse(stored(customThemesKey(episode)) || '{}') as VideoThemes;
  } catch { return {}; }
}

function saveCustomTheme(part: Part, range: Range | undefined) {
  const episode = library?.episodes[index];
  if (!episode) return;
  const nextThemes: VideoThemes = { ...themes };
  if (range) nextThemes[part] = range;
  else delete nextThemes[part];
  themes = nextThemes;
  const custom = loadCustomThemes(episode);
  if (range) custom[part] = range;
  else delete custom[part];
  save(customThemesKey(episode), JSON.stringify(custom));
  episode.saved = { ...(episode.saved || {}), themes: nextThemes };
  syncToServer({ episode: episode.name, themes: nextThemes });
  dismissed.delete(part);
  activeSkip = undefined;
  skipElapsed = 0;
  renderSegmentMarkers();
  renderSkipSettings();
  updateSkips(video.currentTime);
}

function renderSegmentMarkers() {
  segmentMarkers.textContent = '';
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  for (const part of parts) {
    const range = themes[part];
    if (!range) continue;
    const marker = document.createElement('span');
    const left = Math.max(0, Math.min(100, (range.start / video.duration) * 100));
    const right = Math.max(left, Math.min(100, (range.end / video.duration) * 100));
    marker.style.left = `${left}%`;
    marker.style.width = `${Math.max(0.4, right - left)}%`;
    segmentMarkers.append(marker);
  }
}

function renderSkipSettings() {
  const buttons: [HTMLButtonElement, Part][] = [[toggleOp, 'op'], [toggleEd, 'ed'], [toggleRecap, 'recap']];
  for (const [btn, part] of buttons) {
    btn.textContent = `${partNames[part]}: ${isAutoSkipEnabled(part) ? 'On' : 'Off'}`;
  }
  const delay = skipDelaySeconds();
  skipDelayBtn.textContent = `Delay: ${delay === 0 ? 'Instant' : `${delay}s`}`;
  timingRows.textContent = '';
  for (const part of ['op', 'ed', 'recap'] as const) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = partNames[part];
    const range = themes[part];
    const value = document.createElement('span');
    value.className = 'timing-value';
    value.textContent = range ? `${format(range.start)} – ${format(range.end)}` : 'Not set';

    const makeBtn = (text: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };
    const setStart = makeBtn('Start = Now', () => {
      const start = Math.floor(video.currentTime);
      const end = range && range.end > start ? range.end : Math.min(video.duration || start + 90, start + 90);
      saveCustomTheme(part, { start, end, source: 'manual' });
    });
    const setEnd = makeBtn('End = Now', () => {
      const end = Math.ceil(video.currentTime);
      const start = range && range.start < end ? range.start : Math.max(0, end - 90);
      saveCustomTheme(part, { start, end, source: 'manual' });
    });
    const minusEnd = makeBtn('End −5s', () => {
      if (!range) return;
      const end = Math.max(range.start + 1, range.end - 5);
      saveCustomTheme(part, { ...range, end, source: 'manual' });
    });
    const plusEnd = makeBtn('End +5s', () => {
      if (!range) return;
      const end = Math.min(video.duration || range.end + 5, range.end + 5);
      saveCustomTheme(part, { ...range, end, source: 'manual' });
    });
    const clearBtn = makeBtn('Clear', () => saveCustomTheme(part, undefined));
    clearBtn.disabled = !range;
    row.append(label, value, setStart, setEnd, minusEnd, plusEnd, clearBtn);
    timingRows.append(row);
  }
}

function syncPauseCircle() {
  pauseCircle.hidden = !video.paused || !controls.hidden || !osd.hidden || !!captured || player.hidden || !ready;
}

function hideControls() {
  skipMenuOpen = false;
  skipSettings.hidden = true;
  skipMenuBtn.setAttribute('aria-pressed', 'false');
  controls.hidden = true;
  player.classList.remove('with-controls', 'with-learning', 'with-settings');
  syncPauseCircle();
}

function showControls() {
  controls.hidden = false;
  syncPauseCircle();
  skipSettings.hidden = !skipMenuOpen;
  skipMenuBtn.setAttribute('aria-pressed', String(skipMenuOpen));
  player.classList.add('with-controls');
  player.classList.toggle('with-learning', learningEnabled);
  player.classList.toggle('with-settings', skipMenuOpen);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (captured || replayUntil || skipMenuOpen || !playbackStatus.hidden) return;
    hideControls();
  }, 4000);
}

function status(text: string) {
  playbackStatus.textContent = text;
  playbackStatus.hidden = !text;
  if (text) showControls();
}

async function startPlayback() {
  try { await video.play(); } catch (error) {
    diagnostics.log(error instanceof DOMException ? `Play rejected: ${error.name}` : 'Play rejected');
    if (video.error) status('This file could not be played. Try an H.264/AAC MP4.');
    else showControls();
  }
}

function subtitleAt(time: number) {
  for (let i = cues.length - 1; i >= 0; i--) {
    if (cues[i].start <= time && cues[i].end > time) return cues[i];
  }
  return undefined;
}

function syncLearning() {
  learn.setAttribute('aria-pressed', String(learningEnabled));
  learning.hidden = !learningEnabled;
  element('frequency').textContent = frequencies[frequency].label;
  replay.hidden = continueStudy.hidden = !captured;
  caption.tabIndex = learningEnabled ? 0 : -1;
  caption.disabled = !learningEnabled;
  if (captured || !controls.hidden) showControls();
  else syncPauseCircle();
}

function renderCaption() {
  captionCue = captured || (subtitlesEnabled ? subtitleAt(video.currentTime) : undefined);
  caption.hidden = !captionCue;
  caption.textContent = captionCue?.text || '';
}

function study(cue: Cue) {
  video.pause();
  captured = cue;
  renderCaption();
  syncLearning();
  replay.focus();
}

function seek(time: number) {
  if (!ready) return;
  video.currentTime = Math.max(0, Math.min(video.duration, time));
  lastTime = video.currentTime;
  skipElapsed = 0;
  stops.reset();
}

function updateSkips(time: number) {
  const part = parts.find(part => {
    const range = themes[part];
    return range && time >= range.start && time < range.end && range.end <= video.duration + 0.1;
  });
  const range = part && themes[part];
  if (activeSkip?.part !== part) {
    activeSkip = part && range ? { part, range } : undefined;
    skipElapsed = 0;
    if (activeSkip) showControls();
    else if (!skipRow.hidden) showControls();
  }
  skipRow.hidden = !activeSkip || !!captured;
  if (!activeSkip || captured) return;
  skip.textContent = labels[activeSkip.part];
  const auto = isAutoSkipEnabled(activeSkip.part) && !dismissed.has(activeSkip.part);
  const delay = skipDelaySeconds();
  const delta = time - lastTime;
  if (auto && !video.paused && delta > 0 && delta <= 1.5) skipElapsed += delta / video.playbackRate;
  countdown.textContent = auto && delay > 0 && (skipElapsed > 0 || !video.paused)
    ? `Skipping in ${Math.max(1, Math.ceil(delay - skipElapsed))} s`
    : '';
  keep.hidden = !auto || delay === 0;
  if (auto && skipElapsed >= delay) skipPart(true);
}

function skipPart(auto: boolean) {
  if (!activeSkip || !library) return;
  const { part, range } = activeSkip;
  diagnostics.log(`${labels[part]} (${auto ? 'auto' : 'manual'}) → ${format(range.end)}`);
  dismissed.add(part);
  const ending = library.endingAction || 'auto';
  if (auto && part === 'ed' && index + 1 < library.episodes.length &&
    (ending === 'next' || ending === 'auto' && video.duration - range.end <= 20)) {
    saveProgress(true);
    void openEpisode(index + 1, true);
  } else seek(range.end);
}

function updatePlayback() {
  if (!ready || player.hidden) return;
  const time = video.currentTime;
  if (replayUntil && time >= replayUntil) {
    replayUntil = 0;
    video.pause();
    renderCaption();
    syncLearning();
    return;
  }
  progressBar.value = time / video.duration || 0;
  element('clock').textContent = `${format(time)} / ${format(video.duration)}`;
  renderCaption();
  if (learningEnabled && !captured && !video.paused && frequencies[frequency].chance) {
    const cue = stops.observe(timeline, null, time, frequencies[frequency].chance);
    if (cue) study(cue);
  }
  if (!video.seeking) updateSkips(time);
  lastTime = time;
  if (!video.paused && Date.now() - lastSave > 5000) saveProgress();
  sendTvState(false);
}

async function openEpisode(position: number, previousFinished = false, autoplay = serverAutoplay) {
  const episode = library?.episodes[position];
  if (!episode) return;
  pendingAutoplay = autoplay;
  if (!previousFinished && !player.hidden) saveProgress();
  const request = ++loadId;
  ready = false;
  index = position;
  video.pause();
  video.removeAttribute('src');
  video.load();
  cues = [];
  timeline = [];
  rawCaptions = '';
  captured = undefined;
  replayUntil = 0;
  stops.reset();
  themes = { ...(episode.saved?.themes || {}), ...loadCustomThemes(episode) };
  dismissed = new Set();
  activeSkip = undefined;
  skipElapsed = lastTime = 0;
  skipMenuOpen = false;
  skipSettings.hidden = true;
  osd.hidden = true;
  window.clearTimeout(osdTimer);
  caption.hidden = skipRow.hidden = true;
  progressBar.value = 0;
  element('clock').textContent = '';
  libraryScreen.hidden = true;
  player.hidden = false;
  next.disabled = index + 1 >= (library?.episodes.length || 0);
  element('series-badge').textContent = library ? cleanTitle(library.title) : '';
  element('episode-title').textContent = episodeTitle(episode.name);
  renderSegmentMarkers();
  renderSkipSettings();
  hideControls();
  status('Loading episode…');
  syncLearning();
  play.focus();
  sendTvState(true);

  if (episode.subtitles) {
    try {
      const response = await fetch(base + episode.subtitles);
      if (request !== loadId) return;
      diagnostics.log(`Subtitle request: HTTP ${response.status}`);
      if (response.ok) {
        const body = await response.text();
        if (request !== loadId) return;
        rawCaptions = body;
        cues = parseCaptionResponse(body).filter(cue => hasJapanese(cue.text));
        timeline = [...cues].sort((a, b) => a.end - b.end);
      }
    } catch {
      if (request === loadId) diagnostics.log('Subtitle request or parsing failed');
    }
  }
  if (request !== loadId) return;
  video.src = base + episode.video;
  video.load();
}

function closeEpisode() {
  saveProgress();
  ready = false;
  ++loadId;
  video.pause();
  video.removeAttribute('src');
  video.load();
  player.hidden = true;
  libraryScreen.hidden = false;
  renderLibrary();
  sendTvState(true);
}

video.addEventListener('loadedmetadata', () => {
  const episode = library?.episodes[index];
  if (!episode || player.hidden || !Number.isFinite(video.duration)) return;
  const subtitleThemes = detectAnimeOpEdIntervals(rawCaptions, cues, video.duration);
  for (const part of ['op', 'ed'] as const) {
    const range = subtitleThemes[part];
    if (!themes[part] && range) themes = { ...themes, [part]: range };
  }
  renderSegmentMarkers();
  renderSkipSettings();
  ready = true;
  status('');
  const position = getProgress(episode);
  if (position && !position.finished && position.position > 0 && position.position < video.duration - 1) seek(position.position);
  if (pendingAutoplay) void startPlayback();
  else syncPauseCircle();
  sendTvState(true);
});
video.addEventListener('error', () => status('This file could not be played. Try an H.264/AAC MP4.'));
video.addEventListener('timeupdate', updatePlayback);
video.addEventListener('seeking', () => { stops.reset(); lastTime = video.currentTime; skipElapsed = 0; });
video.addEventListener('seeked', () => { updatePlayback(); sendTvState(true); });
video.addEventListener('play', () => { play.textContent = 'Pause'; syncPauseCircle(); sendTvState(true); });
video.addEventListener('pause', () => { play.textContent = 'Play'; if (ready && !video.ended) saveProgress(); syncPauseCircle(); sendTvState(true); });
video.addEventListener('ended', () => {
  saveProgress(true);
  if (serverAutoplay && library && index + 1 < library.episodes.length) void openEpisode(index + 1, true, true);
  else sendTvState(true);
});
window.addEventListener('pagehide', () => {
  if (!player.hidden && !video.ended) saveProgress();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'tv_state', active: false })); } catch { /* ignore */ }
  }
});

function togglePlayback() {
  if (video.paused) { void startPlayback(); if (!controls.hidden) flashOsd('▶ Play'); }
  else { video.pause(); hideControls(); }
}
pauseCircle.addEventListener('click', togglePlayback);
play.addEventListener('click', togglePlayback);
element('back').addEventListener('click', closeEpisode);
element('rewind').addEventListener('click', () => { seek(video.currentTime - 15); flashOsd('−15s'); });
element('forward').addEventListener('click', () => { seek(video.currentTime + 15); flashOsd('+15s'); });
skipMenuBtn.addEventListener('click', () => {
  skipMenuOpen = !skipMenuOpen;
  renderSkipSettings();
  showControls();
});
for (const [btn, part] of [[toggleOp, 'op'], [toggleEd, 'ed'], [toggleRecap, 'recap']] as const) {
  btn.addEventListener('click', () => {
    const nextEnabled = !isAutoSkipEnabled(part);
    if (library) library.autoSkip = { ...(library.autoSkip || {}), [part]: nextEnabled };
    save(`tv-autoskip-${part}`, nextEnabled ? 'on' : 'off');
    syncToServer({ autoSkip: { [part]: nextEnabled } });
    renderSkipSettings();
    updateSkips(video.currentTime);
  });
}
skipDelayBtn.addEventListener('click', () => {
  skipDelayIndex = (skipDelayIndex + 1) % skipDelays.length;
  save('tv-autoskip-delay', String(skipDelayIndex));
  syncToServer({ autoSkipDelay: skipDelaySeconds() });
  renderSkipSettings();
});
next.addEventListener('click', () => void openEpisode(index + 1));
skip.addEventListener('click', () => skipPart(false));
keep.addEventListener('click', () => { if (activeSkip) dismissed.add(activeSkip.part); play.focus(); updatePlayback(); });
learn.addEventListener('click', () => {
  learningEnabled = !learningEnabled;
  if (!learningEnabled) captured = undefined;
  stops.reset();
  syncLearning();
  renderCaption();
});
element('frequency').addEventListener('click', () => {
  frequency = (frequency + 1) % frequencies.length;
  save('tv-study-frequency', String(frequency));
  syncLearning();
});
caption.addEventListener('click', () => { if (captionCue) study(captionCue); });
replay.addEventListener('click', () => {
  if (!captured) return;
  replayUntil = captured.end;
  seek(captured.start);
  void startPlayback();
});
continueStudy.addEventListener('click', () => {
  if (captured && video.currentTime < captured.end) seek(captured.end);
  captured = undefined;
  replayUntil = 0;
  syncLearning();
  play.focus();
  void startPlayback();
});
connectForm.addEventListener('submit', event => { event.preventDefault(); void connect(address.value); });
allTitlesBtn.addEventListener('click', () => { renderTitles(); });
change.addEventListener('click', () => { connectForm.hidden = false; address.focus(); });
player.addEventListener('pointermove', showControls);

function moveFocus(key: number) {
  const root = player.hidden ? libraryScreen : player;
  const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input')).filter(item => item.tabIndex >= 0 && item.offsetWidth > 0);
  const current = document.activeElement;
  if (!(current instanceof HTMLElement) || !items.includes(current)) { items[0]?.focus(); return; }
  const origin = current.getBoundingClientRect();
  let nearest: HTMLElement | undefined;
  let score = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const rect = item.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - origin.left - origin.width / 2;
    const y = rect.top + rect.height / 2 - origin.top - origin.height / 2;
    const primary = key === 37 ? -x : key === 39 ? x : key === 38 ? -y : y;
    if (primary < 2) continue;
    const distance = primary + 3 * Math.abs(key === 37 || key === 39 ? y : x);
    if (distance < score) { score = distance; nearest = item; }
  }
  nearest?.focus();
}

const tizen = (window as Window & { tizen?: {
  tvinputdevice?: { registerKey: (key: string) => void };
  application?: { getCurrentApplication: () => { exit: () => void } };
} }).tizen;
for (const key of ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaRewind', 'MediaFastForward']) {
  try { tizen?.tvinputdevice?.registerKey(key); } catch { /* Some remotes lack these keys. */ }
}

document.addEventListener('keydown', event => {
  const key = event.keyCode;
  if (diagnostics.dialog.open) {
    if (key === 10009 || key === 27) {
      event.preventDefault();
      diagnostics.dialog.close();
    } else if (key === 38 || key === 40) {
      event.preventDefault();
      const report = element('diagnostics-report');
      if (document.activeElement === report) {
        if (key === 40 && report.scrollTop + report.clientHeight >= report.scrollHeight - 1) diagnostics.dialog.querySelector('button')?.focus();
        else report.scrollTop += key === 38 ? -100 : 100;
      } else if (key === 38) report.focus();
    }
    return;
  }
  if (key === 10009 || key === 27) {
    if (!handleBackAction() && tizen) tizen.application?.getCurrentApplication().exit();
    event.preventDefault();
  } else if (key >= 37 && key <= 40 && (!(event.target instanceof HTMLInputElement) || key === 38 || key === 40)) {
    event.preventDefault();
    handleDirectionKey(key);
  } else if (!player.hidden && (key === 10252 || key === 32 || key === 13 && controls.hidden)) {
    event.preventDefault();
    togglePlayback();
  } else if (!player.hidden && [415, 19, 412, 417].includes(key)) {
    event.preventDefault();
    if (key === 415) { void startPlayback(); if (!controls.hidden) flashOsd('▶ Play'); }
    else if (key === 19) { video.pause(); if (!controls.hidden) flashOsd('❚❚ Pause'); }
    else {
      const delta = key === 412 ? -15 : 15;
      seek(video.currentTime + delta);
      flashOsd(delta < 0 ? '−15s' : '+15s');
    }
    showControls();
  }
});

const savedDelay = Number(stored('tv-autoskip-delay'));
if (Number.isInteger(savedDelay) && savedDelay >= 0 && savedDelay < skipDelays.length) skipDelayIndex = savedDelay;
frequency = Math.max(0, frequencies.findIndex((_, i) => i === Number(stored('tv-study-frequency'))));
const here = location.protocol === 'http:' && /^\/[a-f0-9]{16}\/$/.test(location.pathname) ? location.href : '';
address.value = here || stored('tv-library-address') || '';
if (address.value) void connect(address.value);
else address.focus();
