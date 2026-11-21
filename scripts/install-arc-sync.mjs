import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'local.arcclone.sync';

export function unpackedExtensionId(directory) {
  return createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

export async function registerArcSyncHost({
  destinationDir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
  extensionIds = ['dist', 'dist-arc'].map((d) => unpackedExtensionId(d)),
  hostScript = path.resolve('native/arc-sync/host.mjs'),
  nodePath = process.execPath
} = {}) {
  await mkdir(destinationDir, { recursive: true });
  const launcherPath = path.join(path.dirname(hostScript), 'arc-sync-host.sh');
  const launcherBody = `#!/bin/sh\nexec "${nodePath}" "${hostScript}" "$@"\n`;
  await writeFile(launcherPath, launcherBody, 'utf8');
  await chmod(launcherPath, 0o755);

  const manifest = {
    name: HOST_NAME,
    description: 'Local Cra/Arc live sync discovery bridge',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`)
  };
  const manifestPath = path.join(destinationDir, `${HOST_NAME}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestPath, launcherPath, extensionIds };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv[2] ? [process.argv[2]] : ['dist', 'dist-arc'].map(unpackedExtensionId);
  const res = await registerArcSyncHost({ extensionIds: ids });
  console.log(`Registered ${HOST_NAME} in ${res.manifestPath} for ${res.extensionIds.join(', ')}`);
}
