import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build as bundle } from 'esbuild';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'outputs/safari');
const project = resolve(output, 'JapaneseListening');
const web = resolve(project, 'WebExtension');
await mkdir(web, { recursive: true });
await cp(resolve(root, 'safari/native'), project, { recursive: true });
await cp(resolve(root, 'safari/web'), web, { recursive: true });
await cp(resolve(root, 'public/icons'), resolve(web, 'icons'), { recursive: true });
await build({
  configFile: false, root, publicDir: false,
  plugins: [svelte({ compilerOptions: { css: 'injected' } })],
  build: {
    outDir: web, emptyOutDir: false,
    lib: { entry: resolve(root, 'src/japanese/safari/content.ts'), name: 'JapaneseListeningSafari', formats: ['iife'], fileName: () => 'content.js' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
await bundle({ entryPoints: [resolve(root, 'src/japanese/safari/background.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'safari17', outfile: resolve(web, 'background.js') });
const manifest = JSON.parse(await readFile(resolve(web, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest, JSON.parse(await readFile(resolve(root, 'safari/web/manifest.json'), 'utf8')), 'Safari packaging must preserve its dedicated manifest.');
execFileSync('ruby', [resolve(root, 'scripts/generate-safari-project.rb'), project], { stdio: 'inherit' });
await cp(resolve(root, 'safari/INSTALL.md'), resolve(project, 'INSTALL.md'));
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', project, resolve(output, 'JapaneseListening-Xcode.zip')]);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', web, resolve(output, 'JapaneseListening-WebExtension.zip')]);
await writeFile(resolve(output, 'build-status.json'), JSON.stringify({ name: manifest.name, version: manifest.version, webExtensionBuilt: true, xcodeProjectGenerated: true, appleSdkBuildVerified: false, signed: false, installedOnIPad: false }, null, 2));
console.log('Safari extension and Xcode source packages are ready. Apple SDK compilation and device signing still require Xcode.');
