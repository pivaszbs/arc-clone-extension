// Manual native-window verification. Enter closes the disposable browser and server.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const bytes = await readFile('src/preview/japanese-qa.mp4');
const server = createServer((req, res) => {
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); res.end(bytes); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Arc extension PiP OS verification</title><style>body{margin:50px 50px 50px 360px;font:18px system-ui}video{width:480px;height:270px}</style><h1>PiP OS verification</h1><video controls muted loop src="/video.mp4"></video>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(path.join(tmpdir(), 'arc-pip-os-check-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.PIP_BROWSER || 'chromium', headless: false, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'], viewport: { width: 1100, height: 800 }
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('video').evaluate(video => video.play());
  await page.getByRole('button', { name: 'Picture in picture', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.pictureInPictureElement))).toBe(true);
  console.log('Native PiP is open in a disposable Chrome profile. Press Enter to finish.');
  await new Promise(resolve => process.stdin.once('data', resolve));
  console.log(JSON.stringify(await page.evaluate(() => ({ pipOpen: Boolean(document.pictureInPictureElement), playing: !document.querySelector('video').paused }))));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
