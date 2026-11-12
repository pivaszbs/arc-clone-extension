import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
// Content scripts share an isolated world. Keep native class fields so esbuild
// does not emit colliding private-field helpers outside each script's IIFE.
const contentTarget = 'chrome120';

async function buildExtensionScripts() {
  // 1. Build Background Service Worker
  await build({
    configFile: false,
    root: rootDir,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/background/index.ts'),
        name: 'ArcBackground',
        formats: ['es'],
        fileName: () => 'background.js'
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });

  // 2. Build Content Script (IIFE so Chrome content_scripts can execute directly, with CSS injected)
  await build({
    configFile: false,
    root: rootDir,
    plugins: [
      svelte({
        compilerOptions: {
          css: 'injected'
        }
      })
    ],
    build: {
      target: contentTarget,
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, 'src/content/index.ts'),
        name: 'ArcContentScript',
        formats: ['iife'],
        fileName: () => 'content.js'
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });

  await build({
    configFile: false,
    root: rootDir,
    plugins: [svelte({ compilerOptions: { css: 'injected' } })],
    build: {
      outDir: 'dist', emptyOutDir: false, target: contentTarget,
      lib: { entry: resolve(rootDir, 'src/japanese/main.ts'), name: 'ArcJapanese', formats: ['iife'], fileName: () => 'japanese.js' },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  });

  await build({
    configFile: false,
    root: rootDir,
    build: {
      outDir: 'dist', emptyOutDir: false, target: contentTarget,
      lib: { entry: resolve(rootDir, 'src/video/main.ts'), name: 'ArcVideo', formats: ['iife'], fileName: () => 'video.js' },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  });

  const newVer = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;
  console.log(`Successfully built background.js and content.js into dist/ (v${newVer})`);
}

buildExtensionScripts().catch((err) => {
  console.error(err);
  process.exit(1);
});
