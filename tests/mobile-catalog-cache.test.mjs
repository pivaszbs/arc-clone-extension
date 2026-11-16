import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const transpile = path => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

// Load storage.ts with an in-memory catalog.json in place of the device's file system.
function storageWith(catalog) {
  const run = (code, modules) => {
    const exports = {};
    runInNewContext(code, { exports, require: name => modules[name], console });
    return exports;
  };
  const sidecar = run(transpile('mobile/src/lib/theme-sidecar.ts'), {});
  class File {
    constructor(_dir, name) { this.name = name; }
    get exists() { return this.name === 'catalog.json'; }
    textSync() { return JSON.stringify(catalog); }
    write() {}
  }
  class Directory { get exists() { return true; } create() {} }
  return run(transpile('mobile/src/lib/storage.ts'), {
    'expo-file-system': { Directory, File, Paths: { document: '' } },
    './replica': { canonicalEpisodeKey: key => key, registerSeriesAlias() {}, setLocal() {} },
    './theme-sidecar': sidecar,
  });
}

test('a cached catalog in the Mac\'s raw shape is ignored instead of crashing the app at launch', () => {
  const raw = [{
    id: 'f5f702ce2dea8557', folder: 'Series', title: 'Series', poster: '0/poster',
    episodes: [{ name: 'Episode 001.mp4', video: '0/video', subtitles: null, saved: { themes: {} } }],
  }];
  assert.equal(storageWith(raw).cachedCatalog().length, 0);
});

test('cached episodes always have skip ranges', () => {
  const saved = [{
    folder: 'Series', title: 'Series', credit: '',
    episodes: [{ video: 'Episode 001.mp4', label: 'Episode 1', key: 'id/Episode 001.mp4', videoUri: 'http://mac/0/video',
      frames: { op: { start: 10, end: 100 } } },
    { video: 'Episode 002.mp4', label: 'Episode 2', key: 'id/Episode 002.mp4', videoUri: 'http://mac/1/video' }],
  }];
  const [series] = JSON.parse(JSON.stringify(storageWith(saved).cachedCatalog()));
  assert.deepEqual(series.episodes.map(ep => ep.frames), [{ op: { start: 10, end: 100 } }, {}]);
});
