import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { episodeCode, playPath, searchPath, seasonsOf, streamLabel, streamsPath } from '../shared/tv-stremio.ts';

const hash = 'a4a01fa88c9714cf66bcd3d2a769a47c8f51527a';

/** Runs a native/tv/stremio.py function on JSON input and returns its JSON result. */
function python(fn, payload) {
  const script = `import json, sys\nfrom native.tv import stremio\nprint(json.dumps(stremio.${fn}(json.loads(sys.stdin.read()))))`;
  return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify(payload), encoding: 'utf8' }));
}

test('Movies & TV paths encode queries and only accept torrent hashes', () => {
  assert.equal(searchPath('movie', ' dune part two '), 'stremio/search.json?type=movie&q=dune%20part%20two');
  assert.equal(streamsPath('series', 'tt0903747:1:2'), 'stremio/streams.json?type=series&id=tt0903747%3A1%3A2');
  assert.equal(playPath({ infoHash: hash, fileIdx: 3 }), `stremio/play/${hash}/3`);
  assert.equal(playPath({ infoHash: hash, fileIdx: -1 }), `stremio/play/${hash}/-1`);
  assert.throws(() => playPath({ infoHash: '../../etc', fileIdx: 0 }));
});

test('seasons list specials last and episodes get SxxEyy codes', () => {
  const eps = [{ season: 0, episode: 1 }, { season: 2, episode: 1 }, { season: 1, episode: 4 }].map((ep, i) => ({ ...ep, id: `tt1:${i}`, name: '' }));
  assert.deepEqual(seasonsOf(eps), [1, 2, 0]);
  assert.equal(episodeCode({ season: 1, episode: 4 }), 'S01E04');
});

test('stream labels show quality, size, seeders and a warning for unplayable formats', () => {
  const label = streamLabel({ infoHash: hash, fileIdx: 0, quality: '1080p', title: 'Movie.mkv', release: '', seeders: 12, size: '2.1 GB', risky: true });
  assert.deepEqual(label, { main: '1080p · 2.1 GB', info: '12 seeders · Movie.mkv · may not play on TV' });
});

test('Torrentio answers are ordered for TV streaming: playable formats, 1080p, then most seeders', () => {
  const streams = python('stream_options', { streams: [
    { name: 'Torrentio\n4k', title: 'Movie 2160p DTS-HD\n👤 300 💾 20 GB ⚙️ TPB', infoHash: hash.toUpperCase(), fileIdx: 0 },
    { name: 'Torrentio\n1080p', title: 'Movie 1080p x264\n👤 50 💾 2.1 GB ⚙️ YTS', infoHash: 'b'.repeat(40),
      behaviorHints: { filename: 'Movie.1080p.x264.mp4' } },
    { name: 'Torrentio\n720p', title: 'Dead\n👤 0 💾 1 GB', infoHash: 'c'.repeat(40), fileIdx: 1 },
    { name: 'Torrentio\n4k DV', title: 'Movie 2160p DV\n👤 900 💾 60 GB', infoHash: 'd'.repeat(40), fileIdx: 0 },
    { name: 'Torrentio\n720p', title: 'Movie 720p\n👤 80 💾 900 MB', infoHash: 'e'.repeat(40), fileIdx: 0 },
    { name: 'Torrentio\n1080p', title: 'Movie 1080p\n👤 90 💾 3 GB', infoHash: 'f'.repeat(40), fileIdx: 0 },
    { name: 'Debrid', url: 'https://example.com/file.mp4' }
  ] });
  assert.deepEqual(streams.map(s => [s.quality, s.seeders, s.size, s.risky, s.fileIdx]), [
    ['1080p', 90, '3 GB', false, 0],
    ['1080p', 50, '2.1 GB', false, -1],
    ['720p', 80, '900 MB', false, 0],
    ['4k DV', 900, '60 GB', true, 0],
    ['4k', 300, '20 GB', true, 0]
  ]);
  assert.equal(streams[1].title, 'Movie.1080p.x264.mp4');
  assert.equal(streams[4].infoHash, hash);
});

test('Cinemeta series answers become sorted episode lists', () => {
  const meta = python('series_meta', { meta: { id: 'tt0903747', type: 'series', name: 'Breaking Bad', poster: 'http://x/p.jpg', videos: [
    { id: 'tt0903747:2:1', season: 2, number: 1, name: 'Seven Thirty-Seven' },
    { id: 'tt0903747:0:1', season: 0, number: 1, name: 'Special' },
    { id: 'tt0903747:1:1', season: 1, episode: 1, title: 'Pilot' },
    { id: 'bad id', season: 1, number: 2 }
  ] } });
  assert.equal(meta.name, 'Breaking Bad');
  assert.equal(meta.poster, null);
  assert.deepEqual(meta.episodes.map(ep => [ep.id, ep.name]), [
    ['tt0903747:1:1', 'Pilot'], ['tt0903747:2:1', 'Seven Thirty-Seven'], ['tt0903747:0:1', 'Special']
  ]);
});
