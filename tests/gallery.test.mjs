import assert from 'node:assert/strict';
import test from 'node:test';
import { folderLabel, folderSeriesId, folderTitle, groupByTitle, nextSeasonFolder, seasonOf } from '../src/japanese/gallery.ts';

test('folderTitle splits a download folder into title and translation', () => {
  assert.deepEqual(
    folderTitle('Смотреть аниме Kusuriya no Hitorigoto онлайн - 39868 - Dream Cast'),
    { title: 'Kusuriya no Hitorigoto', credit: 'Dream Cast' }
  );
  assert.equal(folderSeriesId('Смотреть аниме Kusuriya no Hitorigoto онлайн - 39868 - Dream Cast'), '39868');
  assert.equal(folderSeriesId('Imported'), undefined);
});

test('groupByTitle puts translations of the same title on one card', () => {
  const groups = groupByTitle([
    { name: 'Смотреть аниме Frieren онлайн - 1 - SovetRomantica' },
    { name: 'Смотреть аниме Kusuriya онлайн - 39868 - Dream Cast' },
    { name: 'Смотреть аниме Frieren онлайн - 1 - AniLibria' },
  ]);
  assert.deepEqual(groups.map(group => [group.title, group.entries.map(entry => folderTitle(entry.name).credit)]), [
    ['Frieren', ['AniLibria', 'SovetRomantica']],
    ['Kusuriya', ['Dream Cast']],
  ]);
});

test('seasonOf recognises common season suffixes', () => {
  assert.deepEqual(seasonOf('Kusuriya no Hitorigoto 2nd Season'), { base: 'Kusuriya no Hitorigoto', season: 2 });
  assert.deepEqual(seasonOf('Kusuriya no Hitorigoto Season 3'), { base: 'Kusuriya no Hitorigoto', season: 3 });
  assert.deepEqual(seasonOf('Shingeki no Kyojin: The Final Season'.replace('The ', '')), { base: 'Shingeki no Kyojin', season: 1000 });
  assert.deepEqual(seasonOf('Overlord II'), { base: 'Overlord', season: 2 });
  assert.deepEqual(seasonOf('Мой сосед 2 сезон'), { base: 'Мой сосед', season: 2 });
  assert.deepEqual(seasonOf('Mob Psycho 100'), { base: 'Mob Psycho 100', season: 1 });
  assert.deepEqual(seasonOf('86'), { base: '86', season: 1 });
});

test('seasons of a title share a card and continue into the next season', () => {
  const folders = [
    { name: 'Смотреть аниме Kusuriya no Hitorigoto 2nd Season онлайн - 2 - Dream Cast' },
    { name: 'Смотреть аниме Kusuriya no Hitorigoto онлайн - 1 - Dream Cast' },
    { name: 'Смотреть аниме Kusuriya no Hitorigoto 2nd Season онлайн - 2 - AniLibria' },
    { name: 'Смотреть аниме Frieren онлайн - 3 - AniLibria' },
  ];
  const [frieren, kusuriya] = groupByTitle(folders);
  assert.equal(frieren.title, 'Frieren');
  assert.equal(kusuriya.title, 'Kusuriya no Hitorigoto');
  assert.equal(kusuriya.seasons, 2);
  assert.deepEqual(kusuriya.entries.map(entry => folderLabel(entry.name, true)), ['Season 1 · Dream Cast', 'Season 2 · AniLibria', 'Season 2 · Dream Cast']);
  assert.equal(nextSeasonFolder(kusuriya.entries, kusuriya.entries[0]), folders[0]);
  assert.equal(nextSeasonFolder(kusuriya.entries, kusuriya.entries[2]), undefined);
});
