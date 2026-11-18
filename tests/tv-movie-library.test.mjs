import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { continueLabel, saveJobLabel } from '../shared/tv-stremio.ts';

/** Runs Python that prints JSON, and returns it parsed. */
function python(code) {
  return JSON.parse(execFileSync('python3', ['-c', `import json\n${code}`], { encoding: 'utf8' }));
}

const hash = 'a'.repeat(40);

test('saved movies and episodes get library folders that group seasons by show', () => {
  const out = python(`
from native.tv.movie_library import target_paths
print(json.dumps([
  target_paths({"type": "movie", "name": "Dune: Part Two", "year": "2024"}),
  target_paths({"type": "series", "name": "Breaking Bad", "showId": "tt0903747", "season": 2, "episode": 3, "episodeName": "Bit by a Dead Bee"}),
  target_paths({"type": "series", "name": "../evil/", "showId": "tt1", "season": 0, "episode": 1, "episodeName": ""}),
]))`);
  assert.deepEqual(out[0], ['Dune Part Two (2024)', 'Dune Part Two (2024)', { title: 'Dune Part Two (2024)' }]);
  assert.deepEqual(out[1], ['Breaking Bad - Season 2', 'Episode 003 - S02E03 Bit by a Dead Bee',
    { title: 'Breaking Bad Season 2', franchise: 'imdb:tt0903747', aired: 2 }]);
  assert.equal(out[2][0], 'evil - Specials');
});

test('conversion copies H.264/HEVC video, tags HEVC for Apple, and makes DTS audio AAC', () => {
  const out = python(`
from native.tv.movie_library import convert_command, subtitle_command
probe = {"streams": [
  {"index": 0, "codec_type": "video", "codec_name": "hevc"},
  {"index": 1, "codec_type": "audio", "codec_name": "dts", "channels": 6, "tags": {"language": "rus"}},
  {"index": 2, "codec_type": "audio", "codec_name": "dts", "channels": 8, "tags": {"language": "eng"}},
  {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle", "tags": {"language": "eng"}},
  {"index": 4, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "eng"}, "disposition": {"forced": 1}},
  {"index": 5, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "eng"}},
]}
print(json.dumps({"video": convert_command(probe, "in.mkv", "out.mp4")[5:], "subs": subtitle_command(probe, "in.mkv", "out.srt")[5:]}))`);
  assert.deepEqual(out.video.slice(0, 7), ['-i', 'in.mkv', '-map', '0:0', '-c:v', 'copy', '-tag:v']);
  assert.ok(out.video.join(' ').includes('-map 0:2 -c:a aac -b:a 256k -ac 6'));
  assert.ok(out.video.join(' ').includes('-movflags +faststart'));
  assert.deepEqual(out.subs.slice(2, 4), ['-map', '0:5']);
});

test('save requests are checked before anything is downloaded', () => {
  const out = python(`
from native.tv.movie_library import validate_request
ok = validate_request({"stream": {"infoHash": "${hash}", "fileIdx": 2}, "item": {"type": "series", "id": "tt1:1:2", "name": "X", "season": 1, "episode": 2}})
bad = []
for body in [{"stream": {"infoHash": "../x"}, "item": {"type": "movie", "id": "tt1"}},
             {"stream": {"infoHash": "${hash}"}, "item": {"type": "movie", "id": "rm -rf"}},
             {"stream": {"infoHash": "${hash}"}, "item": {"type": "series", "id": "tt1:1:2", "season": "1", "episode": 2}}]:
    try: validate_request(body); bad.append("accepted")
    except ValueError: bad.append("rejected")
print(json.dumps({"show": ok["showId"], "file": ok["fileIdx"], "bad": bad}))`);
  assert.deepEqual(out, { show: 'tt1', file: 2, bad: ['rejected', 'rejected', 'rejected'] });
});

test('Continue watching keeps the latest episode per show and drops finished movies', () => {
  const out = python(`
from native.tv.movie_history import continue_watching, clean_entry
p = "stremio/play/${hash}/0"
items = [clean_entry(x) for x in [
  {"id": "tt1:1:1", "path": p, "position": 10, "watchedAt": 1, "finished": True},
  {"id": "tt1:1:2", "path": p, "position": 300, "duration": 1300, "watchedAt": 3},
  {"id": "tt2", "path": p, "position": 0, "watchedAt": 4, "finished": True},
  {"id": "tt3", "path": p, "position": 600, "watchedAt": 2},
]]
print(json.dumps([e["id"] for e in continue_watching(items)]))`);
  assert.deepEqual(out, ['tt1:1:2', 'tt3']);
});

test('Continue watching and save labels read naturally', () => {
  const base = { id: 'tt1:1:2', showId: 'tt1', title: 'Show', poster: null, path: '', bingeGroup: null, watchedAt: 0 };
  assert.equal(continueLabel({ ...base, type: 'series', label: 'S01E02 · Name', position: 300, duration: 1500, finished: false }), 'S01E02 · 20:00 left');
  assert.equal(continueLabel({ ...base, type: 'series', label: 'S01E02 · Name', position: 0, duration: 1500, finished: true }), 'S01E02 · Next episode');
  assert.equal(continueLabel({ ...base, type: 'movie', label: 'Film', position: 3725, duration: null, finished: false }), 'Resume at 1:02:05');
  assert.deepEqual(saveJobLabel({ id: '1', type: 'series', itemId: 'tt1:1:2', name: 'Show', season: 1, episode: 2, state: 'downloading', fraction: 0.4 }),
    { name: 'Show · S01E02', state: 'Downloading 40%' });
});
