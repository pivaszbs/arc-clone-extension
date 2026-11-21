#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ENDPOINT_FILE =
  process.env.CRA_SYNC_ENDPOINT_FILE ||
  path.join(os.homedir(), 'Library/Application Support/Cra/sync-endpoint.json');

export async function readEndpoint(filePath = ENDPOINT_FILE) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.token || !Array.isArray(parsed.urls)) {
      return { ok: false, error: 'Malformed sync-endpoint.json' };
    }
    return { ok: true, endpoint: parsed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Cra endpoint unavailable'
    };
  }
}

export function encodeNativeMessage(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

async function handleStdin() {
  const chunks = [];
  process.stdin.on('data', async (chunk) => {
    chunks.push(chunk);
    let buf = Buffer.concat(chunks);
    chunks.length = 0;
    while (buf.length >= 4) {
      const length = buf.readUInt32LE(0);
      if (buf.length < 4 + length) {
        chunks.push(buf);
        return;
      }
      const messageRaw = buf.subarray(4, 4 + length).toString('utf8');
      buf = buf.subarray(4 + length);
      let req = {};
      try {
        req = JSON.parse(messageRaw);
      } catch {
        process.stdout.write(encodeNativeMessage({ ok: false, error: 'Invalid JSON request' }));
        continue;
      }
      if (req?.type === 'GET_ENDPOINT') {
        process.stdout.write(encodeNativeMessage(await readEndpoint()));
      } else {
        process.stdout.write(encodeNativeMessage({ ok: true, pong: true }));
      }
    }
    if (buf.length > 0) chunks.push(buf);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void handleStdin();
}
