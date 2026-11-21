import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/shared/easels.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
});
const {
  EaselHistory,
  addEaselItem,
  bringToFront,
  createEasel,
  removeEaselItem,
  sendToBack,
  snapBounds,
  updateEaselItem
} = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);

test('Easel CRUD, z-ordering, alignment snapping, and undo/redo history work cleanly', () => {
  const initial = createEasel('Research', 1000, 'e-1');
  const history = new EaselHistory(initial);

  const d1 = history.push(
    addEaselItem(initial, { id: 'i1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, color: '#fff' }, 1001)
  );
  const d2 = history.push(
    addEaselItem(d1, { id: 'i2', kind: 'linkCard', x: 240, y: 104, w: 200, h: 90, color: '#818cf8', url: 'https://swift.org' }, 1002)
  );

  const snapped = snapBounds({ x: 103, y: 200, w: 120, h: 60 }, d2.items);
  assert.equal(snapped.x, 100);
  assert.equal(snapped.guides.x, 100);

  const moved = updateEaselItem(d2, 'i1', { x: 150 });
  const front = bringToFront(moved, 'i1');
  assert.ok(front.items.find((i) => i.id === 'i1').zIndex > front.items.find((i) => i.id === 'i2').zIndex);

  const back = sendToBack(front, 'i1');
  assert.ok(back.items.find((i) => i.id === 'i1').zIndex < back.items.find((i) => i.id === 'i2').zIndex);

  assert.equal(history.canUndo, true);
  const undone = history.undo();
  assert.equal(undone.items.length, 1);
  assert.equal(history.canRedo, true);
  const redone = history.redo();
  assert.equal(redone.items.length, 2);

  const removed = removeEaselItem(redone, 'i2');
  assert.equal(removed.items.length, 1);
});
