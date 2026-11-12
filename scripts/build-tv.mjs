import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('outputs/samsung-tv/AnimeStudy');
await mkdir(output, { recursive: true });
await cp('tv/samsung', output, { recursive: true });
await cp('public/anime-icons/icon128.png', resolve(output, 'icon.png'));
const config = await readFile('tv/samsung/config.xml', 'utf8');
const version = config.match(/\bversion="(\d+\.\d+\.\d+)"\s+viewmodes=/)?.[1];
if (!version) throw new Error('Samsung TV app version is missing.');
await build({
  entryPoints: ['src/tv/main.ts'],
  bundle: true,
  target: 'chrome76',
  define: { __TV_VERSION__: JSON.stringify(version) },
  outfile: resolve(output, 'tv.js')
});
console.log(`Samsung TV project built at ${output}`);
