import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/japanese/audio-print.ts'], bundle: true, write: false, format: 'esm' });
const { createAudioPrintBuilder, matchAudioPrints, matchKnownAudio } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const rate = 16000;

function random(seed) {
  // Hash the seed so neighbouring seeds don't start nearly identical sequences.
  let state = Math.imul(seed ^ 0x5bd1e995, 0x9e3779b1) >>> 0;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 2 ** 32;
  };
  for (let i = 0; i < 4; i++) next();
  return next;
}

/** Music-like audio: a new three-note chord every 0.3 s, picked from a seeded sequence. */
function music(seed) {
  const notes = new Map();
  return time => {
    const step = Math.floor(time / 0.3);
    if (!notes.has(step)) {
      const next = random(seed * 7919 + step);
      notes.set(step, [0, 1, 2].map(() => 300 + next() * 2400));
    }
    return notes.get(step).reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * time), 0) * 0.08;
  };
}

/**
 * Build the print of an ending window that is `length` seconds long. `parts` lists audio segments:
 * [startInWindow, endInWindow, source(time since segment start)].
 */
function print(length, parts, noiseSeed = 1, windowStart = 1200) {
  const builder = createAudioPrintBuilder(windowStart, windowStart + length);
  const noise = random(noiseSeed);
  const block = 1024;
  for (let first = 0; first < length * rate; first += block) {
    const pcm = new Float32Array(block);
    for (let i = 0; i < block; i++) {
      const time = (first + i) / rate;
      const part = parts.find(([start, end]) => time >= start && time < end);
      pcm[i] = (part ? part[2](time - part[0]) : 0) + (noise() - 0.5) * 0.004;
    }
    builder.push(windowStart + first / rate, pcm, rate);
  }
  return builder.finish();
}

const song = music(42);

test('finds the same ending song at different points of two episodes', () => {
  const first = print(160, [[0, 30, music(1)], [30, 120, song], [120, 160, music(2)]]);
  const second = print(160, [[0, 52, music(3)], [52, 142, song], [142, 160, music(4)]], 2);
  const match = matchAudioPrints(first, second);
  assert.ok(match, 'expected a match');
  assert.ok(Math.abs(match.current.start - 1230) <= 0.5, `first start ${match.current.start}`);
  assert.ok(Math.abs(match.current.end - 1320) <= 0.5, `first end ${match.current.end}`);
  assert.ok(Math.abs(match.reference.start - 1252) <= 0.5, `second start ${match.reference.start}`);
  assert.ok(Math.abs(match.reference.end - 1342) <= 0.5, `second end ${match.reference.end}`);
});

test('does not match unrelated music or silence', () => {
  const first = print(160, [[0, 160, music(5)]]);
  const second = print(160, [[0, 160, music(6)]], 3);
  assert.equal(matchAudioPrints(first, second), undefined);
  const quiet = print(160, []);
  const quieter = print(160, [], 4);
  assert.equal(matchAudioPrints(quiet, quieter), undefined);
});

test('ignores a short shared jingle', () => {
  const jingle = music(77);
  const first = print(160, [[0, 100, music(7)], [100, 125, jingle], [125, 160, music(8)]]);
  const second = print(160, [[0, 60, music(9)], [60, 85, jingle], [85, 160, music(10)]], 5);
  assert.equal(matchAudioPrints(first, second), undefined);
});

test('finds a known ending song even when the episode cuts it short', () => {
  const reference = print(160, [[0, 40, music(11)], [40, 130, song], [130, 160, music(12)]]);
  // This episode's credits stop the song 25 seconds early.
  const current = print(160, [[0, 70, music(13)], [70, 135, song], [135, 160, music(14)]], 6);
  const found = matchKnownAudio(current, reference, { start: 1240, end: 1330 });
  assert.ok(found, 'expected a match');
  assert.ok(Math.abs(found.start - 1270) <= 0.5, `start ${found.start}`);
  assert.ok(Math.abs(found.end - 1335) <= 0.5, `end ${found.end}`);
});
