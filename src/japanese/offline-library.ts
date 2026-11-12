export interface DownloadFolder extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}

export const directoryPicker = (window as Window & {
  showDirectoryPicker?: (options: { id: string; mode: 'read'; startIn: 'downloads' }) => Promise<DownloadFolder>;
}).showDirectoryPicker?.bind(window);

function folderStore(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest) {
  return new Promise<DownloadFolder | undefined>((resolve, reject) => {
    const open = indexedDB.open('arc-offline-library', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('folders');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('folders', mode);
      const result = request(transaction.objectStore('folders'));
      transaction.oncomplete = () => { database.close(); resolve(result.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
}

export function rememberedFolder() {
  return folderStore('readonly', store => store.get('last'));
}

export function rememberFolder(folder: DownloadFolder) {
  return folderStore('readwrite', store => store.put(folder, 'last'));
}

const isEpisodeFile = (name: string) => /\.(mp4|webm|m4v|ass|ssa|srt|vtt)$/i.test(name);
export const isEpisodeVideo = (name: string) => /\.(mp4|webm|m4v)$/i.test(name);

async function readEpisodeFiles(entries: FileSystemHandle[]) {
  const files: File[] = [];
  for (const handle of entries) {
    if (handle.kind === 'file' && isEpisodeFile(handle.name)) {
      try { files.push(await (handle as FileSystemFileHandle).getFile()); }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      }
    }
  }
  return files;
}

export type EpisodeFolder = { key: string; name: string; files: File[] };

async function listEntries(folder: FileSystemDirectoryHandle) {
  const entries: FileSystemHandle[] = [];
  for await (const entry of folder.values()) entries.push(entry);
  return entries;
}

export async function readEpisodeFolders(folder: DownloadFolder): Promise<EpisodeFolder[]> {
  const entries = await listEntries(folder);
  const root = { key: '', name: folder.name, files: await readEpisodeFiles(entries) };
  const children = await Promise.all(entries.filter(entry => entry.kind === 'directory').map(async entry => {
    const child = entry as FileSystemDirectoryHandle;
    try {
      return { key: child.name, name: child.name, files: await readEpisodeFiles(await listEntries(child)) };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }));
  return [root, ...children]
    .filter((entry): entry is EpisodeFolder => !!entry && entry.files.some(file => isEpisodeVideo(file.name)))
    .sort((a, b) => a.key.localeCompare(b.key));
}
