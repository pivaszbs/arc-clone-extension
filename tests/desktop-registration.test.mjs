import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHost, hostManifest, hostName } from '../native/desktop-pip/registration.mjs';
const first='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const second='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('desktop player registration permits only explicit extension IDs and preserves other hosts', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'arc-host-registration-'));
  try {
    const other=path.join(directory,'existing.host.json');
    await writeFile(other,'{"keep":"exactly"}\n');
    const file=await registerHost(directory,first);
    const host=JSON.parse(await readFile(file,'utf8'));
    assert.deepEqual(host.allowed_origins,[`chrome-extension://${first}/`]);
    assert.equal(host.type,'stdio'); assert.ok(path.isAbsolute(host.path));
    assert.equal(await readFile(other,'utf8'),'{"keep":"exactly"}\n');
    assert.throws(()=>hostManifest(['*']),/Invalid extension ID/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('repeat desktop registration merges explicitly allowed origins without duplicates', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'arc-host-registration-'));
  try {
    await registerHost(directory,first); await registerHost(directory,second);
    const file=await registerHost(directory,first);
    const host=JSON.parse(await readFile(file,'utf8'));
    assert.deepEqual(host.allowed_origins,[`chrome-extension://${first}/`,`chrome-extension://${second}/`]);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('desktop registration refuses to replace a different existing executable', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'arc-host-registration-'));
  try {
    const file=path.join(directory,hostName+'.json');
    const existing='{"path":"/different/existing/player","allowed_origins":[]}\n';
    await writeFile(file,existing);
    await assert.rejects(registerHost(directory,first),/refusing to replace/);
    assert.equal(await readFile(file,'utf8'),existing);
  } finally {await rm(directory,{recursive:true,force:true});}
});
