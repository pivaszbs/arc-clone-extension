import { normalizeTeamOrder } from './series';

/**
 * The dubbing teams the user prefers, primary first, shared by every series and by downloads the
 * phone asks the Mac for. AUTO_FALLBACK at the end means "then any other dubbing".
 */
const key = 'arc-dub-order';

export async function loadDubOrder(): Promise<string[]> {
  try {
    const saved = (await chrome.storage.local.get(key))[key];
    return Array.isArray(saved) ? normalizeTeamOrder(saved.filter((team): team is string => typeof team === 'string')) : [];
  } catch { return []; }
}

export async function saveDubOrder(order: string[]) {
  try { await chrome.storage.local.set({ [key]: normalizeTeamOrder(order) }); } catch { /* Not saved outside the extension. */ }
}
