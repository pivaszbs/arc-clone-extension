import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
export const hostName = 'local.arcclone.desktop_video';
export function hostManifest(extensionIds) {
  if (extensionIds.some(id => !/^[a-p]{32}$/.test(id))) throw new Error('Invalid extension ID.');
  return { name:hostName, description:'Local Arc video player across macOS desktops and full-screen Spaces',
    path:path.resolve('outputs/desktop-pip/Arc Desktop Video.app/Contents/MacOS/ArcDesktopVideo'), type:'stdio',
    allowed_origins:extensionIds.map(id=>`chrome-extension://${id}/`) };
}
export async function registerHost(directory, extensionId) {
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,hostName+'.json');
  let existing;
  try { existing=JSON.parse(await readFile(file,'utf8')); } catch(error) { if(error.code !== 'ENOENT') throw error; }
  const result=hostManifest([extensionId]);
  if (existing && existing.path !== result.path) throw new Error(`A different desktop video host already exists at ${file}; refusing to replace it.`);
  result.allowed_origins=[...new Set([...(existing?.allowed_origins || []),...result.allowed_origins])];
  await writeFile(file,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return file;
}
