import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/shared/interaction.ts'], bundle: true, write: false, format: 'esm' });
const { shouldPeek } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const click = (modifiers = {}) => ({ shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...modifiers });

test('Peek follows the chosen modifier and does not hijack normal or browser-modified clicks', () => {
  assert.equal(shouldPeek(click(), { peekTrigger: 'shift-click' }), false);
  assert.equal(shouldPeek(click({ shiftKey: true }), { peekTrigger: 'shift-click' }), true);
  assert.equal(shouldPeek(click({ altKey: true }), { peekTrigger: 'shift-click' }), false);
  assert.equal(shouldPeek(click({ altKey: true }), { peekTrigger: 'alt-click' }), true);
  assert.equal(shouldPeek(click({ shiftKey: true }), { peekTrigger: 'alt-click' }), false);
  assert.equal(shouldPeek(click({ shiftKey: true, altKey: true }), { peekTrigger: 'off' }), false);
  assert.equal(shouldPeek(click({ shiftKey: true, metaKey: true }), { peekTrigger: 'shift-click' }), false);
  assert.equal(shouldPeek(click({ altKey: true, ctrlKey: true }), { peekTrigger: 'alt-click' }), false);
});
