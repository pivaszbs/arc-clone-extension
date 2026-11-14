// Minimal disk-backed stand-in for the parts of expo-file-system the sync code uses.
import fs from 'node:fs';
import path from 'node:path';
const root = () => globalThis.__DOCS__;
const resolve = (parent, name) => path.join(typeof parent === 'string' ? parent : parent.path, name ?? '');
export class Directory {
  constructor(parent, name) { this.path = name === undefined ? (typeof parent === 'string' ? parent : parent.path) : resolve(parent, name); }
  get exists() { return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory(); }
  get name() { return path.basename(this.path); }
  create() { fs.mkdirSync(this.path, { recursive: true }); }
  list() { return fs.readdirSync(this.path).map(n => { const p = path.join(this.path, n); return fs.statSync(p).isDirectory() ? new Directory(p) : new File(p); }); }
}
export class File {
  constructor(parent, name) { this.path = name === undefined ? (typeof parent === 'string' ? parent : parent.path) : resolve(parent, name); }
  get exists() { return fs.existsSync(this.path) && fs.statSync(this.path).isFile(); }
  get size() { return this.exists ? fs.statSync(this.path).size : null; }
  get name() { return path.basename(this.path); }
  get uri() { return 'file://' + this.path; }
  textSync() { return fs.readFileSync(this.path, 'utf8'); }
  write(text) { fs.writeFileSync(this.path, text); }
  delete() { fs.rmSync(this.path); }
  static async downloadFileAsync(url, target) {
    const r = await fetch(url); if (!r.ok) throw new Error('UnableToDownload ' + r.status);
    fs.writeFileSync(target.path, Buffer.from(await r.arrayBuffer())); return target;
  }
  static createDownloadTask(url, target, opts = {}) {
    return { downloadAsync: async () => {
      const r = await fetch(url, { signal: opts.signal }); if (!r.ok) throw new Error('UnableToDownload ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      opts.onProgress?.({ bytesWritten: buf.length, totalBytes: buf.length });
      fs.writeFileSync(target.path, buf); return target;
    } };
  }
}
export const Paths = { get document() { return new Directory(root()); } };
