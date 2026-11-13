import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/japanese/arc-explainer.ts'], bundle: true, write: false, format: 'esm' });
const {
  extractEpisodeNumberFromName,
  extractSeriesIdFromName,
  parseSeriesArcMetadata,
  selectStoryCuesForExplainer,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('extracts series id and episode number from folder and file names', () => {
  assert.equal(extractSeriesIdFromName('Смотреть аниме Hell Mode - 42441 - StudioBand'), '42441');
  assert.equal(extractEpisodeNumberFromName('Episode 014 - 6015965.mp4'), 14);
});

test('selectStoryCuesForExplainer excludes OP/ED and separates recap lines', () => {
  const cues = [
    { start: 10, end: 14, text: 'Previously on the dungeon raid' },
    { start: 80, end: 85, text: 'Opening theme lyrics line' },
    { start: 200, end: 204, text: 'We must reach the third floor' },
    { start: 500, end: 504, text: 'Watch out for the shadow knight' },
    { start: 1320, end: 1325, text: 'Ending theme lyrics line' },
  ];
  const result = selectStoryCuesForExplainer(cues, {
    recap: { start: 5, end: 20 },
    op: { start: 75, end: 165 },
    ed: { start: 1300, end: 1390 },
  });
  assert.deepEqual(result.recapLines, ['Previously on the dungeon raid']);
  assert.deepEqual(result.storyLines, ['We must reach the third floor', 'Watch out for the shadow knight']);
});

test('parseSeriesArcMetadata extracts cleaned synopsis, genres, and episode title', () => {
  const meta = parseSeriesArcMetadata({
    data: {
      title: 'Test Series',
      descriptions: [{ value: '<p>Hero enters <b>hell mode</b>.</p>' }],
      genres: [{ title: 'Action' }, { title: 'Fantasy' }],
      episodes: [{ episodeInt: 14, episodeTitle: 'Shadow Guild' }],
    },
  }, 14);
  assert.equal(meta.seriesTitle, 'Test Series');
  assert.equal(meta.episodeTitle, 'Shadow Guild');
  assert.equal(meta.synopsis, 'Hero enters hell mode.');
  assert.deepEqual(meta.genres, ['Action', 'Fantasy']);
});
