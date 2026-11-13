import { audioPrintFromFile, matchAudioPrints, matchKnownAudio, type AudioPrint } from './audio-print';
import { findAudioSwitch, parseMp4AudioTrack, readMp4AudioWindow } from './mp4-audio';

export const THEME_DETECTOR_VERSION = 4;

export type VideoThemes = Partial<Record<'op' | 'ed' | 'recap', { start: number; end: number; source?: string }>>;
type Sample = { time: number; pixels: Uint8ClampedArray };
// `edAudio` is null when the soundtrack could not be decoded, and missing in fingerprints saved before v4.
type Fingerprint = { op: Sample[]; ed: Sample[]; openingScanEnd?: number; edAudio?: AudioPrint | null };

async function endingAudio(file: File, ed: Sample[], signal: AbortSignal) {
  if (!ed.length) return null;
  try {
    return await audioPrintFromFile(file, ed[0].time, ed.at(-1)!.time + 0.5, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

const interval = 2;
const earlyOpeningEnd = 360;
const maximumOpeningEnd = 720;

function waitForFrame(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', signal: AbortSignal, load: () => void) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const listeners = new AbortController();
    const options = { once: true, signal: listeners.signal };
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      listeners.abort();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Video frame timed out')), 8000);
    signal.addEventListener('abort', () => finish(signal.reason), options);
    video.addEventListener(event, () => finish(), options);
    video.addEventListener('error', () => finish(new Error('Could not read video frames')), options);
    try { load(); } catch (error) { finish(error); }
  });
}

export async function fingerprintVideo(file: File, signal: AbortSignal, previous?: Fingerprint): Promise<Fingerprint> {
  if (previous?.openingScanEnd !== undefined) {
    // Fingerprints saved before audio matching only need the soundtrack added.
    if (previous.edAudio !== undefined) return previous;
    return { ...previous, edAudio: await endingAudio(file, previous.ed, signal) };
  }
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  const canvas = document.createElement('canvas');
  canvas.width = 12;
  canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not open a drawing context');
  const url = URL.createObjectURL(file);

  async function sampleWindow(start: number, end: number, context: CanvasRenderingContext2D) {
    const samples: Sample[] = [];
    for (let time = start; time < end; time++) {
      await waitForFrame(video, 'seeked', signal, () => { video.currentTime = time; });
      // Crop the edges so player logos and letterboxing have less influence.
      const { videoWidth: width, videoHeight: height } = video;
      context.drawImage(video, width * 0.08, height * 0.1, width * 0.84, height * 0.8, 0, 0, canvas.width, canvas.height);
      samples.push({ time, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data });
    }
    return samples;
  }

  try {
    await waitForFrame(video, 'loadeddata', signal, () => { video.src = url; });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < 180) return { op: [], ed: [], openingScanEnd: 0, edAudio: null };
    const endingStart = Math.max(duration - 240, duration / 2);
    const openingScanEnd = Math.min(maximumOpeningEnd, endingStart);
    const firstNewSample = (previous?.op.at(-1)?.time ?? -0.5) + 1;
    const op = [...(previous?.op ?? []), ...await sampleWindow(firstNewSample, openingScanEnd, context)];
    const ed = previous?.ed ?? await sampleWindow(endingStart, duration - 0.5, context);
    return { op, ed, openingScanEnd, edAudio: await endingAudio(file, ed, signal) };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function distance(a: Sample, b: Sample) {
  let total = 0;
  for (let index = 0; index < a.pixels.length; index += 4) {
    total += Math.abs(a.pixels[index] - b.pixels[index]);
    total += Math.abs(a.pixels[index + 1] - b.pixels[index + 1]);
    total += Math.abs(a.pixels[index + 2] - b.pixels[index + 2]);
  }
  return total / (a.pixels.length * 0.75);
}

function matchWindow(current: Sample[], reference: Sample[], minimumSeconds: number, late = false) {
  let best: { start: number; end: number; hits: number; mean: number; offset: number } | undefined;
  const maximumSeconds = late ? 110 : 150;
  const minimumCoverage = late ? 0.18 : 0.75;
  const maximumGap = late ? 12 : 3;
  const maximumDistance = late ? 24 : 30;
  // Align the sequences by time, then allow one second of local variation around each frame.
  // `current` holds every other sample, so subsampled index i lines up with reference[i * interval + offset].
  for (let offset = -(current.length - 1) * interval; offset < reference.length; offset++) {
    let first = 0, last = 0, hits = 0, changes = 0, total = 0;
    function consider() {
      const span = last - first + 1;
      const seconds = (span - 1) * interval;
      const mean = total / hits;
      if (seconds >= minimumSeconds && seconds <= maximumSeconds && hits / span >= minimumCoverage && changes >= 5 && mean <= 19
        && (!best || hits > best.hits || hits === best.hits && mean < best.mean)) {
        best = { start: current[first].time, end: current[last].time, hits, mean, offset };
      }
    }
    const from = Math.max(0, Math.ceil(-offset / interval));
    const to = Math.min(current.length, Math.ceil((reference.length - offset) / interval));
    for (let index = from; index < to; index++) {
      if (hits && index - last > maximumGap) {
        consider();
        hits = 0;
        changes = 0;
        total = 0;
      }
      const difference = alignedDistance(current[index], reference, index * interval + offset);
      if (difference > maximumDistance) continue;
      if (hits) changes += Number(distance(current[index], current[last]) > 14);
      else first = index;
      last = index;
      hits++;
      total += difference;
    }
    consider();
  }
  return best;
}

function alignedDistance(sample: Sample, reference: Sample[], aligned: number, tolerance = 1) {
  let difference = Infinity;
  for (let nearby = aligned - tolerance; nearby <= aligned + tolerance; nearby++) {
    if (reference[nearby]) difference = Math.min(difference, distance(sample, reference[nearby]));
  }
  return difference;
}

/**
 * The coarse match only checks every other second. Walk outwards one second at a time with the
 * same alignment so the theme edges are accurate to the sampling interval.
 */
function refineWindow(current: Sample[], reference: Sample[], best: { start: number; end: number; offset: number }) {
  let first = current.findIndex(sample => sample.time === best.start);
  let last = current.findIndex(sample => sample.time === best.end);
  if (first < 0 || last < 0) return { start: best.start, end: best.end };
  const matches = (index: number) => alignedDistance(current[index], reference, index + best.offset) <= 30;
  while (first > 0 && matches(first - 1)) first--;
  while (last < current.length - 1 && matches(last + 1)) last++;
  // Each sample stands for the second around it, so the real edge lies between two samples.
  const start = first > 0 ? (current[first - 1].time + current[first].time) / 2 : Math.max(0, current[first].time - 0.5);
  const end = last < current.length - 1 ? (current[last].time + current[last + 1].time) / 2 : current[last].time + 0.5;
  return { start, end };
}

export function matchVideoThemes(current: Fingerprint, reference: Fingerprint): VideoThemes {
  function match(part: 'op' | 'ed') {
    const samples = current[part].filter((_, index) => index % 2 === 0);
    const best = matchWindow(samples, reference[part], part === 'op' ? 70 : 60);
    return best && refineWindow(current[part], reference[part], best);
  }
  return { op: match('op'), ed: match('ed') };
}

export function matchRecap(current: Fingerprint, previous: Fingerprint): VideoThemes['recap'] {
  const early = current.op.filter(sample => sample.time < earlyOpeningEnd);
  const tail = previous.ed;
  const best = matchWindow(early.filter((_, index) => index % 2 === 0), tail, 16);
  if (!best) return undefined;

  let first = early.findIndex(sample => sample.time === best.start);
  let last = early.findIndex(sample => sample.time === best.end);
  // Recap edits can shift the alignment by a few seconds. Require matching footage at each edge.
  const matches = (index: number) => alignedDistance(early[index], tail, index + best.offset, 7) <= 24;
  while (first > 0 && matches(first - 1)) first--;
  while (last + 1 < early.length && matches(last + 1)) last++;
  return { start: Math.max(0, early[first].time - 0.5), end: early[last].time + 0.5 };
}

export function overlapsRecap(opening: VideoThemes['op'], recap: VideoThemes['recap']) {
  return !!opening && !!recap && opening.start < recap.end && recap.start < opening.end;
}

// Sparse matches are only candidates. The queue requires two independent episodes to agree.
export function matchLateOpening(current: Fingerprint, reference: Fingerprint): VideoThemes['op'] {
  const late = current.op.filter(sample => sample.time >= earlyOpeningEnd);
  const early = reference.op.filter(sample => sample.time < earlyOpeningEnd);
  const best = matchWindow(late.filter((_, index) => index % 2 === 0), early, 70, true);
  return best && refineWindow(late, early, best);
}

export function matchEarlySparseOpening(current: Fingerprint, reference: Fingerprint): VideoThemes['op'] {
  // Keep room for an opening that starts before six minutes and ends after it.
  const early = current.op.filter(sample => sample.time < earlyOpeningEnd + 110);
  const best = matchWindow(early.filter((_, index) => index % 2 === 0), reference.op, 70, true);
  return best && best.start < earlyOpeningEnd ? refineWindow(early, reference.op, best) : undefined;
}

function matchKnownTheme(
  currentSamples: Sample[],
  referenceSamples: Sample[],
  known: NonNullable<VideoThemes['op']>,
  minLength: number,
  maxLength: number,
  recap?: VideoThemes['recap']
): VideoThemes['op'] {
  const length = known.end - known.start;
  if (length < minLength || length > maxLength) return undefined;
  const first = referenceSamples.findIndex(sample => sample.time >= known.start);
  if (first < 0 || !referenceSamples.length || referenceSamples.at(-1)!.time < known.end - 1) return undefined;
  const samples = referenceSamples.slice(first).filter((sample, index) => sample.time < known.end && index % interval === 0);
  const phase = referenceSamples[first].time - known.start;
  let best: { range: NonNullable<VideoThemes['op']>; hits: number; mean: number } | undefined;
  for (const [index, sample] of currentSamples.entries()) {
    const start = Math.max(0, sample.time - phase);
    const range = { start, end: start + length };
    if (range.end > currentSamples.at(-1)!.time + 0.5) break;
    if (overlapsRecap(range, recap)) continue;
    let hits = 0, total = 0, changes = 0, firstHit = Infinity, lastHit = -Infinity;
    for (const [offset, ref] of samples.entries()) {
      const frame = currentSamples[index + offset * interval];
      if (!frame) break;
      const difference = alignedDistance(frame, referenceSamples, first + offset * interval);
      if (difference > 30) continue;
      const time = ref.time - known.start;
      if (hits) changes += Number(distance(frame, currentSamples[index + lastHit * interval]) > 14);
      firstHit = Math.min(firstHit, time);
      lastHit = offset;
      hits++;
      total += difference;
    }
    const mean = total / hits;
    if (hits < Math.ceil(samples.length / 5) || mean > 19 || changes < 5
      || firstHit > 16 || lastHit * interval + phase < length - 12) continue;
    if (!best || hits > best.hits || hits === best.hits && mean < best.mean) best = { range, hits, mean };
  }
  return best?.range;
}

export function matchKnownOpening(current: Fingerprint, reference: Fingerprint, opening: NonNullable<VideoThemes['op']>, recap?: VideoThemes['recap']): VideoThemes['op'] {
  return matchKnownTheme(current.op, reference.op, opening, 70, 110, recap);
}

export function matchKnownEnding(current: Fingerprint, reference: Fingerprint, ending: NonNullable<VideoThemes['ed']>): VideoThemes['ed'] {
  return matchKnownTheme(current.ed, reference.ed, ending, 60, 110)
    ?? (current.edAudio && reference.edAudio ? matchKnownAudio(current.edAudio, reference.edAudio, ending) : undefined);
}

/**
 * Combine the picture and soundtrack matches for an ending. The song can start under the episode's
 * last scene, where only the picture repeats, and credits can run over new footage, where only the
 * song repeats, so overlapping matches are joined.
 */
export function mergeEndings(picture: VideoThemes['ed'], song: VideoThemes['ed']): VideoThemes['ed'] {
  if (!picture || !song) return song ?? picture;
  if (picture.start >= song.end || song.start >= picture.end) return song;
  const joined = { start: Math.min(picture.start, song.start), end: Math.max(picture.end, song.end) };
  return joined.end - joined.start <= 130 ? joined : picture;
}

/**
 * Match the ending song between two episodes. This works when the credits run over episode-specific
 * footage, where the picture comparison finds nothing. Returns the range in each episode.
 */
export function matchAudioEndings(current: Fingerprint, reference: Fingerprint): [VideoThemes['ed'], VideoThemes['ed']] {
  const match = current.edAudio && reference.edAudio ? matchAudioPrints(current.edAudio, reference.edAudio) : undefined;
  return [match?.current, match?.reference];
}

export function confirmLateOpening(candidate: NonNullable<VideoThemes['op']>, others: NonNullable<VideoThemes['op']>[]): VideoThemes['op'] {
  const agreement = others.find(other => {
    const startClose = Math.abs(candidate.start - other.start) <= 4;
    const endClose = Math.abs(candidate.end - other.end) <= 4;
    if (startClose && endClose) return true;
    const overlap = Math.min(candidate.end, other.end) - Math.max(candidate.start, other.start);
    return overlap >= 60 && (startClose || endClose);
  });
  if (!agreement) return undefined;
  return { start: Math.min(candidate.start, agreement.start), end: Math.max(candidate.end, agreement.end) };
}

export async function binarySearchFrameCut(
  frameAt: (time: number) => Promise<Sample>,
  low: number,
  high: number
): Promise<{ time: number; change: number }> {
  let lo = Number(low.toFixed(2));
  let hi = Number(high.toFixed(2));
  if (hi - lo <= 0.08) {
    const [a, b] = await Promise.all([frameAt(lo), frameAt(hi)]);
    return { time: Number(((lo + hi) / 2).toFixed(2)), change: distance(a, b) };
  }
  let left = await frameAt(lo);
  let right = await frameAt(hi);
  let bestChange = distance(left, right);
  while (hi - lo > 0.08) {
    const midTime = Number(((lo + hi) / 2).toFixed(2));
    if (midTime <= lo || midTime >= hi) break;
    const mid = await frameAt(midTime);
    const dLeft = distance(left, mid);
    const dRight = distance(mid, right);
    bestChange = Math.max(bestChange, dLeft, dRight);
    if (dLeft >= dRight) {
      hi = midTime;
      right = mid;
    } else {
      lo = midTime;
      left = mid;
    }
  }
  return { time: Number(((lo + hi) / 2).toFixed(2)), change: Math.max(bestChange, distance(left, right)) };
}

/** Find the strongest picture cut or audio switch near an estimated theme edge using binary search. */
export async function refineThemeEdges(file: File, themes: VideoThemes, signal: AbortSignal): Promise<VideoThemes> {
  const parts = (['op', 'ed', 'recap'] as const).filter(part => themes[part]);
  if (!parts.length) return themes;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return themes;
  const url = URL.createObjectURL(file);
  const audioTrackPromise = parseMp4AudioTrack(file).catch(() => null);

  async function frameAt(time: number): Promise<Sample> {
    await waitForFrame(video, 'seeked', signal, () => { video.currentTime = time; });
    const { videoWidth: width, videoHeight: height } = video;
    context!.drawImage(video, width * 0.08, height * 0.1, width * 0.84, height * 0.8, 0, 0, canvas.width, canvas.height);
    return { time, pixels: context!.getImageData(0, 0, canvas.width, canvas.height).data };
  }

  async function sharpen(estimate: number, radius: number) {
    const lo = Math.max(0.01, estimate - radius);
    const hi = Math.min(video.duration - 0.05, estimate + radius);
    if (hi - lo <= 0.1) return estimate;
    const audioTrack = await audioTrackPromise;
    const [cut, audioSamples] = await Promise.all([
      binarySearchFrameCut(frameAt, lo, hi),
      audioTrack ? readMp4AudioWindow(file, lo, hi, signal, audioTrack).catch(() => null) : Promise.resolve(null),
    ]);
    const audioSwitch = audioSamples ? findAudioSwitch(audioSamples, estimate, radius) : null;
    if (cut.change >= 12) {
      if (audioSwitch && Math.abs(audioSwitch.time - cut.time) <= 0.25) {
        return Number(((cut.time + audioSwitch.time) / 2).toFixed(2));
      }
      return cut.time;
    }
    if (audioSwitch && audioSwitch.strength >= 0.45) {
      return Number(audioSwitch.time.toFixed(2));
    }
    return estimate;
  }

  try {
    await waitForFrame(video, 'loadeddata', signal, () => { video.src = url; });
    const refined: VideoThemes = { ...themes };
    for (const part of parts) {
      const range = themes[part]!;
      const radius = part === 'op' && range.start >= earlyOpeningEnd ? 1.5 : 0.6;
      const start = await sharpen(range.start, radius);
      const end = await sharpen(range.end, radius);
      refined[part] = end - start >= (part === 'recap' ? 16 : 30) ? { start, end } : range;
    }
    return refined;
  } catch (error) {
    if (signal.aborted) throw error;
    return themes;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
