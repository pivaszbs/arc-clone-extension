import { detectAnimeOpEdIntervals, parseCaptionResponse } from '../japanese/captions';
import { hasJapanese, type Cue } from '../japanese/study';
import { PhraseStops } from '../japanese/study-player';
import type { VideoThemes } from '../japanese/video-themes';
import { tvDiagnostics } from './diagnostics';

type Part = keyof VideoThemes;
type Range = NonNullable<VideoThemes[Part]>;
type Progress = { position: number; watchedAt: number; finished: boolean };
type Episode = { name: string; video: string; subtitles: string | null; saved?: { themes?: VideoThemes; progress?: Progress } };
type Library = { id: string; title: string; autoSkip?: Partial<Record<Part, boolean>>; autoSkipDelay?: number; endingAction?: string; episodes: Episode[] };

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
let loadId = 0;
let lastSave = 0;
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

function privateLibraryAddress(input: string) {
  const url = new URL(input.trim());
  const octets = url.hostname.split('.').map(Number);
  const local = octets.length === 4 && (octets[0] === 10 || octets[0] === 127 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168);
  if (url.protocol !== 'http:' || !local || url.username || url.password || !/^\/[a-f0-9]{16}\/?$/.test(url.pathname)) {
    throw new Error('Enter the full Anime Study address shown on your Mac.');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/`;
}

function format(time: number) {
  return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
}

function cleanTitle(raw: string) {
  return raw
    .replace(/^Смотреть аниме\s+/i, '')
    .replace(/\s+онлайн(?=\s|$)/i, '')
    .replace(/\s+-\s+\d+(?:\s+-\s+.*)?$/, '')
    .trim() || raw;
}

function episodeTitle(name: string) {
  const number = /^Episode\s+(\d+)\b/i.exec(name);
  return number ? `Episode ${Number(number[1])}` : name.replace(/\.[^.]+$/, '');
}

function progressKey(episode: Episode, lib = library) {
  return `tv:${lib?.id}:${episode.name}`;
}

function getProgress(episode: Episode, lib = library): Progress | undefined {
  try {
    return JSON.parse(stored(progressKey(episode, lib)) || 'null') || episode.saved?.progress;
  } catch { return episode.saved?.progress; }
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
  const progress: Progress = { position: finished ? 0 : video.currentTime, watchedAt: Date.now(), finished };
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
  showingTitles = true;
  allTitlesBtn.hidden = true;
  element('title').textContent = 'Anime Study';
  catalog.forEach((entry, i) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = cleanTitle(entry.title);
    const info = document.createElement('small');
    const latest = entry.episodes.reduce((best, ep, idx) =>
      (getProgress(ep, entry)?.watchedAt || 0) > (best < 0 ? 0 : getProgress(entry.episodes[best], entry)?.watchedAt || 0) ? idx : best, -1);
    const resumeText = latest >= 0 ? ` · ${episodeTitle(entry.episodes[latest].name)}` : '';
    info.textContent = `${entry.episodes.length} episodes${resumeText}`;
    button.append(info);
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
  socket.addEventListener('open', () => diagnostics.log('WebSocket connected'));
  socket.addEventListener('message', event => {
    try {
      const msg = JSON.parse(String(event.data)) as {
        type?: string;
        series?: number;
        seriesName?: string;
        episode?: string;
        themes?: VideoThemes;
        autoSkip?: Partial<Record<Part, boolean>>;
        autoSkipDelay?: number;
        progress?: Progress;
        done?: number;
        total?: number;
      };
      if (msg.type === 'scan_progress') {
        const matchesSeries = typeof msg.series === 'number'
          ? msg.series === seriesIndex
          : typeof msg.seriesName === 'string' && (msg.seriesName === library?.title || msg.seriesName === library?.id);
        if (matchesSeries && typeof msg.done === 'number' && typeof msg.total === 'number' && msg.total > 0) {
          if (player.hidden) {
            libraryStatus.textContent = msg.done < msg.total ? `Scanning intros on Mac: ${msg.done}/${msg.total}` : '';
          } else if (msg.done === msg.total) {
            flashOsd('Intro scan complete');
          }
        }
        return;
      }
      if (msg.type !== 'sync') return;
      const targetIdx = typeof msg.series === 'number'
        ? msg.series
        : typeof msg.seriesName === 'string'
          ? catalog.findIndex(s => s.title === msg.seriesName || s.id === msg.seriesName)
          : -1;
      const targetLib = targetIdx >= 0 ? catalog[targetIdx] : undefined;
      if (!targetLib) return;
      if (msg.autoSkip && typeof msg.autoSkip === 'object') {
        targetLib.autoSkip = { ...(targetLib.autoSkip ?? {}), ...msg.autoSkip };
      }
      if (typeof msg.autoSkipDelay === 'number') {
        targetLib.autoSkipDelay = msg.autoSkipDelay;
      }
      if (typeof msg.episode === 'string') {
        const ep = targetLib.episodes.find(e => e.name === msg.episode);
        if (ep) {
          if (msg.themes && typeof msg.themes === 'object') {
            ep.themes = { ...(ep.themes ?? {}), ...msg.themes };
          }
          if (msg.progress && typeof msg.progress === 'object') {
            ep.progress = { ...(ep.progress ?? {}), ...msg.progress };
          }
        }
      }
      if (targetIdx === seriesIndex) {
        if (typeof msg.autoSkipDelay === 'number') {
          const delayIdx = skipDelays.indexOf(msg.autoSkipDelay);
          if (delayIdx >= 0) skipDelayIndex = delayIdx;
        }
        if (!player.hidden && index >= 0) {
          const currentEp = library?.episodes[index];
          if (currentEp && msg.episode === currentEp.name && msg.themes && typeof msg.themes === 'object') {
            themes = { ...themes, ...msg.themes };
            renderSegmentMarkers();
            updateSkips(video.currentTime);
            flashOsd('Skip timings updated');
          }
          if (msg.autoSkip || typeof msg.autoSkipDelay === 'number') {
            renderSkipSettings();
          }
        } else if (player.hidden && library && !allTitlesBtn.hidden) {
          renderLibrary();
        }
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
    const payload = await response.json() as { series?: Library[] };
    const seriesList = Array.isArray(payload.series) ? payload.series.filter(item => Array.isArray(item.episodes) && item.episodes.length) : [];
    if (!seriesList.length) throw new Error();
    base = url;
    catalog = seriesList;
    save('tv-library-address', url);
    openWebSocket(url);
    connectForm.hidden = true;
    change.hidden = false;
    libraryStatus.textContent = '';
    if (catalog.length > 1) {
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
  window.clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => { osd.hidden = true; }, 900);
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
  pauseCircle.hidden = !video.paused || !controls.hidden || !!captured || player.hidden || !ready;
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
    if (video.paused || captured || replayUntil || skipMenuOpen || !playbackStatus.hidden) return;
    hideControls();
  }, 8000);
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
  captionCue = captured || subtitleAt(video.currentTime);
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
}

async function openEpisode(position: number, previousFinished = false) {
  const episode = library?.episodes[position];
  if (!episode) return;
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
  void startPlayback();
});
video.addEventListener('error', () => status('This file could not be played. Try an H.264/AAC MP4.'));
video.addEventListener('timeupdate', updatePlayback);
video.addEventListener('seeking', () => { stops.reset(); lastTime = video.currentTime; skipElapsed = 0; });
video.addEventListener('seeked', updatePlayback);
video.addEventListener('play', () => { play.textContent = 'Pause'; syncPauseCircle(); });
video.addEventListener('pause', () => { play.textContent = 'Play'; if (ready && !video.ended) saveProgress(); syncPauseCircle(); });
video.addEventListener('ended', () => {
  saveProgress(true);
  if (library && index + 1 < library.episodes.length) void openEpisode(index + 1, true);
});
window.addEventListener('pagehide', () => { if (!player.hidden && !video.ended) saveProgress(); });

function togglePlayback() {
  if (video.paused) { void startPlayback(); if (!controls.hidden) flashOsd('▶ Play'); }
  else { video.pause(); if (!controls.hidden) flashOsd('❚❚ Pause'); }
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
    if (!player.hidden && skipMenuOpen) {
      skipMenuOpen = false;
      showControls();
      skipMenuBtn.focus();
    } else if (!player.hidden && !controls.hidden) {
      hideControls();
    } else if (!player.hidden) closeEpisode();
    else if (!showingTitles && catalog.length > 1 && connectForm.hidden) { renderTitles(); }
    else if (!connectForm.hidden && library) { connectForm.hidden = true; change.focus(); }
    else if (tizen) tizen.application?.getCurrentApplication().exit();
    event.preventDefault();
  } else if (key >= 37 && key <= 40 && (!(event.target instanceof HTMLInputElement) || key === 38 || key === 40)) {
    event.preventDefault();
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
  } else if (!player.hidden && (key === 10252 || key === 32 || key === 13 && controls.hidden)) {
    event.preventDefault();
    togglePlayback();
  } else if (!player.hidden && [415, 19, 412, 417].includes(key)) {
    event.preventDefault();
    if (key === 415) { void startPlayback(); flashOsd('▶ Play'); }
    else if (key === 19) { video.pause(); flashOsd('❚❚ Pause'); }
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
