import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arc = 'dist-arc';
const anime = 'dist';
const unpackedId = directory => createHash('sha256').update(resolve(root, directory)).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const readJSON = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const version = (await readJSON('package.json')).version;
const arcManifest = await readJSON('public/manifest.json');
const animeManifest = {
  manifest_version: 3,
  name: 'Anime Study',
  version,
  description: 'Watch downloaded episodes, study Japanese subtitles, and detect openings and endings.',
  permissions: ['tabs', 'storage', 'alarms', 'nativeMessaging'],
  optional_permissions: ['downloads'],
  host_permissions: ['<all_urls>'],
  action: { default_title: 'Open Anime Study', default_icon: arcManifest.icons },
  icons: arcManifest.icons,
  background: arcManifest.background,
  externally_connectable: { ids: [unpackedId(arc)] },
  content_scripts: [{ matches: ['<all_urls>'], js: ['japanese.js'], all_frames: true, match_about_blank: true, run_at: 'document_idle' }]
};

await Promise.all(['arc', 'anime'].map(mode => build({ root, mode, build: { emptyOutDir: true } })));

async function bundle(outDir, source, name, file, { module = false, css = false, define = {} } = {}) {
  await build({
    configFile: false, root, publicDir: false, define,
    plugins: css ? [svelte({ compilerOptions: { css: 'injected' } })] : [],
    build: {
      target: 'chrome120', outDir, emptyOutDir: false,
      lib: { entry: resolve(root, source), name, formats: [module ? 'es' : 'iife'], fileName: () => file },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  });
}

await bundle(arc, 'src/background/index.ts', 'ArcBackground', 'background.js', { module: true, define: { __ARC_LEGACY_ID__: JSON.stringify(unpackedId(anime)) } });
await bundle(arc, 'src/content/index.ts', 'ArcContentScript', 'content.js', { css: true });
await bundle(arc, 'src/video/main.ts', 'ArcVideo', 'video.js');
await bundle(anime, 'src/background/anime.ts', 'AnimeBackground', 'background.js', { module: true, define: { __ARC_BROWSER_ID__: JSON.stringify(unpackedId(arc)) } });
await bundle(anime, 'src/japanese/main.ts', 'AnimeStudy', 'japanese.js', { css: true });

for (const [outDir, manifest] of [[arc, arcManifest], [anime, animeManifest]]) {
  await cp(resolve(root, outDir === anime ? 'public/anime-icons' : 'public/icons'), resolve(root, outDir, 'icons'), { recursive: true });
  await writeFile(resolve(root, outDir, 'manifest.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
}
console.log(`Built Arc for Chrome in ${arc}/ and Anime Study in ${anime}/ (v${version})`);
