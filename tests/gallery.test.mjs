import assert from 'node:assert/strict';
import test from 'node:test';
import { folderSeriesId, folderTitle, groupByTitle } from '../src/japanese/gallery.ts';

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
