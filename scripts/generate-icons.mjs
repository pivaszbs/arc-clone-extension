import { mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '../public/icons');
const animeIconsDir = resolve(__dirname, '../public/anime-icons');
mkdirSync(iconsDir, { recursive: true });
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

function generateIconPng(size, anime = false) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const center = (size - 1) / 2;
  const radius = size * 0.45;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Rounded rect / squircle mask
      const nx = Math.abs(dx) / radius;
      const ny = Math.abs(dy) / radius;
      const squircle = Math.pow(nx, 3.2) + Math.pow(ny, 3.2);

      if (squircle <= 1.0) {
        // Gradient background (Arc Indigo -> Coral/Pink)
        const tx = x / size;
        const ty = y / size;
        let r = Math.round(92 + tx * 145 - ty * 20);
        let g = Math.round(70 + (1 - ty) * 60);
        let b = Math.round(235 - ty * 55);

        // Draw white Arc arch symbol in the center
        const archDx = (x - center) / (size * 0.24);
        const archDy = (y - center * 1.06) / (size * 0.24);
        const archR = Math.sqrt(archDx * archDx + archDy * archDy);
        const isArchCurve = archDy <= 0.15 && archR >= 0.68 && archR <= 1.12;
        const isArchLegs =
          archDy > 0.05 &&
          archDy <= 0.85 &&
          Math.abs(archDx) >= 0.68 &&
          Math.abs(archDx) <= 1.12;

        if (isArchCurve || isArchLegs) {
          r = 255;
          g = 250;
          b = 255;
        }

        if (anime) {
          r = Math.round(105 + tx * 45);
          g = Math.round(31 + (1 - ty) * 35);
          b = Math.round(79 + (1 - ty) * 29);
          const playX = dx / size;
          const playY = Math.abs(dy / size);
          if (playX >= -0.14 && playX <= 0.22 && playY <= (0.22 - playX) * 0.62) {
            r = 255;
            g = 244;
            b = 231;
          }
        }

        const alpha = squircle > 0.92 ? Math.max(0, Math.round(((1 - squircle) / 0.08) * 255)) : 255;
        raw[idx] = Math.min(255, Math.max(0, r));
        raw[idx + 1] = Math.min(255, Math.max(0, g));
        raw[idx + 2] = Math.min(255, Math.max(0, b));
        raw[idx + 3] = alpha;
      } else {
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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
  writeFileSync(resolve(iconsDir, `icon${size}.png`), generateIconPng(size));
  writeFileSync(resolve(animeIconsDir, `icon${size}.png`), generateIconPng(size, true));
}
console.log('Generated Arc and Anime Study icons.');
