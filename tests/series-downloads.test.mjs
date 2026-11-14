import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/background/series-downloads.ts'], bundle: true, write: false, format: 'iife', globalName: 'series' });
const plannerCompiled = await build({ entryPoints: ['src/japanese/series.ts'], bundle: true, write: false, format: 'iife', globalName: 'planner' });

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

test('plans combined fallback dubbing when primary team is missing episodes', async () => {
  const host = 'https://smotret-anime.com';
  const seriesPath = '/catalog/fixture-1234';
  const ep1 = `${seriesPath}/1-seriya-2000`;
  const ep2 = `${seriesPath}/2-seriya-2001`;
  const pages = new Map([
    [`${host}${seriesPath}`, `
      <h1>Fixture Anime</h1>
      <a href="${ep1}">1 серия</a>
      <a href="${ep2}">2 серия</a>
    `],
    [`${host}${ep1}/ozvuchka-3000`, `
      <a class="truncate" href="${ep1}/ozvuchka-3000">StudioBand Amediateka</a>
      <a href="${ep1}/ozvuchka-3001">AniLiberty</a>
      <a href="/translations/mp4/3000?height=1080">1080p</a>
    `],
    [`${host}${ep2}/ozvuchka`, `
      <a class="truncate" href="${ep2}/ozvuchka-4001">AniLiberty</a>
      <a href="${ep2}/ozvuchka-4002">AniDUB</a>
      <a href="/translations/mp4/4001?height=1080">1080p</a>
    `],
    [`${host}${ep2}/ozvuchka-4001`, `
      <a class="truncate" href="${ep2}/ozvuchka-4001">AniLiberty</a>
      <a href="${ep2}/ozvuchka-4002">AniDUB</a>
      <a href="/translations/mp4/4001?height=1080">1080p</a>
    `],
    [`${host}${ep2}/ozvuchka-4002`, `
      <a href="${ep2}/ozvuchka-4001">AniLiberty</a>
      <a class="truncate" href="${ep2}/ozvuchka-4002">AniDUB</a>
      <a href="/translations/mp4/4002?height=720">720p</a>
    `]
  ]);
  const redirects = new Map([
    [`${host}${ep2}/ozvuchka`, `${host}${ep2}/ozvuchka-4001`]
  ]);
  const world = {
    URL,
    AbortSignal,
    fetch: async url => {
      const href = String(url);
      const finalUrl = redirects.get(href) || href;
      const html = pages.get(href);
      return {
        ok: !!html,
        url: finalUrl,
        headers: { get: () => null },
        text: async () => html || ''
      };
    }
  };
  vm.runInNewContext(plannerCompiled.outputFiles[0].text, world);
  const { planSeries, resolveSeriesTeam, resolveEpisodeVariant, AUTO_FALLBACK } = world.planner;

  const plan = await planSeries(`${host}${ep1}/ozvuchka-3000`, () => {});
  assert.equal(plan.primaryTeam, 'StudioBand Amediateka');
  assert.equal(plan.episodes[0].team, 'StudioBand Amediateka');
  assert.equal(plan.episodes[0].video.url, `${host}/translations/mp4/3000?height=1080`);
  assert.equal(plan.episodes[1].video, undefined);
  assert.deepEqual(Array.from(plan.episodes[1].variants, v => v.team), ['AniLiberty', 'AniDUB']);

  const combined = await resolveSeriesTeam(structuredClone(plan), 'AniLiberty');
  assert.equal(combined.episodes[0].team, 'StudioBand Amediateka');
  assert.equal(combined.episodes[1].team, 'AniLiberty');
  assert.equal(combined.episodes[1].video.url, `${host}/translations/mp4/4001?height=1080`);

  const autoFilled = await resolveSeriesTeam(structuredClone(plan), AUTO_FALLBACK);
  assert.equal(autoFilled.episodes[1].team, 'AniLiberty');

  const perEp = await resolveEpisodeVariant(structuredClone(combined), combined.episodes[1].page, 'AniDUB');
  assert.equal(perEp.episodes[1].team, 'AniDUB');
  assert.equal(perEp.episodes[1].video.url, `${host}/translations/mp4/4002?height=720`);

  const cleared = await resolveSeriesTeam(structuredClone(combined), undefined);
  assert.equal(cleared.episodes[0].team, 'StudioBand Amediateka');
  assert.equal(cleared.episodes[1].video, undefined);

  const store = {};
  const downloads = [];
  const runtime = { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, onStartup: { addListener: () => {} } };
  const bgWorld = {
    URL,
    chrome: {
      runtime,
      storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => Object.assign(store, structuredClone(values)) } },
      alarms: { onAlarm: { addListener: () => {} }, create: async () => {}, clear: async () => {} },
      downloads: {
        onChanged: { addListener: () => {}, hasListener: () => true },
        search: async () => [],
        cancel: async () => {},
        download: async options => { downloads.push(options); return downloads.length; }
      }
    }
  };
  vm.runInNewContext(compiled.outputFiles[0].text, bgWorld);
  const { queue } = await bgWorld.series.seriesDownloadRequest(
    { type: 'SERIES_DOWNLOAD_START', plan: combined, selectedPages: combined.episodes.map(e => e.page) },
    { url: runtime.getURL('offline.html') }
  );
  assert.equal(queue.files.length, 2);
  assert.match(queue.files[0].filename, /Episode 001 - 3000\.mp4$/);
  assert.match(queue.files[1].filename, /Episode 002 - 4001\.mp4$/);
});
