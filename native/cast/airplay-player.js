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
  const episode = await response.json();
  document.title = document.querySelector('h1').textContent = episode.title;

  const labels = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };
  const skips = Object.entries(labels).flatMap(([part, label]) => {
    const range = episode.skips?.[part];
    return range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start
      ? [{ label, ...range }] : [];
  });
  let current;
  let deadline;
  const dismissed = new Set();

  function skipCurrent() {
    if (!current) return;
    dismissed.add(current);
    video.currentTime = Math.min(current.end, video.duration);
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
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(episode.position, Math.max(0, video.duration - 0.1));
    updateSkips();
  }, { once: true });
  video.addEventListener('error', () => { status.textContent = 'This episode could not be played. Prepare it again from Anime Study.'; });

  if (episode.hasSubtitles) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'Japanese';
    track.srclang = 'ja';
    track.src = 'subtitles.vtt';
    video.append(track);
  }
  const source = document.createElement('source');
  source.type = 'video/mp4';
  source.src = 'episode.mp4';
  video.append(source);
  video.load();
}
void load().catch(() => { status.textContent = 'The AirPlay session expired. Prepare the episode again from Anime Study.'; });
