export type VideoThemes = Partial<Record<'op' | 'ed', { start: number; end: number }>>;
type Sample = { time: number; pixels: Uint8ClampedArray };
type Fingerprint = { op: Sample[]; ed: Sample[] };

const interval = 2;

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

export async function fingerprintVideo(file: File, signal: AbortSignal): Promise<Fingerprint> {
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
    if (!Number.isFinite(duration) || duration < 180) return { op: [], ed: [] };
    return {
      op: await sampleWindow(0.5, Math.min(360, duration / 2), context),
      ed: await sampleWindow(Math.max(duration - 240, duration / 2), duration - 0.5, context)
    };
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

function matchWindow(current: Sample[], reference: Sample[], minimumSeconds: number) {
  let best: { start: number; end: number; hits: number; mean: number; offset: number } | undefined;
  // Align the sequences by time, then allow one second of local variation around each frame.
  // `current` holds every other sample, so subsampled index i lines up with reference[i * interval + offset].
  for (let offset = -(current.length - 1) * interval; offset < reference.length; offset++) {
    let first = 0, last = 0, hits = 0, changes = 0, total = 0;
    function consider() {
      const span = last - first + 1;
      const seconds = (span - 1) * interval;
      const mean = total / hits;
      if (seconds >= minimumSeconds && seconds <= 150 && hits / span >= 0.75 && changes >= 5 && mean <= 19
        && (!best || hits > best.hits || hits === best.hits && mean < best.mean)) {
        best = { start: current[first].time, end: current[last].time, hits, mean, offset };
      }
    }
    const from = Math.max(0, Math.ceil(-offset / interval));
    const to = Math.min(current.length, Math.ceil((reference.length - offset) / interval));
    for (let index = from; index < to; index++) {
      if (hits && index - last > 3) {
        consider();
        hits = 0;
        changes = 0;
        total = 0;
      }
      const difference = alignedDistance(current[index], reference, index * interval + offset);
      if (difference > 30) continue;
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

function alignedDistance(sample: Sample, reference: Sample[], aligned: number) {
  let difference = Infinity;
  for (const nearby of [aligned, aligned - 1, aligned + 1]) {
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
  function match(part: keyof Fingerprint) {
    const samples = current[part].filter((_, index) => index % 2 === 0);
    const best = matchWindow(samples, reference[part], part === 'op' ? 70 : 60);
    return best && refineWindow(current[part], reference[part], best);
  }
  return { op: match('op'), ed: match('ed') };
}

/** Find the strongest picture cut near an estimated theme edge, so skips land on the exact frame. */
export async function refineThemeEdges(file: File, themes: VideoThemes, signal: AbortSignal): Promise<VideoThemes> {
  const parts = (['op', 'ed'] as const).filter(part => themes[part]);
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

  async function frameAt(time: number): Promise<Sample> {
    await waitForFrame(video, 'seeked', signal, () => { video.currentTime = time; });
    const { videoWidth: width, videoHeight: height } = video;
    context!.drawImage(video, width * 0.08, height * 0.1, width * 0.84, height * 0.8, 0, 0, canvas.width, canvas.height);
    return { time, pixels: context!.getImageData(0, 0, canvas.width, canvas.height).data };
  }

  async function sharpen(estimate: number) {
    const step = 0.1;
    const frames: Sample[] = [];
    for (let time = Math.max(0, estimate - 0.6); time <= Math.min(video.duration - 0.05, estimate + 0.6) + 1e-6; time += step) {
      frames.push(await frameAt(Number(time.toFixed(2))));
    }
    if (frames.length < 3) return estimate;
    const changes = frames.slice(1).map((frame, index) => ({ time: frame.time, change: distance(frames[index], frame) }));
    const sorted = changes.map(item => item.change).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cut = changes.reduce((best, item) => item.change > best.change ? item : best);
    // Fades have no single cut; keep the sampled estimate for them.
    return cut.change >= 12 && cut.change >= median * 3 ? cut.time : estimate;
  }

  try {
    await waitForFrame(video, 'loadeddata', signal, () => { video.src = url; });
    const refined: VideoThemes = { ...themes };
    for (const part of parts) {
      const range = themes[part]!;
      const start = await sharpen(range.start);
      const end = await sharpen(range.end);
      refined[part] = end - start >= 30 ? { start, end } : range;
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
