import { getRegister } from './replica';
import { skipRanges } from './theme-sidecar';
import { Directory, File, Paths } from 'expo-file-system';
import { animeCore, type EpisodePair, type SkipRanges } from 'react-native-anime-core';

export type Episode = EpisodePair & {
  /** Path relative to the series folder, also the progress key inside it. */
  key: string;
  videoUri: string;
  subtitleUri?: string;
  /** Saved frame predictions (opening, ending, recap) from the extension, if exported. */
  frames: SkipRanges;
};

export type Series = {
  /** Folder name under Documents, or '' for loose files. */
  folder: string;
  title: string;
  credit: string;
  episodes: Episode[];
};

const hidden = new Set(['.anime-study', 'Inbox', '.Trash']);

function readJson(file: File): unknown {
  try { return file.exists ? JSON.parse(file.textSync()) : undefined; } catch { return undefined; }
}

/**
 * Frame predictions come from the extension's video-themes queue. The app reads them from
 * either `video-themes.json` ({ "<file name>": { op, ed, recap } }) or `<episode>.themes.json`.
 */
function framesFor(folder: Directory, videoName: string, shared: Record<string, unknown>, seriesName: string) {
  // Timings shared from the Mac (or found by any worker) win over sidecar files.
  const replicated = seriesName ? getRegister(`ep/${seriesName}/${videoName}/themes`) : undefined;
  if (replicated && typeof replicated === 'object') return skipRanges(replicated);
  const stem = videoName.replace(/\.[^.]+$/, '');
  const own = readJson(new File(folder, `${stem}.themes.json`));
  return skipRanges(own ?? shared[videoName]);
}

function readSeries(folder: Directory, name: string): Series | null {
  const files = folder.list().filter((entry): entry is File => entry instanceof File);
  const byName = new Map(files.map(file => [file.name, file]));
  const pairs = animeCore.pairEpisodes(files.map(file => file.name));
  if (!pairs.length) return null;
  const shared = (readJson(new File(folder, 'video-themes.json')) ?? {}) as Record<string, unknown>;
  const { title, credit } = name ? animeCore.folderTitle(name) : { title: 'Downloads', credit: '' };
  return {
    folder: name,
    title: title || name,
    credit,
    episodes: pairs.map(pair => ({
      ...pair,
      key: name ? `${name}/${pair.video}` : pair.video,
      videoUri: byName.get(pair.video)!.uri,
      subtitleUri: pair.subtitle ? byName.get(pair.subtitle)?.uri : undefined,
      frames: framesFor(folder, pair.video, shared, name),
    })),
  };
}

/** Series in the app's Documents folder (visible in the Files app under "On My iPhone/iPad"). */
export function readLibrary(): Series[] {
  const root = Paths.document;
  const series: Series[] = [];
  const loose = readSeries(root, '');
  if (loose) series.push(loose);
  for (const entry of root.list()) {
    if (!(entry instanceof Directory) || hidden.has(entry.name)) continue;
    try {
      const found = readSeries(entry, entry.name);
      if (found) series.push(found);
    } catch { /* Unreadable folders are skipped. */ }
  }
  return series.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

/** Copies a downloads folder picked in the Files app into the library. */
export async function importFolder() {
  const picked = await Directory.pickDirectoryAsync();
  const target = new Directory(Paths.document, picked.name);
  if (target.exists) target.delete();
  await picked.copy(Paths.document);
  return picked.name;
}

/** Copies loose episode and subtitle files into a folder named after the first file's series. */
export async function importFiles() {
  const picked = await File.pickFileAsync({ multipleFiles: true });
  if (picked.canceled) return null;
  const target = new Directory(Paths.document, 'Imported');
  if (!target.exists) target.create({ intermediates: true });
  for (const file of picked.result) {
    const existing = new File(target, file.name);
    if (existing.exists) existing.delete();
    await file.copy(target);
  }
  return target.name;
}

export async function readText(uri: string) {
  if (/^https?:\/\//i.test(uri)) {
    const res = await fetch(uri);
    return res.ok ? await res.text() : '';
  }
  const file = new File(uri);
  if ((file.size ?? 0) > 5_000_000) return '';
  return file.textSync();
}
