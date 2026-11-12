import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/pins.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { findFolder, pinnedLinks, pinnedRows, removePin } = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);

const tree = () => [
  { id: 'a', type: 'link', title: 'A', url: 'https://a.test' },
  { id: 'work', type: 'folder', title: 'Work', children: [
    { id: 'b', type: 'link', title: 'B', url: 'https://b.test' },
    { id: 'docs', type: 'folder', title: 'Docs', collapsed: true, children: [
      { id: 'c', type: 'link', title: 'C', url: 'https://c.test' }
    ] }
  ] }
];

test('pinned rows walk nested folders with depth and parent folder', () => {
  const rows = pinnedRows(tree());
  assert.deepEqual(rows.map(({ item, depth }) => `${item.id}:${depth}`), ['a:0', 'work:0', 'b:1', 'docs:1', 'c:2']);
  assert.equal(rows.find(({ item }) => item.id === 'c').folder.id, 'docs');
  assert.equal(rows.find(({ item }) => item.id === 'c').rootIndex, 1);
});

test('visible rows skip the contents of collapsed folders at any depth', () => {
  assert.deepEqual(pinnedRows(tree(), true).map(({ item }) => item.id), ['a', 'work', 'b', 'docs']);
});

test('pinned links include links inside nested folders', () => {
  assert.deepEqual(pinnedLinks(tree()).map((link) => link.id), ['a', 'b', 'c']);
});

test('findFolder finds nested folders and ignores links', () => {
  assert.equal(findFolder(tree(), 'docs').title, 'Docs');
  assert.equal(findFolder(tree(), 'c'), undefined);
  assert.equal(findFolder(tree(), 'missing'), undefined);
});

test('removePin removes a deeply nested item without mutating the input', () => {
  const items = tree();
  const result = removePin(items, 'c');
  assert.deepEqual(pinnedLinks(result).map((link) => link.id), ['a', 'b']);
  assert.equal(pinnedLinks(items).length, 3);
  assert.deepEqual(pinnedRows(removePin(items, 'work')).map(({ item }) => item.id), ['a']);
});
