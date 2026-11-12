import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'outputs/ipad');
await mkdir(output, { recursive: true });
const metadata = `// ==UserScript==
// @name         Arc Japanese Learning
// @namespace    arc-japanese-learning
// @version      1.1.0
// @description  Listening quizzes and automatic spaced repetition for Japanese videos.
// @match        https://*/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.xmlHttpRequest
// @connect      *
// ==/UserScript==
`;
await build({
  configFile: false, root,
  plugins: [svelte({ compilerOptions: { css: 'injected' } })],
  build: {
    outDir: output, emptyOutDir: false, minify: true,
    lib: { entry: resolve(root, 'src/japanese/userscript.ts'), name: 'ArcJapaneseIPad', formats: ['iife'], fileName: () => 'arc-japanese.user.js' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
const script = resolve(output, 'arc-japanese.user.js');
await writeFile(script, metadata + await readFile(script, 'utf8'));
console.log(`iPad Userscripts file: ${script}`);
