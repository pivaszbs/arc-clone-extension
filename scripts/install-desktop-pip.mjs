import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { registerHost } from '../native/desktop-pip/registration.mjs';

if (process.platform !== 'darwin') throw new Error('The desktop companion requires macOS.');
function unpackedId(directory) {
  return createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

const ids = process.argv[2] ? [process.argv[2]] : ['dist', 'dist-arc'].map(unpackedId);
await access('outputs/desktop-pip/Arc Desktop Video.app/Contents/MacOS/ArcDesktopVideo');
const destination = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
for (const id of ids) {
  const file = await registerHost(destination, id);
  console.log(`Registered desktop Picture in Picture for ${id} in ${file}`);
}
