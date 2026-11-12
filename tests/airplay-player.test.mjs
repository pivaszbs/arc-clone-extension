import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = await readFile('native/cast/airplay-player.js', 'utf8');

async function player(range, properties = {}) {
  const nodes = new Map();
  const intervals = [];
  function element(selector) {
    if (!nodes.has(selector)) {
      const events = new Map();
      nodes.set(selector, {
        hidden: true, textContent: '',
        addEventListener(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
        emit(name) { for (const handler of events.get(name) || []) handler(); },
        append() {}, load() {}
      });
    }
    return nodes.get(selector);
  }
  const video = Object.assign(element('video'), {
    currentTime: 1300, duration: 1422, playbackRate: 1, paused: false,
    seeking: false, webkitCurrentPlaybackTargetIsWireless: true, webkitShowPlaybackTargetPicker() {}
  }, properties);
  runInNewContext(source, {
    document: { querySelector: element, createElement: element },
    fetch: async () => ({ ok: true, json: async () => ({ title: 'Episode 14', position: 1300, skips: { ed: range } }) }),
    setInterval(callback) { intervals.push(callback); }
  });
  await new Promise(resolve => setImmediate(resolve));
  const tick = time => { video.currentTime = time; intervals.forEach(callback => callback()); };
  return { video, tick, element };
}

test('AirPlay shows the ending countdown and skips even without media events', async () => {
  const { video, tick, element } = await player({ start: 1303, end: 1396, auto: true });
  tick(1303);
  assert.equal(element('.skip').hidden, false);
  assert.equal(element('#skip').textContent, 'Skip ending');
  assert.equal(element('#countdown').textContent, 'Skipping in 5 s');
  for (let time = 1304; time <= 1308; time++) tick(time);
  assert.equal(video.currentTime, 1396);
});

test('manual AirPlay skip stays available when the remote seek flag lags and the media was remuxed', async () => {
  const { video, tick, element } = await player({ start: 1303, end: 1422.25, auto: false }, { seeking: true });
  tick(1319);
  assert.equal(element('.skip').hidden, false);
  assert.equal(element('#keep').hidden, true);
  element('#skip').emit('click');
  assert.equal(video.currentTime, 1422);
});

test('keeping the ending cancels auto-skip and leaves the manual control', async () => {
  const { video, tick, element } = await player({ start: 1303, end: 1396, auto: true });
  tick(1303);
  element('#keep').emit('click');
  for (let time = 1304; time <= 1310; time++) tick(time);
  assert.equal(video.currentTime, 1310);
  assert.equal(element('.skip').hidden, false);
  assert.equal(element('#countdown').textContent, '');
});
