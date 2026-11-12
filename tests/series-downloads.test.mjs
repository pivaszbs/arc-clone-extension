import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/background/series-downloads.ts'], bundle: true, write: false, format: 'iife', globalName: 'series' });

test('downloads one file at a time and resumes without repeating completed files', async () => {
  const store = {};
  const downloads = [];
  const alarmListeners = [];
  const changedListeners = [];
  const startListeners = [];
  const runtime = { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`,
    onStartup: { addListener: fn => startListeners.push(fn) } };
  const chrome = {
    runtime,
    storage: { local: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async values => Object.assign(store, structuredClone(values))
    } },
    alarms: { onAlarm: { addListener: fn => alarmListeners.push(fn) }, create: async () => {}, clear: async () => {} },
    downloads: {
      onChanged: { addListener: fn => changedListeners.push(fn), hasListener: fn => changedListeners.includes(fn) },
      search: async ({ id, url, filenameRegex }) => downloads.filter(item => id !== undefined
        ? item.id === id : item.url === url && (!filenameRegex || new RegExp(filenameRegex).test(item.filename))),
      cancel: async id => {
        const item = downloads.find(download => download.id === id);
        if (item?.state === 'in_progress') item.state = 'interrupted';
      },
      download: async options => {
        downloads.push({ ...options, id: downloads.length + 1, byExtensionId: runtime.id, state: 'in_progress', exists: true });
        return downloads.length;
      }
    }
  };
  function worker() {
    const world = { chrome, URL };
    vm.runInNewContext(compiled.outputFiles[0].text, world);
    return (type, plan, selectedPages) => world.series.seriesDownloadRequest({ type: `SERIES_DOWNLOAD_${type}`, plan, selectedPages }, { url: runtime.getURL('offline.html') });
  }

  const first = worker();
  const host = 'https://smotret-anime.com';
  const series = host + '/catalog/fixture-1234';
  const plan = { series, title: 'Fixture', episodes: [{
    label: 'Episode 1', page: series + '/1-seriya-2000',
    subtitle: host + '/translations/ass/3000?download=1',
    video: { url: host + '/translations/mp4/3000?height=1080', height: 1080 }
  }] };
  await assert.rejects(first('START', plan), /Select at least one episode/);
  await first('START', plan, [plan.episodes[0].page]);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].filename, /Episode 001 - 3000\.ass$/);
  await first('PAUSE');
  downloads[0].state = 'complete';
  changedListeners[0]({ state: { current: 'complete' } });
  assert.equal((await first('STATUS')).queue.files[0].state, 'done');
  assert.equal(downloads.length, 1);
  const restarted = worker();
  await restarted('RESUME');
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].filename, /Episode 001 - 3000\.mp4$/);
  downloads[1].state = 'complete';
  alarmListeners.at(-1)({ name: 'arc-series-downloads' });
  assert.equal((await restarted('STATUS')).queue.files.every(file => file.state === 'done'), true);
  assert.equal(downloads.length, 2);

  const secondPage = series + '/2-seriya-2001';
  const dub = { ...plan, edition: 'Fixture Dub', episodes: [plan.episodes[0], {
    label: 'Episode 2', page: secondPage,
    video: { url: host + '/translations/mp4/3001?height=1080', height: 1080 }
  }] };
  await assert.rejects(restarted('START', dub, []), /Select at least one episode/);
  const { queue } = await restarted('START', dub, [secondPage]);
  assert.equal(queue.files.length, 1);
  assert.match(queue.folder, /Fixture Dub$/);
  assert.match(queue.files[0].filename, /Episode 002 - 3001\.mp4$/);

  await restarted('STOP');
  assert.equal(downloads.at(-1).state, 'interrupted');
  const thirdPage = series + '/3-seriya-2002';
  const full = { ...dub, episodes: [...dub.episodes, {
    label: 'Episode 3', page: thirdPage,
    video: { url: host + '/translations/mp4/3002?height=1080', height: 1080 }
  }] };
  const count = downloads.length;
  await restarted('START', full, [thirdPage]);
  assert.equal(downloads.length, count + 1);
  assert.match(downloads[count].filename, /Episode 003 - 3002\.mp4$/);

  await restarted('STOP');
  await restarted('START', full, full.episodes.map(episode => episode.page));
  const excluded = downloads.at(-1);
  assert.match(excluded.filename, /Episode 001/);
  const updated = (await restarted('APPLY', full, [thirdPage])).queue;
  assert.equal(excluded.state, 'interrupted');
  assert.equal(updated.files.length, 1);
  assert.match(downloads.at(-1).filename, /Episode 003 - 3002\.mp4$/);
  assert.equal(downloads[1].state, 'complete');
});
