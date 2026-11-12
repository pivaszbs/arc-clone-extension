import { registerHost } from '../../native/desktop-pip/registration.mjs';
import { BeforeAll, AfterAll, Before, After, setDefaultTimeout, setWorldConstructor, World, Status } from '@cucumber/cucumber';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

setDefaultTimeout(30000);
let server, origin;
BeforeAll(async () => {
  await mkdir('artifacts/e2e', { recursive: true });
  const videoBytes = await readFile('src/preview/japanese-qa.mp4');
  const audioVideoBytes = await readFile('tests/fixtures/pip-with-audio.mp4');
  server = createServer((req, res) => {
    if (req.url === '/video-with-audio.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': audioVideoBytes.length });
      res.end(audioVideoBytes); return;
    }
    if (req.url === '/video-fixture.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': videoBytes.length });
      res.end(videoBytes); return;
    }
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'Home';
    if (name === 'Video-policy') res.setHeader('Permissions-Policy', 'picture-in-picture=()');
    res.setHeader('Content-Type', 'text/html');
    const video = '<video aria-label="Test video" controls muted loop playsinline width="480" height="270" src="/video-fixture.mp4"></video>';
    const media = name === 'Video-frame' ? '<iframe title="Video frame" src="/Video-default" allow="picture-in-picture" width="650" height="500"></iframe>' : name.startsWith('Video-') && name !== 'Video-dynamic' ? video : '';
    res.end(`<!doctype html><title>${name.replace(/[^a-zA-Z0-9-]/g, '')}</title><style>body { margin-left: 360px; font-family: sans-serif; } video { max-width: 100%; }</style><h1>Browser comparison fixture</h1><a href="/Destination">Preview destination</a><p>Select text for translation.</p>${media}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
AfterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

class BrowserWorld extends World {
  async message(message) {
    const response = await this.panel.evaluate(message => chrome.runtime.sendMessage(message), message);
    if (response?.error) throw new Error(response.error);
    return response;
  }
  async snapshot() { return this.message({ type: 'GET_SNAPSHOT' }); }
  async open(name, active = false) {
    const { tab } = await this.message({ type: 'CREATE_TAB', url: `${origin}/${name}`, active });
    this.tabIds[name] = tab.id;
    return tab;
  }
  url(name) { return `${origin}/${name}`; }
  async refresh() { await this.panel.reload(); await expect(this.panel.locator('.space-name')).toBeVisible(); }
}
setWorldConstructor(BrowserWorld);

Before(async function () {
  this.kind = process.env.E2E_BROWSER || 'chromium';
  this.profile = await mkdtemp(path.join(tmpdir(), `arc-cucumber-${this.kind}-`));
  this.tabIds = {};
  const executablePath = this.kind === 'arc' ? (process.env.ARC_EXECUTABLE || '/Applications/Arc.app/Contents/MacOS/Arc') : undefined;
  this.context = await chromium.launchPersistentContext(this.profile, {
    ...(executablePath ? { executablePath } : { channel: this.kind }),
    headless: process.env.HEADED !== '1', timeout: 15000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 1024, height: 900 }
  });
  this.cdp = await this.context.browser().newBrowserCDPSession();
  const { id } = await this.cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
  this.extensionId = id;
  if (process.platform === 'darwin') await registerHost(path.join(this.profile, 'NativeMessagingHosts'), id);
  this.panel = await this.context.newPage();
  await this.panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await expect(this.panel.locator('.space-name')).toHaveText('Personal');
  this.worker = this.context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${id}/`))
    || await this.context.waitForEvent('serviceworker');
  await this.context.tracing.start({ screenshots: true, snapshots: true });
});

After(async function ({ pickle, result }) {
  try {
    if (this.panel && !this.panel.isClosed()) {
      const filename = `${this.kind}-${pickle.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      if (result.status !== Status.FAILED) await this.panel.setViewportSize({ width: 360, height: 900 });
      await this.panel.screenshot({ path: `artifacts/e2e/${filename}.png` });
      if (this.videoPage && !this.videoPage.isClosed()) await this.videoPage.screenshot({ path: `artifacts/e2e/${filename}-video.png` });
      if (result.status === Status.FAILED) {
        await this.attach(await this.panel.screenshot(), 'image/png');
        await this.context.tracing.stop({ path: `artifacts/e2e/${filename}.zip` });
      } else await this.context.tracing.stop();
    }
  } finally {
    await this.context?.close();
    // Only delete the fresh disposable test profile created by this scenario.
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
  }
});
