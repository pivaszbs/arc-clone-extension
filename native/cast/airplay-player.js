const video = document.querySelector('video');
const status = document.querySelector('#status');
const airplay = document.querySelector('#airplay');
const skipRow = document.querySelector('.skip');
const skip = document.querySelector('#skip');
const keep = document.querySelector('#keep');
const countdown = document.querySelector('#countdown');

if (typeof video.webkitShowPlaybackTargetPicker === 'function') {
  airplay.hidden = false;
  airplay.addEventListener('click', () => video.webkitShowPlaybackTargetPicker());
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    status.textContent = video.webkitCurrentPlaybackTargetIsWireless ? 'Playing over AirPlay' : '';
  });
  video.addEventListener('webkitplaybacktargetavailabilitychanged', event => {
    if (event.availability === 'not-available' && !video.webkitCurrentPlaybackTargetIsWireless) {
      status.textContent = 'No AirPlay TV found. Check that your Mac and TV are on the same network.';
    } else if (!video.webkitCurrentPlaybackTargetIsWireless) {
      status.textContent = '';
    }
  });
} else {
  status.textContent = 'Open this page in Safari to use AirPlay.';
}

async function load() {
  const response = await fetch('episode.json');
  if (!response.ok) throw new Error();
  const initialEpisode = await response.json();
  let currentRevision = initialEpisode.revision || 1;
  document.title = document.querySelector('h1').textContent = initialEpisode.title;

  const labels = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };
  const buildSkips = ep => Object.entries(labels).flatMap(([part, label]) => {
    const range = ep.skips?.[part];
    return range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start
      ? [{ label, ...range }] : [];
  });
  let skips = buildSkips(initialEpisode);
  let current;
  let deadline;
  const dismissed = new Set();

  let previousPosition;
  const undo = document.querySelector('#undo');
  function jump(time) {
    if (!Number.isFinite(video.duration)) return;
    previousPosition = video.currentTime;
    video.currentTime = Math.max(0, Math.min(time, video.duration));
    undo.hidden = false;
    deadline = undefined;
    updateSkips();
  }
  undo.addEventListener('click', () => {
    if (previousPosition === undefined) return;
    const restored = previousPosition;
    for (const range of skips) {
      if (restored >= range.start && restored < range.end) dismissed.add(range);
    }
    previousPosition = undefined;
    video.currentTime = restored;
    undo.hidden = true;
    deadline = undefined;
    updateSkips();
  });
  document.querySelector('#restart').addEventListener('click', () => jump(0));
  function renderChapters() {
    const chapters = document.querySelector('#chapters');
    const track = document.querySelector('#chapter-track');
    chapters.replaceChildren();
    track.replaceChildren();
    for (const range of skips) {
      const name = range.label.replace('Skip ', '');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${name} ${formatTime(range.start)}–${formatTime(range.end)}`;
      button.addEventListener('click', () => {
        dismissed.add(range);
        jump(range.start);
      });
      chapters.append(button);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const marker = document.createElement('span');
        marker.style.left = `${100 * Math.min(range.start, video.duration) / video.duration}%`;
        marker.style.width = `${100 * Math.max(0, Math.min(range.end, video.duration) - range.start) / video.duration}%`;
        track.append(marker);
      }
    }
    if (!skips.length) chapters.textContent = 'No skip timings supplied. Add them below.';
  }
  const timingFields = document.querySelector('#timing-fields');
  const timingMessage = document.querySelector('#timing-message');
  const inputs = [];
  const formatTime = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const parseTime = value => {
    const match = /^(\d+):([0-5]\d)$/.exec(value.trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  };
  for (const [part, label] of Object.entries(labels)) {
    const row = document.createElement('div');
    row.className = 'timing';
    const name = label.replace('Skip ', '');
    const title = document.createElement('span');
    title.textContent = name[0].toUpperCase() + name.slice(1);
    row.append(title);
    const range = skips.find(item => item.label === label);
    const fields = {};
    for (const edge of ['start', 'end']) {
      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = `${edge} `;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '0:00';
      input.setAttribute('aria-label', `${name} ${edge}`);
      input.value = range ? formatTime(range[edge]) : '';
      fieldLabel.append(input);
      row.append(fieldLabel);
      fields[edge] = input;
    }
    const autoLabel = document.createElement('label');
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = Boolean(range?.auto);
    autoLabel.append(auto, ' Auto-skip');
    row.append(autoLabel);
    for (const edge of ['start', 'end']) {
      const useCurrent = document.createElement('button');
      useCurrent.type = 'button';
      useCurrent.textContent = `Set ${edge} to current time`;
      useCurrent.addEventListener('click', () => { fields[edge].value = formatTime(video.currentTime); });
      row.append(useCurrent);
    }
    timingFields.append(row);
    inputs.push({ part, label, ...fields, auto });
  }
  document.querySelector('#timings').addEventListener('submit', event => {
    event.preventDefault();
    const next = [];
    for (const { label, start, end, auto } of inputs) {
      if (!start.value.trim() && !end.value.trim()) continue;
      const from = parseTime(start.value);
      const to = parseTime(end.value);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
          (Number.isFinite(video.duration) && to > video.duration + 0.5)) {
        timingMessage.textContent = `${label.replace('Skip ', '')}: enter valid start and end times within this episode, with end after start.`;
        return;
      }
      next.push({ label, start: from, end: to, auto: auto.checked });
    }
    skips = next;
    current = undefined;
    deadline = undefined;
    dismissed.clear();
    renderChapters();
    timingMessage.textContent = 'Skip timings saved until this page is refreshed.';
    updateSkips();
  });

  function skipCurrent() {
    if (!current) return;
    dismissed.add(current);
    jump(current.end);
    updateSkips();
  }

  function updateSkips() {
    const time = video.currentTime;
    const wireless = video.webkitCurrentPlaybackTargetIsWireless;
    if (video.seeking && !wireless) return;
    const range = skips.find(range => time >= range.start && time < Math.min(range.end, video.duration)
      && range.end <= video.duration + 0.5);
    if (current !== range) {
      current = range;
      deadline = undefined;
    }
    skipRow.hidden = !range;
    if (!range) return;
    skip.textContent = range.label;
    if (range.auto && !dismissed.has(range) && !video.paused && deadline === undefined) deadline = time + 5 * video.playbackRate;
    const pending = deadline !== undefined && !dismissed.has(range);
    if (pending && !video.paused && time >= deadline) {
      skipCurrent();
      return;
    }
    keep.hidden = !pending;
    countdown.textContent = pending ? `Skipping in ${Math.max(1, Math.ceil((deadline - time) / (video.playbackRate || 1)))} s` : '';
  }

  renderChapters();
  video.addEventListener('durationchange', renderChapters);
  skip.addEventListener('click', skipCurrent);
  keep.addEventListener('click', () => {
    if (current) dismissed.add(current);
    updateSkips();
  });
  for (const event of ['timeupdate', 'play', 'pause', 'seeked']) video.addEventListener(event, updateSkips);
  video.addEventListener('seeking', () => { deadline = undefined; });
  // AirPlay can update the playhead without delivering a timeupdate event to the page.
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', updateSkips);
  setInterval(() => {
    if (video.webkitCurrentPlaybackTargetIsWireless) updateSkips();
  }, 250);
  function loadEpisodeMedia(episode, autoplay) {
    document.title = document.querySelector('h1').textContent = episode.title;
    skips = buildSkips(episode);
    current = undefined;
    deadline = undefined;
    dismissed.clear();
    previousPosition = undefined;
    undo.hidden = true;
    for (const { label, start, end, auto } of inputs) {
      const range = skips.find(item => item.label === label);
      start.value = range ? formatTime(range.start) : '';
      end.value = range ? formatTime(range.end) : '';
      auto.checked = Boolean(range?.auto);
    }
    timingMessage.textContent = '';
    renderChapters();
    updateSkips();

    video.replaceChildren();
    if (episode.hasSubtitles) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'Japanese';
      track.srclang = 'ja';
      track.src = episode.subtitlesFile || 'subtitles.vtt';
      video.append(track);
    }
    const source = document.createElement('source');
    source.type = 'video/mp4';
    source.src = episode.video || 'episode.mp4';
    video.append(source);
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(episode.position || 0, Math.max(0, video.duration - 0.1));
      updateSkips();
      if (autoplay) video.play().catch(() => {});
    }, { once: true });
    video.load();
  }

  video.addEventListener('error', () => { status.textContent = 'This episode could not be played. Prepare it again from Anime Study.'; });
  loadEpisodeMedia(initialEpisode, false);

  setInterval(async () => {
    try {
      const poll = await fetch('episode.json');
      if (!poll.ok) return;
      const next = await poll.json();
      if (next.revision && next.revision !== currentRevision) {
        currentRevision = next.revision;
        loadEpisodeMedia(next, Boolean(next.autoplay));
      }
    } catch {
      // Ignore transient poll errors while staging the next episode.
    }
  }, 2000);
}
void load().catch(() => { status.textContent = 'The AirPlay session expired. Prepare the episode again from Anime Study.'; });
