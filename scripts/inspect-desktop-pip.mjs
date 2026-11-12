// Interactive OS check: switch desktops through the UI, then type a check label.
// Type "close" to finish. This only reads the companion's own NSPanel state.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { registerHost } from '../native/desktop-pip/registration.mjs';
const bytes=await readFile('tests/fixtures/pip-os-check.mp4');
const server=createServer((req,res)=>{
  if(req.url==='/video.mp4'){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});res.end(bytes);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Arc desktop PiP OS verification</title><style>body{margin:50px 50px 50px 360px;font:18px system-ui}video{width:480px;height:270px}</style><h1>Desktop PiP verification</h1><video controls muted loop src="/video.mp4"></video>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(path.join(tmpdir(),'arc-desktop-pip-check-'));
let context;
const checks=[];
try{
  context=await chromium.launchPersistentContext(profile,{channel:process.env.PIP_BROWSER||'chromium',headless:false,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging'],viewport:{width:1100,height:800}});
  const cdp=await context.browser().newBrowserCDPSession();
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:path.resolve('dist')});
  await registerHost(path.join(profile,'NativeMessagingHosts'),id);
  const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button',{name:'Picture in picture across desktops',exact:true}).click();
  const status=()=>panel.evaluate(()=>chrome.runtime.sendMessage({type:'DESKTOP_PIP_STATUS'}));
  await expect.poll(async()=>(await status()).media?.time||0,{timeout:20000}).toBeGreaterThan(0);
  async function check(label){
    const state=await status();
    const passed=state.ok && state.window?.visible && state.window?.onActiveSpace && state.media?.time>0 && !state.media?.paused;
    const result={label,browser:process.env.PIP_BROWSER||'chromium',passed,...state};checks.push(result);
    console.log(JSON.stringify(result));
    await writeFile(`artifacts/e2e/desktop-pip-os-${process.env.PIP_BROWSER||'chromium'}.json`,JSON.stringify(checks,null,2)+'\n');
    if(!passed)process.exitCode=1;
  }
  await check('initial-desktop');
  console.log('Desktop video is playing. Switch apps or Spaces through the UI, then type a check label. Type close to finish.');
  for await(const line of readline.createInterface({input:process.stdin})){if(line.trim()==='close')break;await check(line.trim()||'check');}
}finally{
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}
