import { mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const animeIconsDir = resolve(__dirname, '../public/anime-icons');
mkdirSync(animeIconsDir, { recursive: true });

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) {
      inside = !inside;
    }
  }
  return inside;
}

// Design coordinates use a 100 × 100 canvas. The open book doubles as a video screen.
const book = [[20, 29], [36, 27], [50, 33], [64, 27], [80, 29],
  [80, 69], [64, 67], [50, 74], [36, 67], [20, 69]];
const play = [[43, 39], [43, 61], [62, 50]];
const supersampling = 4;

function animeColor(x, y, fullBleed) {
  const left = Math.max(25 - x, 0, x - 75);
  const top = Math.max(25 - y, 0, y - 75);
  if (!fullBleed && Math.hypot(left, top) > 22) return null;
  if (insidePolygon(x, y, play)) return [173, 43, 75];
  if (insidePolygon(x, y, book)) return [255, 246, 227];
  const shade = (x + y) / 200;
  return [218 - 93 * shade, 61 - 35 * shade, 94 - 37 * shade];
}

function drawAnimeIcon(size, fullBleed = false) {
  const channels = fullBleed ? 3 : 4;
  const stride = size * channels + 1;
  const raw = Buffer.alloc(size * stride);
  const samples = supersampling ** 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rgb = [0, 0, 0];
      let coverage = 0;
      for (let sample = 0; sample < samples; sample++) {
        const sx = x + (sample % supersampling + 0.5) / supersampling;
        const sy = y + (Math.floor(sample / supersampling) + 0.5) / supersampling;
        const color = animeColor(sx * 100 / size, sy * 100 / size, fullBleed);
        if (!color) continue;
        coverage++;
        for (let channel = 0; channel < 3; channel++) rgb[channel] += color[channel];
      }
      if (!coverage) continue;
      const offset = y * stride + 1 + x * channels;
      for (let channel = 0; channel < 3; channel++) {
        raw[offset + channel] = Math.round(rgb[channel] / coverage);
      }
      if (!fullBleed) raw[offset + 3] = Math.round(255 * coverage / samples);
    }
  }
  return raw;
}

function encodePng(size, raw, alpha = true) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA or RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', iend)
  ]);
}

for (const size of [16, 48, 128]) {
  // public/icons (Arc clone) come from arc-browser/brand/cra-segments-icon.svg:
  //   rsvg-convert -w N -h N arc-browser/brand/cra-segments-icon.svg -o public/icons/iconN.png
  writeFileSync(resolve(animeIconsDir, `icon${size}.png`), encodePng(size, drawAnimeIcon(size)));
}
const mobileSize = 1024;
writeFileSync(resolve(__dirname, '../mobile/assets/icon.png'),
  encodePng(mobileSize, drawAnimeIcon(mobileSize, true), false));
console.log('Generated Anime Study icons.');
