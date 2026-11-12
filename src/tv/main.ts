import { detectAnimeOpEdIntervals, parseCaptionResponse } from '../japanese/captions';
import { hasJapanese, type Cue } from '../japanese/study';
import { PhraseStops } from '../japanese/study-player';
import type { VideoThemes } from '../japanese/video-themes';
import { tvDiagnostics } from './diagnostics';

type Part = keyof VideoThemes;
type Range = NonNullable<VideoThemes[Part]>;
type Progress = { position: number; watchedAt: number; finished: boolean };
type Episode = { name: string; video: string; subtitles: string | null; saved?: { themes?: VideoThemes; progress?: Progress } };
type Library = { id: string; title: string; autoSkip?: Partial<Record<Part, boolean>>; endingAction?: string; episodes: Episode[] };

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
const play = element<HTMLButtonElement>('play');
const change = element('change');
const next = element<HTMLButtonElement>('next');
const progressBar = element<HTMLProgressElement>('progress');
const frequencies = [{ label: 'Off', chance: 0 }, { label: 'Occasionally', chance: 0.15 }, { label: 'Often', chance: 0.4 }, { label: 'Every phrase', chance: 1 }];
const labels = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };
const parts = ['recap', 'op', 'ed'] as const;
const stops = new PhraseStops();
let base = '';
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
let frequency = 0;
let hideTimer: number | undefined;
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

function episodeTitle(name: string) {
  const number = /^Episode\s+(\d+)\b/i.exec(name);
  return number ? `Episode ${Number(number[1])}` : name.replace(/\.[^.]+$/, '');
}

function progressKey(episode: Episode) {
  return `tv:${library?.id}:${episode.name}`;
}

function getProgress(episode: Episode): Progress | undefined {
  try {
    return JSON.parse(stored(progressKey(episode)) || 'null') || episode.saved?.progress;
  } catch { return episode.saved?.progress; }
}

function saveProgress(finished = false) {
  const episode = library?.episodes[index];
  if (!episode || !ready || !Number.isFinite(video.currentTime)) return;
  save(progressKey(episode), JSON.stringify({
    position: finished ? 0 : video.currentTime, watchedAt: Date.now(), finished
  }));
  lastSave = Date.now();
}

function renderLibrary() {
  list.textContent = '';
  if (!library) return;
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

async function connect(input: string) {
  libraryStatus.textContent = 'Connecting…';
  let stage = 'checking the address';
  try {
    const url = privateLibraryAddress(input);
    stage = 'reaching the Mac companion';
    const response = await fetch(url + 'library.json');
    diagnostics.log(`Library request: HTTP ${response.status}`);
    if (!response.ok) throw new Error();
    stage = 'reading the library response';
    const data = await response.json() as Library;
    if (!Array.isArray(data.episodes) || !data.episodes.length || typeof data.title !== 'string') throw new Error();
    base = url;
    library = data;
    index = -1;
    save('tv-library-address', url);
    element('title').textContent = data.title;
    connectForm.hidden = true;
    change.hidden = false;
    libraryStatus.textContent = '';
    renderLibrary();
  } catch {
    diagnostics.log(`Library connection failed while ${stage}`);
    connectForm.hidden = false;
    libraryStatus.textContent = 'Could not open the library. Check the address and keep the Mac companion running.';
    address.focus();
  }
}

function showControls() {
  controls.hidden = false;
  player.classList.add('with-controls');
  player.classList.toggle('with-learning', learningEnabled);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (video.paused || captured || replayUntil || !skipRow.hidden || !playbackStatus.hidden) return;
    controls.hidden = true;
    player.classList.remove('with-controls', 'with-learning');
  }, 10000);
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
  showControls();
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
  const auto = library?.autoSkip?.[activeSkip.part] !== false && !dismissed.has(activeSkip.part);
  const delta = time - lastTime;
  if (auto && !video.paused && delta > 0 && delta <= 1.5) skipElapsed += delta / video.playbackRate;
  countdown.textContent = auto && (skipElapsed > 0 || !video.paused) ? `Skipping in ${Math.max(1, Math.ceil(5 - skipElapsed))} s` : '';
  keep.hidden = !countdown.textContent;
  if (auto && skipElapsed >= 5) skipPart(true);
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
  themes = episode.saved?.themes || {};
  dismissed = new Set();
  activeSkip = undefined;
  skipElapsed = lastTime = 0;
  caption.hidden = skipRow.hidden = true;
  progressBar.value = 0;
  element('clock').textContent = '';
  libraryScreen.hidden = true;
  player.hidden = false;
  next.disabled = index + 1 >= (library?.episodes.length || 0);
  element('episode-title').textContent = episodeTitle(episode.name);
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
    if (!themes[part] && range && range.source !== 'dialogue-gap') themes = { ...themes, [part]: range };
  }
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
video.addEventListener('play', () => { play.textContent = 'Pause'; showControls(); });
video.addEventListener('pause', () => { play.textContent = 'Play'; if (ready && !video.ended) saveProgress(); showControls(); });
video.addEventListener('ended', () => {
  saveProgress(true);
  if (library && index + 1 < library.episodes.length) void openEpisode(index + 1, true);
});
window.addEventListener('pagehide', () => { if (!player.hidden && !video.ended) saveProgress(); });

function togglePlayback() { if (video.paused) void startPlayback(); else video.pause(); }
play.addEventListener('click', togglePlayback);
element('back').addEventListener('click', closeEpisode);
element('rewind').addEventListener('click', () => seek(video.currentTime - 10));
element('forward').addEventListener('click', () => seek(video.currentTime + 10));
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
    if (!player.hidden) closeEpisode();
    else if (!connectForm.hidden && library) { connectForm.hidden = true; change.focus(); }
    else if (tizen) tizen.application?.getCurrentApplication().exit();
    event.preventDefault();
  } else if (key >= 37 && key <= 40 && (!(event.target instanceof HTMLInputElement) || key === 38 || key === 40)) {
    event.preventDefault();
    if (!player.hidden && controls.hidden) {
      showControls();
      if (key === 37 || key === 39) seek(video.currentTime + (key === 37 ? -10 : 10));
      play.focus();
    } else {
      if (!player.hidden) showControls();
      moveFocus(key);
    }
  } else if (!player.hidden && (key === 10252 || key === 32 || key === 13 && controls.hidden)) {
    event.preventDefault();
    togglePlayback();
  } else if (!player.hidden && [415, 19, 412, 417].includes(key)) {
    event.preventDefault();
    if (key === 415) void startPlayback();
    else if (key === 19) video.pause();
    else seek(video.currentTime + (key === 412 ? -10 : 10));
    showControls();
  }
});

frequency = Math.max(0, frequencies.findIndex((_, i) => i === Number(stored('tv-study-frequency'))));
const here = location.protocol === 'http:' && /^\/[a-f0-9]{16}\/$/.test(location.pathname) ? location.href : '';
address.value = here || stored('tv-library-address') || '';
if (address.value) void connect(address.value);
else address.focus();
