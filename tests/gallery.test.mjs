import assert from 'node:assert/strict';
import test from 'node:test';
import { folderLabel, folderSeriesId, folderTitle, groupByTitle, nextSeasonFolder, seasonOf } from '../shared/gallery/seasons.ts';

test('folderTitle splits a download folder into title and translation', () => {
  assert.deepEqual(
    folderTitle('Смотреть аниме Kusuriya no Hitorigoto онлайн - 39868 - Dream Cast'),
    { title: 'Kusuriya no Hitorigoto', credit: 'Dream Cast' }
  );
  assert.equal(folderSeriesId('Смотреть аниме Kusuriya no Hitorigoto онлайн - 39868 - Dream Cast'), '39868');
  assert.equal(folderSeriesId('Imported'), undefined);
});

test('seasonOf recognises seasons, parts and named chapters', () => {
  const at = title => { const { base, label } = seasonOf(title); return [base, label]; };
  assert.deepEqual(at('Kusuriya no Hitorigoto 2nd Season'), ['Kusuriya no Hitorigoto', 'Season 2']);
  assert.deepEqual(at('Kusuriya no Hitorigoto Season 3'), ['Kusuriya no Hitorigoto', 'Season 3']);
  assert.deepEqual(at('Overlord II'), ['Overlord', 'Season 2']);
  assert.deepEqual(at('Мой сосед 2 сезон'), ['Мой сосед', 'Season 2']);
  assert.deepEqual(at('Mob Psycho 100'), ['Mob Psycho 100', 'Season 1']);
  assert.deepEqual(at('86'), ['86', 'Season 1']);
  assert.deepEqual(at('Shingeki no Kyojin The Final Season'), ['Shingeki no Kyojin', 'Final season']);
  assert.deepEqual(at('Shingeki no Kyojin: The Final Season Part 2'), ['Shingeki no Kyojin', 'Final season · Part 2']);
  assert.deepEqual(at('Shingeki no Kyojin: The Final Season - Kanketsu-hen'), ['Shingeki no Kyojin', 'Final season · Final Chapters']);
});

// Real folder names: the downloader cuts them at 60 characters.
const titan = [
  'Смотреть аниме Shingeki no Kyojin The Final Season - Kankets - 26139 - Студийная банда Расширенная версия',
  'Смотреть аниме Shingeki no Kyojin The Final Season Part 2 он - 24394 - Wakanim',
  'Смотреть аниме Shingeki no Kyojin The Final Season онлайн - 21166 - Wakanim BD',
].map(name => ({ name }));

test('cut-off folder names of one series share a card in season order', () => {
  const [group] = groupByTitle(titan);
  assert.equal(group.title, 'Shingeki no Kyojin');
  assert.equal(group.seasons, 3);
  assert.deepEqual(group.entries.map(entry => folderLabel(entry.name, true)), [
    'Final season · Wakanim BD',
    'Final season · Part 2 · Wakanim',
    'Final season · Final Chapters · Студийная банда Расширенная версия',
  ]);
  assert.equal(nextSeasonFolder(group.entries, group.entries[0]), group.entries[1]);
  assert.equal(nextSeasonFolder(group.entries, group.entries[1]), group.entries[2]);
  assert.equal(nextSeasonFolder(group.entries, group.entries[2]), undefined);
});

test('catalog titles group what folder names cannot', () => {
  const folders = [{ name: 'Смотреть аниме Shingeki no Kyojin The Final Season Part 2 он - 24394 - Wakanim' }, { name: 'Смотреть аниме Shingeki no Kyo - 1 - X' }];
  const full = { [folders[1].name]: { title: 'Shingeki no Kyojin' } };
  assert.equal(groupByTitle(folders).length, 2);
  assert.equal(groupByTitle(folders, full).length, 1);
});

test('a franchise from the anime database groups sequels with unrelated names, in air order', () => {
  const folders = [
    { name: 'Смотреть аниме Kimetsu no Yaiba Yuukaku-hen онлайн - 2 - AniLibria' },
    { name: 'Смотреть аниме Kimetsu no Yaiba онлайн - 1 - AniLibria' },
    { name: 'Смотреть аниме Kimetsu no Yaiba Mugen Ressha-hen онлайн - 3 - AniLibria' },
  ];
  const catalog = {
    [folders[0].name]: { title: 'Kimetsu no Yaiba: Yuukaku-hen', franchise: 'kimetsu', aired: 300 },
    [folders[1].name]: { title: 'Kimetsu no Yaiba', franchise: 'kimetsu', aired: 100 },
    [folders[2].name]: { title: 'Kimetsu no Yaiba: Mugen Ressha-hen', franchise: 'kimetsu', aired: 200 },
  };
  const groups = groupByTitle(folders, catalog);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Kimetsu no Yaiba');
  assert.deepEqual(groups[0].entries.map(entry => folderLabel(entry.name, true, catalog, groups[0].title)), [
    'Season 1 · AniLibria', 'Mugen Ressha-hen · AniLibria', 'Yuukaku-hen · AniLibria',
  ]);
  assert.equal(nextSeasonFolder(groups[0].entries, folders[2], catalog), folders[0]);
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
