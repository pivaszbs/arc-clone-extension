import { decodeMp4Audio } from './mp4-audio';

/**
 * A compact soundtrack fingerprint (Haitsma–Kalker style). Every `step` seconds there is a 16-bit
 * word: bit m says whether the energy difference between neighbouring bands m and m+1 grew or shrank
 * since the previous word. The same song gives nearly the same words in every episode, even when the
 * credits are drawn over different footage, while unrelated audio differs in about half the bits.
 */
export type AudioPrint = { start: number; step: number; bits: Uint16Array; loud: Uint8Array };
export type AudioRange = { start: number; end: number };

const fftSize = 2048;
const hop = 1024;
const bandCount = 17;
const lowHz = 300;
const highHz = 3000;
const printStep = 0.1;
const printSpan = 0.4;
const silentRms = 0.004;

function makeFft(size: number) {
  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >> b) & 1);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / size);
    sin[i] = Math.sin(2 * Math.PI * i / size);
  }
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  /** Power spectrum of a Hann-windowed block. */
  return (input: Float32Array, offset: number, power: Float64Array) => {
    for (let i = 0; i < size; i++) {
      re[reverse[i]] = input[offset + i] * window[i];
      im[reverse[i]] = 0;
    }
    for (let width = 2; width <= size; width *= 2) {
      const half = width / 2;
      const stride = size / width;
      for (let base = 0; base < size; base += width) {
        for (let k = 0; k < half; k++) {
          const c = cos[k * stride], s = sin[k * stride];
          const a = base + k, b = a + half;
          const tr = re[b] * c + im[b] * s;
          const ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  };
}

/** Collects decoded PCM blocks and turns them into an AudioPrint covering `[start, end]`. */
export function createAudioPrintBuilder(start: number, end: number) {
  const fft = makeFft(fftSize);
  const power = new Float64Array(fftSize / 2);
  const frames: { time: number; bands: Float64Array; rms: number }[] = [];
  let pending = new Float32Array(fftSize * 4);
  let pendingLength = 0;
  let pendingTime = NaN;
  let rate = 0;
  let edges: Uint16Array | undefined;

  function analyse() {
    if (!edges) {
      const ratio = (highHz / lowHz) ** (1 / bandCount);
      edges = Uint16Array.from({ length: bandCount + 1 }, (_, i) => Math.round(lowHz * ratio ** i * fftSize / rate));
    }
    let offset = 0;
    while (pendingLength - offset >= fftSize) {
      fft(pending, offset, power);
      const bands = new Float64Array(bandCount);
      for (let band = 0; band < bandCount; band++) {
        for (let bin = edges[band]; bin < Math.max(edges[band] + 1, edges[band + 1]); bin++) bands[band] += power[bin];
      }
      let sum = 0;
      for (let i = offset; i < offset + fftSize; i++) sum += pending[i] * pending[i];
      frames.push({ time: pendingTime + (offset + fftSize / 2) / rate, bands, rms: Math.sqrt(sum / fftSize) });
      offset += hop;
    }
    pending.copyWithin(0, offset, pendingLength);
    pendingLength -= offset;
    pendingTime += offset / rate;
  }

  return {
    push(time: number, mono: Float32Array, sampleRate: number) {
      const expected = pendingTime + pendingLength / sampleRate;
      // Restart the stream after a gap or a sample-rate change instead of blending unrelated audio.
      if (!rate || rate !== sampleRate || Math.abs(time - expected) > 0.05) {
        pendingLength = 0;
        pendingTime = time;
        rate = sampleRate;
        edges = undefined;
      }
      if (pendingLength + mono.length > pending.length) {
        const grown = new Float32Array(Math.max(pending.length * 2, pendingLength + mono.length));
        grown.set(pending.subarray(0, pendingLength));
        pending = grown;
      }
      pending.set(mono, pendingLength);
      pendingLength += mono.length;
      analyse();
    },
    finish(): AudioPrint | null {
      const count = Math.floor((end - start) / printStep) + 1;
      if (!frames.length || count < 2) return null;
      const bits = new Uint16Array(count);
      const loud = new Uint8Array(count);
      let previous: Float64Array | undefined;
      let from = 0;
      for (let k = 0; k < count; k++) {
        const time = start + k * printStep;
        while (from < frames.length && frames[from].time < time - printSpan / 2) from++;
        const energy = new Float64Array(bandCount);
        let rms = 0, used = 0;
        for (let i = from; i < frames.length && frames[i].time < time + printSpan / 2; i++) {
          for (let band = 0; band < bandCount; band++) energy[band] += frames[i].bands[band];
          rms += frames[i].rms;
          used++;
        }
        if (!used) { previous = undefined; continue; }
        const log = energy.map(value => Math.log(value + 1e-9));
        if (previous) {
          let word = 0;
          for (let band = 0; band < bandCount - 1; band++) {
            const change = (log[band] - log[band + 1]) - (previous[band] - previous[band + 1]);
            if (change > 0) word |= 1 << band;
          }
          bits[k] = word;
          loud[k] = Number(rms / used >= silentRms);
        }
        previous = log;
      }
      return { start, step: printStep, bits, loud };
    }
  };
}

/** Fingerprint the soundtrack of an MP4 between two times. Returns null when the audio can't be decoded. */
export async function audioPrintFromFile(file: File, start: number, end: number, signal: AbortSignal): Promise<AudioPrint | null> {
  const builder = createAudioPrintBuilder(start, end);
  // Decode a little before the window so the first words have a full analysis span.
  const decoded = await decodeMp4Audio(file, Math.max(0, start - printSpan), end + printSpan, builder.push, signal);
  return decoded ? builder.finish() : null;
}

const popcount = new Uint8Array(1 << 16);
for (let i = 1; i < popcount.length; i++) popcount[i] = popcount[i >> 1] + (i & 1);
function bitErrors(a: number, b: number) {
  return popcount[(a ^ b) & 0xffff];
}

/**
 * Vote for alignments using words that match exactly or within one bit, so only a handful of
 * offsets need a full comparison instead of every possible shift.
 */
function candidateOffsets(current: AudioPrint, reference: AudioPrint, limit = 12) {
  const heads = new Int32Array(1 << 16).fill(-1);
  const next = new Int32Array(reference.bits.length).fill(-1);
  for (let j = 0; j < reference.bits.length; j++) {
    if (!reference.loud[j]) continue;
    next[j] = heads[reference.bits[j]];
    heads[reference.bits[j]] = j;
  }
  const shift = current.bits.length;
  const votes = new Int32Array(current.bits.length + reference.bits.length);
  for (let i = 0; i < current.bits.length; i++) {
    if (!current.loud[i]) continue;
    const word = current.bits[i];
    for (let flip = -1; flip < wordBits; flip++) {
      const key = flip < 0 ? word : word ^ (1 << flip);
      for (let j = heads[key]; j >= 0; j = next[j]) votes[j - i + shift]++;
    }
  }
  const ranked: number[] = [];
  for (let index = 0; index < votes.length; index++) {
    if (votes[index] < 8) continue;
    ranked.push(index);
  }
  ranked.sort((a, b) => votes[b] - votes[a]);
  const offsets = new Set<number>();
  for (const index of ranked.slice(0, limit)) {
    for (let near = -1; near <= 1; near++) offsets.add(index - shift + near);
  }
  return offsets;
}

const wordBits = bandCount - 1;
const blockErrorLimit = 0.3;
const edgeErrorLimit = 0.35;
const quietPadding = 3;

/**
 * Find the longest stretch of shared soundtrack. Returns the stretch in both timelines.
 * The search is symmetric, so one call covers both episodes of a pair.
 */
export function matchAudioPrints(
  current: AudioPrint,
  reference: AudioPrint,
  minimumSeconds = 50,
  maximumSeconds = 130
): { current: AudioRange; reference: AudioRange } | undefined {
  if (Math.abs(current.step - reference.step) > 1e-6) return undefined;
  const perBlock = Math.round(1 / current.step);
  const blocks = Math.floor(current.bits.length / perBlock);
  const maximumGap = 3;
  let best: { offset: number; first: number; last: number; hits: number; errors: number } | undefined;

  // offset: reference word index = current word index + offset
  for (const offset of candidateOffsets(current, reference)) {
    let first = -1, last = -1, hits = 0, errors = 0;
    const consider = () => {
      if (first < 0) return;
      const seconds = (last - first + 1) * perBlock * current.step;
      const span = last - first + 1;
      if (seconds >= minimumSeconds * 0.8 && seconds <= maximumSeconds && hits / span >= 0.7
        && (!best || hits > best.hits || hits === best.hits && errors < best.errors)) {
        best = { offset, first, last, hits, errors };
      }
    };
    for (let block = 0; block < blocks; block++) {
      let count = 0, wrong = 0;
      for (let i = block * perBlock; i < (block + 1) * perBlock; i++) {
        const j = i + offset;
        if (j < 0 || j >= reference.bits.length || !current.loud[i] || !reference.loud[j]) continue;
        wrong += bitErrors(current.bits[i], reference.bits[j]);
        count++;
      }
      if (count < perBlock * 0.6 || wrong / (count * wordBits) > blockErrorLimit) continue;
      if (first >= 0 && block - last > maximumGap + 1) {
        consider();
        first = -1; hits = 0; errors = 0;
      }
      if (first < 0) first = block;
      last = block;
      hits++;
      errors += wrong;
    }
    consider();
  }
  if (!best) return undefined;

  // Blocks only place the song to the second; walk word by word to find its real edges.
  const { offset } = best;
  const wordError = (i: number) => {
    const j = i + offset;
    if (i < 0 || i >= current.bits.length || j < 0 || j >= reference.bits.length) return undefined;
    if (!current.loud[i] || !reference.loud[j]) return undefined;
    return bitErrors(current.bits[i], reference.bits[j]) / wordBits;
  };
  const matches = (i: number) => {
    let total = 0, count = 0;
    for (let k = i - 2; k <= i + 2; k++) {
      const error = wordError(k);
      if (error !== undefined) { total += error; count++; }
    }
    return wordError(i) !== undefined && count >= 3 && total / count <= edgeErrorLimit;
  };
  let startWord = best.first * perBlock;
  let endWord = best.last * perBlock + perBlock - 1;
  while (matches(startWord - 1)) startWord--;
  while (startWord < endWord && !matches(startWord)) startWord++;
  while (matches(endWord + 1)) endWord++;
  while (endWord > startWord && !matches(endWord)) endWord--;
  // Songs are padded by a moment of silence that the skip should cover too. Each episode uses its
  // own silence: look just past the matched edge, then run to the far side of the quiet stretch.
  const round = (value: number) => Number(value.toFixed(2));
  const pad = (print: AudioPrint, firstWord: number, lastWord: number): AudioRange => {
    const size = print.bits.length;
    const reach = Math.round(0.5 / print.step);
    const limit = Math.round(quietPadding / print.step);
    const inside = (k: number) => k >= 0 && k < size;
    const extend = (edge: number, direction: number) => {
      let k = edge + direction;
      for (let n = 0; n < reach && inside(k) && print.loud[k]; n++) k += direction;
      if (!inside(k) || print.loud[k]) return edge;
      for (let n = 0; n < limit && inside(k + direction) && !print.loud[k + direction]; n++) k += direction;
      return k;
    };
    const first = extend(firstWord, -1);
    const last = extend(lastWord, 1);
    return {
      start: round(Math.max(print.start, print.start + (first - 0.5) * print.step)),
      end: round(print.start + (last + 0.5) * print.step)
    };
  };
  const mine = pad(current, startWord, endWord);
  const theirs = pad(reference, startWord + offset, endWord + offset);
  const length = mine.end - mine.start;
  if (length < minimumSeconds || length > maximumSeconds + 2 * quietPadding) return undefined;
  return { current: mine, reference: theirs };
}

/** Find a known ending's song (taken from another episode) inside this episode's ending window. */
export function matchKnownAudio(current: AudioPrint, reference: AudioPrint, known: AudioRange): AudioRange | undefined {
  const length = known.end - known.start;
  if (length < 50 || length > 130) return undefined;
  const first = Math.max(0, Math.ceil((known.start - reference.start) / reference.step));
  const last = Math.min(reference.bits.length - 1, Math.floor((known.end - reference.start) / reference.step));
  if (last - first < 50 / reference.step) return undefined;
  const song: AudioPrint = {
    start: reference.start + first * reference.step,
    step: reference.step,
    bits: reference.bits.subarray(first, last + 1),
    loud: reference.loud.subarray(first, last + 1)
  };
  // Credits sometimes cover only part of the song, so accept a match over most of it.
  return matchAudioPrints(current, song, Math.min(50, length * 0.6), length + 4)?.current;
}
