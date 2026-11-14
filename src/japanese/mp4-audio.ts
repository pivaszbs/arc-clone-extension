export type AudioEnergySample = { time: number; rms: number };

type Mp4AudioTrack = {
  timescale: number;
  description?: Uint8Array;
  stts: { count: number; delta: number }[];
  stsc: { firstChunk: number; samplesPerChunk: number }[];
  sizes: Uint32Array;
  chunkOffsets: number[];
};

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readU64(view: DataView, offset: number): number {
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 4294967296 + lo;
}

function boxType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function* iterBoxes(view: DataView, start: number, end: number) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32(view, pos);
    const type = boxType(view, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = readU64(view, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function extractEsdsConfig(bytes: Uint8Array): Uint8Array | undefined {
  // Walk ISO 14496-1 descriptor tags inside esds (skipping 4-byte FullBox header).
  let pos = 4;
  while (pos + 2 < bytes.length) {
    const tag = bytes[pos++];
    let len = 0;
    for (let i = 0; i < 4 && pos < bytes.length; i++) {
      const b = bytes[pos++];
      len = (len << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    if (tag === 0x05 && len > 0 && pos + len <= bytes.length) {
      return bytes.slice(pos, pos + len);
    }
    if (tag === 0x03) pos += 3; // ES_ID(2) + flags(1)
    else if (tag === 0x04) pos += 13; // DecoderConfigDescriptor header
    else pos += len;
  }
  return undefined;
}

async function readBoxHeader(file: File, offset: number): Promise<{ type: string; size: number; header: number } | null> {
  if (offset + 8 > file.size) return null;
  const buf = await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer();
  const view = new DataView(buf);
  let size = readU32(view, 0);
  const type = boxType(view, 4);
  let header = 8;
  if (size === 1) {
    if (buf.byteLength < 16) return null;
    size = readU64(view, 8);
    header = 16;
  } else if (size === 0) {
    size = file.size - offset;
  }
  if (size < header) return null;
  return { type, size, header };
}

export async function parseMp4AudioTrack(file: File): Promise<Mp4AudioTrack | null> {
  let pos = 0;
  let moovBuf: ArrayBuffer | null = null;
  while (pos + 8 <= file.size) {
    const box = await readBoxHeader(file, pos);
    if (!box) break;
    if (box.type === 'moov') {
      if (box.size > 32_000_000) return null;
      moovBuf = await file.slice(pos + box.header, pos + box.size).arrayBuffer();
      break;
    }
    pos += box.size;
  }
  if (!moovBuf) return null;
  const moov = new DataView(moovBuf);

  for (const trak of iterBoxes(moov, 0, moov.byteLength)) {
    if (trak.type !== 'trak') continue;
    let handler = '';
    let timescale = 48000;
    let description: Uint8Array | undefined;
    const stts: { count: number; delta: number }[] = [];
    const stsc: { firstChunk: number; samplesPerChunk: number }[] = [];
    let sizes: Uint32Array | null = null;
    const chunkOffsets: number[] = [];

    for (const mdia of iterBoxes(moov, trak.start, trak.end)) {
      if (mdia.type !== 'mdia') continue;
      for (const box of iterBoxes(moov, mdia.start, mdia.end)) {
        if (box.type === 'mdhd') {
          const ver = moov.getUint8(box.start);
          const tsOffset = box.start + (ver === 1 ? 20 : 12);
          if (tsOffset + 4 <= box.end) timescale = readU32(moov, tsOffset);
        } else if (box.type === 'hdlr' && box.start + 12 <= box.end) {
          handler = boxType(moov, box.start + 8);
        } else if (box.type === 'minf') {
          for (const minfChild of iterBoxes(moov, box.start, box.end)) {
            if (minfChild.type !== 'stbl') continue;
            for (const stblChild of iterBoxes(moov, minfChild.start, minfChild.end)) {
              const s = stblChild.start;
              if (stblChild.type === 'stsd' && s + 16 <= stblChild.end) {
                for (const entry of iterBoxes(moov, s + 8, stblChild.end)) {
                  if (entry.type === 'mp4a' && entry.start + 28 <= entry.end) {
                    for (const sub of iterBoxes(moov, entry.start + 28, entry.end)) {
                      if (sub.type === 'esds') {
                        description = extractEsdsConfig(new Uint8Array(moovBuf, sub.start, sub.end - sub.start));
                      }
                    }
                  }
                }
              } else if (stblChild.type === 'stts' && s + 8 <= stblChild.end) {
                const count = readU32(moov, s + 4);
                for (let i = 0; i < count && s + 8 + i * 8 + 8 <= stblChild.end; i++) {
                  stts.push({ count: readU32(moov, s + 8 + i * 8), delta: readU32(moov, s + 12 + i * 8) });
                }
              } else if (stblChild.type === 'stsc' && s + 8 <= stblChild.end) {
                const count = readU32(moov, s + 4);
                for (let i = 0; i < count && s + 8 + i * 12 + 12 <= stblChild.end; i++) {
                  stsc.push({ firstChunk: readU32(moov, s + 8 + i * 12), samplesPerChunk: readU32(moov, s + 12 + i * 12) });
                }
              } else if (stblChild.type === 'stsz' && s + 12 <= stblChild.end) {
                const fixed = readU32(moov, s + 4);
                const count = readU32(moov, s + 8);
                if (fixed > 0) {
                  sizes = new Uint32Array(count).fill(fixed);
                } else {
                  sizes = new Uint32Array(count);
                  for (let i = 0; i < count && s + 12 + i * 4 + 4 <= stblChild.end; i++) {
                    sizes[i] = readU32(moov, s + 12 + i * 4);
                  }
                }
              } else if (stblChild.type === 'stco' && s + 8 <= stblChild.end) {
                const count = readU32(moov, s + 4);
                for (let i = 0; i < count && s + 8 + i * 4 + 4 <= stblChild.end; i++) {
                  chunkOffsets.push(readU32(moov, s + 8 + i * 4));
                }
              } else if (stblChild.type === 'co64' && s + 8 <= stblChild.end) {
                const count = readU32(moov, s + 4);
                for (let i = 0; i < count && s + 8 + i * 8 + 8 <= stblChild.end; i++) {
                  chunkOffsets.push(readU64(moov, s + 8 + i * 8));
                }
              }
            }
          }
        }
      }
    }

    if (handler === 'soun' && sizes && chunkOffsets.length && stsc.length && stts.length) {
      return { timescale, description, stts, stsc, sizes, chunkOffsets };
    }
  }
  return null;
}

function sampleTime(stts: Mp4AudioTrack['stts'], timescale: number, targetIndex: number): number {
  let idx = 0;
  let ticks = 0;
  for (const run of stts) {
    if (idx + run.count > targetIndex) {
      return (ticks + (targetIndex - idx) * run.delta) / timescale;
    }
    idx += run.count;
    ticks += run.count * run.delta;
  }
  return ticks / timescale;
}

function locateSampleRange(track: Mp4AudioTrack, startSec: number, endSec: number) {
  const startTicks = Math.max(0, Math.floor(startSec * track.timescale));
  const endTicks = Math.max(startTicks + 1, Math.ceil(endSec * track.timescale));
  let idx = 0;
  let ticks = 0;
  let firstSample = 0;
  let lastSample = track.sizes.length - 1;
  let foundFirst = false;
  for (const run of track.stts) {
    const runTicks = run.count * run.delta;
    if (!foundFirst && ticks + runTicks >= startTicks) {
      firstSample = idx + Math.max(0, Math.floor((startTicks - ticks) / Math.max(1, run.delta)));
      foundFirst = true;
    }
    if (ticks + runTicks >= endTicks) {
      lastSample = Math.min(track.sizes.length - 1, idx + Math.ceil((endTicks - ticks) / Math.max(1, run.delta)));
      break;
    }
    idx += run.count;
    ticks += runTicks;
  }

  const samples: { index: number; offset: number; size: number; time: number }[] = [];
  let sampleIdx = 0;
  let stscIdx = 0;
  for (let chunk = 1; chunk <= track.chunkOffsets.length && sampleIdx <= lastSample; chunk++) {
    while (stscIdx + 1 < track.stsc.length && chunk >= track.stsc[stscIdx + 1].firstChunk) stscIdx++;
    const count = track.stsc[stscIdx].samplesPerChunk;
    let offset = track.chunkOffsets[chunk - 1];
    for (let i = 0; i < count && sampleIdx < track.sizes.length; i++, sampleIdx++) {
      const size = track.sizes[sampleIdx];
      if (sampleIdx >= firstSample && sampleIdx <= lastSample) {
        samples.push({
          index: sampleIdx,
          offset,
          size,
          time: sampleTime(track.stts, track.timescale, sampleIdx),
        });
      }
      offset += size;
    }
  }
  return samples;
}

export async function readMp4AudioWindow(
  file: File,
  startSec: number,
  endSec: number,
  signal?: AbortSignal,
  cachedTrack?: Mp4AudioTrack | null
): Promise<AudioEnergySample[] | null> {
  if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') return null;
  const track = cachedTrack !== undefined ? cachedTrack : await parseMp4AudioTrack(file);
  if (!track || !track.description) return null;
  signal?.throwIfAborted();

  const samples = locateSampleRange(track, startSec, endSec);
  if (samples.length < 4) return null;
  const minOffset = samples[0].offset;
  const maxEnd = samples[samples.length - 1].offset + samples[samples.length - 1].size;
  if (maxEnd - minOffset > 8_000_000) return null;

  const chunkBuf = await file.slice(minOffset, maxEnd).arrayBuffer();
  signal?.throwIfAborted();

  const energy: AudioEnergySample[] = [];
  let decoderError = false;
  const decoder = new AudioDecoder({
    output: frame => {
      const frames = frame.numberOfFrames;
      const channels = frame.numberOfChannels;
      const pcm = new Float32Array(frames);
      let sumSq = 0;
      const copyCount = Math.min(channels, 2);
      for (let ch = 0; ch < copyCount; ch++) {
        frame.copyTo(pcm, { planeIndex: ch, format: 'f32-planar' });
        for (let i = 0; i < frames; i++) sumSq += pcm[i] * pcm[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, frames * copyCount));
      energy.push({ time: frame.timestamp / 1_000_000, rms });
      frame.close();
    },
    error: () => { decoderError = true; }
  });

  try {
    decoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: track.timescale,
      numberOfChannels: 2,
      description: track.description,
    });
    for (const s of samples) {
      if (decoderError) break;
      const data = new Uint8Array(chunkBuf, s.offset - minOffset, s.size);
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(s.time * 1_000_000),
        data,
      }));
    }
    await decoder.flush();
  } catch {
    return null;
  } finally {
    try { decoder.close(); } catch { /* ignore */ }
  }
  return energy.length ? energy.sort((a, b) => a.time - b.time) : null;
}

/**
 * Decode a long stretch of the audio track and hand each decoded block to `onFrame` as mono PCM.
 * Audio is interleaved with video, so only the audio runs are read rather than the whole byte range.
 */
export async function decodeMp4Audio(
  file: File,
  startSec: number,
  endSec: number,
  onFrame: (time: number, mono: Float32Array, sampleRate: number) => void,
  signal?: AbortSignal,
  cachedTrack?: Mp4AudioTrack | null
): Promise<boolean> {
  if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') return false;
  const track = cachedTrack !== undefined ? cachedTrack : await parseMp4AudioTrack(file);
  if (!track || !track.description) return false;
  signal?.throwIfAborted();

  const samples = locateSampleRange(track, startSec, endSec);
  if (samples.length < 4) return false;
  const runs: { offset: number; end: number; samples: typeof samples }[] = [];
  let encodedBytes = 0;
  for (const sample of samples) {
    const run = runs.at(-1);
    if (run && run.end === sample.offset) {
      run.end += sample.size;
      run.samples.push(sample);
    } else {
      runs.push({ offset: sample.offset, end: sample.offset + sample.size, samples: [sample] });
    }
    encodedBytes += sample.size;
  }
  if (encodedBytes > 24_000_000) return false;

  let decoderError = false;
  const decoder = new AudioDecoder({
    output: frame => {
      try {
        const frames = frame.numberOfFrames;
        const channels = Math.min(frame.numberOfChannels, 2);
        const mono = new Float32Array(frames);
        const plane = new Float32Array(frames);
        for (let ch = 0; ch < channels; ch++) {
          frame.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
          for (let i = 0; i < frames; i++) mono[i] += plane[i] / channels;
        }
        onFrame(frame.timestamp / 1_000_000, mono, frame.sampleRate);
      } finally {
        frame.close();
      }
    },
    error: () => { decoderError = true; }
  });

  try {
    decoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: track.timescale,
      numberOfChannels: 2,
      description: track.description,
    });
    for (const run of runs) {
      if (decoderError) break;
      signal?.throwIfAborted();
      const bytes = await file.slice(run.offset, run.end).arrayBuffer();
      for (const s of run.samples) {
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(s.time * 1_000_000),
          data: new Uint8Array(bytes, s.offset - run.offset, s.size),
        }));
      }
    }
    await decoder.flush();
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  } finally {
    try { decoder.close(); } catch { /* ignore */ }
  }
  return !decoderError;
}

/**
 * Locate the strongest audio switch (silence dip or sudden RMS energy step)
 * within `[estimate - radius, estimate + radius]`.
 */
export function findAudioSwitch(
  samples: AudioEnergySample[],
  estimate: number,
  radius: number
): { time: number; strength: number } | null {
  const window = samples.filter(s => s.time >= estimate - radius && s.time <= estimate + radius);
  if (window.length < 10) return null;

  const sortedRms = window.map(s => s.rms).sort((a, b) => a - b);
  const median = sortedRms[Math.floor(sortedRms.length / 2)];
  const span = Math.max(3, Math.floor(window.length / 8));

  let best: { time: number; strength: number } | null = null;
  for (let i = span; i < window.length - span; i++) {
    let leftSum = 0;
    let rightSum = 0;
    for (let k = i - span; k < i; k++) leftSum += window[k].rms;
    for (let k = i; k < i + span; k++) rightSum += window[k].rms;
    const leftMean = leftSum / span;
    const rightMean = rightSum / span;
    const stepStrength = Math.abs(rightMean - leftMean) / Math.max(leftMean, rightMean, median, 1e-4);

    // Also reward a brief silence dip right at the boundary.
    const dipStrength = median > 1e-4 && window[i].rms < median * 0.25
      ? Math.min(1, (median - window[i].rms) / median)
      : 0;
    const strength = Math.max(stepStrength, dipStrength * 0.9);
    if (strength >= 0.4 && (!best || strength > best.strength)) {
      best = { time: window[i].time, strength };
    }
  }
  return best;
}
