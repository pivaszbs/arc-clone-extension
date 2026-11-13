import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/japanese/video-themes.ts'], bundle: true, write: false, format: 'esm' });
const { binarySearchFrameCut, confirmLateOpening, matchKnownEnding, matchKnownOpening, matchLateOpening, matchRecap, matchVideoThemes, mergeEndings, overlapsRecap } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const audioBuild = await build({ entryPoints: ['src/japanese/mp4-audio.ts'], bundle: true, write: false, format: 'esm' });
const { findAudioSwitch } = await import('data:text/javascript;base64,' + Buffer.from(audioBuild.outputFiles[0].text).toString('base64'));

function frames(length, makeFrame) {
  return Array.from({ length }, (_, time) => ({ time, pixels: makeFrame(time) }));
}

function frame(seed) {
  return Uint8ClampedArray.from({ length: 384 }, (_, index) => (Math.imul(seed, index * 773 + 2833) >>> (index % 13)) % 256);
}

test('finds a theme that starts an odd number of seconds later in another episode', () => {
  const episode = (start, seed) => frames(155, time => frame(time >= start && time < start + 86 ? time - start + 123 : time + seed));
  const current = { op: episode(32, 700), ed: [] };
  const reference = { op: episode(57, 9800), ed: [] };
  // Frames 32–117 belong to the theme, so its edges lie halfway to the neighbouring samples.
  assert.deepEqual(matchVideoThemes(current, reference), { op: { start: 31.5, end: 117.5 }, ed: undefined });
});

test('places theme edges to the second even when the coarse pass samples every other frame', () => {
  const episode = (start, seed) => frames(170, time => frame(time >= start && time < start + 89 ? time - start + 123 : time + seed));
  const current = { op: episode(33, 700), ed: [] };
  const reference = { op: episode(10, 9800), ed: [] };
  assert.deepEqual(matchVideoThemes(current, reference).op, { start: 32.5, end: 121.5 });
});

test('does not treat a long static sequence as a theme', () => {
  const staticFrames = frames(100, () => new Uint8ClampedArray(384));
  assert.deepEqual(matchVideoThemes({ op: [], ed: staticFrames }, { op: [], ed: staticFrames }), { op: undefined, ed: undefined });
});

test('does not offer to skip a brief repeated prologue', () => {
  const episode = seed => frames(150, time => frame(time < 62 ? time + 123 : time + seed));
  assert.equal(matchVideoThemes({ op: episode(700), ed: [] }, { op: episode(9800), ed: [] }).op, undefined);
});

test('matches a recap to the previous ending and keeps the later opening separate', () => {
  const previous = { op: [], ed: frames(150, time => frame(time + 700)) };
  const current = { op: frames(330, time => frame(time >= 190 && time < 250 ? time - 190 + 730 : time + 10000)), ed: [] };
  const recap = matchRecap(current, previous);
  assert.deepEqual(recap, { start: 189.5, end: 249.5 });
  assert.equal(overlapsRecap({ start: 180, end: 265 }, recap), true);
  assert.equal(overlapsRecap({ start: 250, end: 330 }, recap), false);
  assert.equal(matchRecap(previous, current), undefined);
  assert.equal(matchRecap(current, { op: [], ed: frames(150, time => frame(time + 20000)) }), undefined);
});

test('a late opening with sparse matching frames requires two agreeing references', () => {
  const anchors = new Set([0, 2, 4, 16, 18, 28, 30, 44, 46, 58, 60, 72, 86, 88]);
  const episode = (start, seed) => ({ op: frames(590, time => frame(anchors.has(time - start) ? time - start + 123 : time + seed)), ed: [] });
  const current = episode(480, 700);
  const first = matchLateOpening(current, episode(115, 9800));
  const second = matchLateOpening(current, episode(125, 12400));
  assert.ok(first && second);
  assert.equal(confirmLateOpening(first, []), undefined);
  assert.equal(confirmLateOpening(first, [{ start: 405, end: 493 }]), undefined);
  assert.deepEqual(confirmLateOpening(second, [first]), { start: 479.5, end: 568.5 });
  assert.deepEqual(confirmLateOpening({ start: 88, end: 165.7 }, [{ start: 88, end: 177.8 }]), { start: 88, end: 177.8 });
});

test('matches scattered frames across a known opening after a recap', () => {
  const anchors = new Set([0, 2, 4, 6, 16, 28, 38, 40, 42, 46, 58, 86]);
  const reference = { op: frames(310, time => frame(time + 9800)), ed: [] };
  const episode = anchorSet => ({
    op: frames(300, time => frame(anchorSet.has(time - 76) ? time - 76 + 9900 : time + 700)),
    ed: []
  });
  const opening = { start: 99.5, end: 189.5 };
  const current = episode(anchors);
  assert.equal(matchVideoThemes(current, reference).op, undefined);
  assert.deepEqual(matchKnownOpening(current, reference, opening, { start: 50, end: 66 }), { start: 75.5, end: 165.5 });
  assert.equal(matchKnownOpening(current, reference, opening, { start: 50, end: 85 }), undefined);
  assert.equal(matchKnownOpening(episode(new Set([...anchors].slice(0, -1))), reference, opening), undefined);
});

test('matches a known ending when episode 1 has partial or different credits', () => {
  const reference = { op: [], ed: frames(200, time => frame(time + 9800)) };
  const anchors = new Set([0, 2, 4, 8, 40, 42, 44, 46, 48, 52, 60, 72, 82]);
  const current = {
    op: [],
    ed: frames(200, time => frame(anchors.has(time - 60) ? time - 60 + 9900 : time + 700))
  };
  const ending = { start: 99.5, end: 184.5 };
  assert.equal(matchVideoThemes(current, reference).ed, undefined);
  assert.deepEqual(matchKnownEnding(current, reference, ending), { start: 59.5, end: 144.5 });
});

test('binarySearchFrameCut finds exact cut with logarithmic seeks', async () => {
  let probes = 0;
  const sceneA = frame(100);
  const sceneB = frame(9000);
  const cut = await binarySearchFrameCut(async time => {
    probes++;
    return { time, pixels: time < 10.37 ? sceneA : sceneB };
  }, 9.0, 12.0);
  assert.ok(Math.abs(cut.time - 10.37) <= 0.06, `expected cut near 10.37, got ${cut.time}`);
  assert.ok(cut.change >= 12);
  assert.ok(probes <= 9, `expected <= 9 probes, got ${probes}`);
});

test('findAudioSwitch detects music entry and silence dip transitions', () => {
  const stepSamples = Array.from({ length: 60 }, (_, i) => ({
    time: 10 + i * 0.05,
    rms: i < 32 ? 0.04 : 0.28,
  }));
  const stepSwitch = findAudioSwitch(stepSamples, 11.5, 1.5);
  assert.ok(stepSwitch && Math.abs(stepSwitch.time - 11.6) <= 0.15, `got ${stepSwitch?.time}`);
  assert.ok(stepSwitch.strength >= 0.45);
});

test('joins overlapping picture and song endings, and falls back to whichever exists', () => {
  // Song intro under the last scene: only the picture repeats there.
  assert.deepEqual(mergeEndings({ start: 1341.75, end: 1431.85 }, { start: 1372.8, end: 1432.2 }), { start: 1341.75, end: 1432.2 });
  assert.deepEqual(mergeEndings(undefined, { start: 1302, end: 1392.9 }), { start: 1302, end: 1392.9 });
  assert.deepEqual(mergeEndings({ start: 1300, end: 1390 }, undefined), { start: 1300, end: 1390 });
  // Separate matches: trust the song. A join longer than any ending keeps the picture match.
  assert.deepEqual(mergeEndings({ start: 1200, end: 1260 }, { start: 1300, end: 1390 }), { start: 1300, end: 1390 });
  assert.deepEqual(mergeEndings({ start: 1250, end: 1340 }, { start: 1300, end: 1390 }), { start: 1250, end: 1340 });
});
