import { Directory, File, Paths } from 'expo-file-system';

/**
 * Every address the Mac answers on (Tailscale name, Tailscale IP, home network), as it last reported
 * them in catalog.json. When the current one stops answering — new Wi-Fi, mobile data, Mac on
 * another network — the app switches to whichever still works, without asking.
 */

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'server-addresses.json');

function read(): string[] {
  try {
    if (file.exists) {
      const saved = JSON.parse(file.textSync()) as { addresses?: unknown };
      if (Array.isArray(saved.addresses)) return saved.addresses.filter((item): item is string => typeof item === 'string');
    }
  } catch { /* Start empty. */ }
  return [];
}

export function rememberAddresses(list: unknown) {
  if (!Array.isArray(list)) return;
  const addresses = list.filter((item): item is string => typeof item === 'string' && /^https?:\/\//.test(item)).slice(0, 8);
  if (!addresses.length || JSON.stringify(addresses) === JSON.stringify(read())) return;
  try {
    if (!folder.exists) folder.create({ intermediates: true });
    file.write(JSON.stringify({ addresses }));
  } catch { /* Best effort. */ }
}

export function knownAddresses(current: string) {
  return [...new Set([current, ...read()])];
}

async function answers(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}catalog.json`, { method: 'HEAD', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The first known address that answers, in preference order, or null when the Mac is away. */
export async function findReachableAddress(current: string, timeoutMs = 3000): Promise<string | null> {
  const candidates = knownAddresses(current);
  const results = await Promise.all(candidates.map(url => answers(url, timeoutMs)));
  const index = results.indexOf(true);
  return index >= 0 ? candidates[index] : null;
}
