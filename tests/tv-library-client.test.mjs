import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTvSyncEvent, cleanTitle, episodeTitle, privateLibraryAddress } from '../src/tv/library-client.ts';

test('privateLibraryAddress normalizes private LAN URLs and rejects public hosts', () => {
  assert.equal(
    privateLibraryAddress('http://10.131.140.3:46158/cf7f1d1d391d8231'),
    'http://10.131.140.3:46158/cf7f1d1d391d8231/'
  );
  assert.throws(() => privateLibraryAddress('https://example.com/cf7f1d1d391d8231/'));
  assert.throws(() => privateLibraryAddress('http://10.131.140.3:46158/badtoken/'));
});

test('cleanTitle and episodeTitle format folder and file names cleanly', () => {
  assert.equal(
    cleanTitle('Смотреть аниме Kusuriya no Hitorigoto 3rd Season онлайн - 39868 - Dream Cast'),
    'Kusuriya no Hitorigoto 3rd Season'
  );
  assert.equal(episodeTitle('Episode 003 - 6061926.mp4'), 'Episode 3');
});

test('applyTvSyncEvent updates themes, autoSkip, and progress by seriesName', () => {
  const catalog = [{
    id: 'abc',
    title: 'Смотреть аниме Kusuriya - 39868 - Dream Cast',
    episodes: [{ name: 'Episode 003 - 6061926.mp4', video: '2/video', subtitles: null, saved: {} }]
  }];
  const result = applyTvSyncEvent(catalog, {
    type: 'sync',
    seriesName: 'Смотреть аниме Kusuriya - 39868 - Dream Cast',
    episode: 'Episode 003 - 6061926.mp4',
    themes: { op: { start: 7, end: 96, source: 'frame-scan' } },
    autoSkip: { op: false }
  });
  assert.equal(result?.targetIdx, 0);
  assert.equal(result?.themesUpdated, true);
  assert.equal(result?.skipUpdated, true);
  assert.deepEqual(catalog[0].episodes[0].saved?.themes?.op, { start: 7, end: 96, source: 'frame-scan' });
  assert.equal(catalog[0].autoSkip?.op, false);
});
