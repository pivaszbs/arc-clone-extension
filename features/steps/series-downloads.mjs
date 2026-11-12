import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { mkdtempDisposable, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = 'https://smotret-anime.com/catalog/fixture-series-20001';
const ass = text => `[Script Info]
ScriptType: v4.00+
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:07.00,Default,,0,0,0,,${text}
`;

Given('a catalog with two downloadable episodes and one without Japanese subtitles', async function () {
  await this.context.route(root, route => route.fulfill({
    contentType: 'text/html',
    body: '<h1>Fixture series</h1>' + [1, 2, 3].map(n => `<a href="${root}/${n}-seriya-3000${n}">Episode ${n}</a>`).join('')
  }));
  await this.context.route('https://smotret-anime.com/catalog/fixture-series-20001/*/yaponskie-subtitry*', route => {
    const url = route.request().url();
    const [, index, id] = url.match(/(\d)-seriya-3000(\d)/);
    if (index === '3') return route.fulfill({ status: 404, body: 'Unavailable' });
    const variant = '4000' + id;
    const height = index === '1' ? 1080 : 720;
    return route.fulfill({ contentType: 'text/html', body: `<a href="/translations/mp4/${variant}?height=360">360p</a><a href="/translations/mp4/${variant}?height=${height}">${height}p</a><a href="/translations/ass/${variant}?download=1">Download subtitles</a>` });
  });
  await this.context.route('https://smotret-anime.com/translations/ass/**', route => route.fulfill({ body: ass('日本語の字幕です。') }));
  this.videoPage = await this.context.newPage();
  await this.videoPage.goto(`chrome-extension://${this.animeExtensionId}/offline.html?series=${encodeURIComponent(root)}`);
});

When('I check the series for offline viewing', async function () {
  await this.videoPage.getByRole('button', { name: 'Check episodes' }).click();
});

Then('the highest available quality and missing episodes are shown', async function () {
  await expect(this.videoPage.getByText(/2 of 3 episodes available/)).toBeVisible();
  await expect(this.videoPage.getByRole('list', { name: 'Episode availability' }).locator('li')).toHaveText([
    'Episode 1 · 1080p + Japanese subtitles',
    'Episode 2 · 720p + Japanese subtitles',
    'Episode 3 · Unavailable'
  ]);
  await expect(this.videoPage.getByRole('button', { name: 'Download selected' })).toBeDisabled();
  await this.videoPage.getByRole('checkbox', { name: /Episode 2/ }).check();
  await expect(this.videoPage.getByRole('checkbox', { name: /Episode 1/ })).not.toBeChecked();
  await expect(this.videoPage.getByRole('button', { name: 'Download 1 episode', exact: true })).toBeEnabled();
  await this.videoPage.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(this.videoPage.getByRole('button', { name: 'Download 2 episodes', exact: true })).toBeEnabled();
  await this.videoPage.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(this.videoPage.getByRole('button', { name: 'Download selected' })).toBeDisabled();
});

Given('a catalog where the current dub is available for three episodes', async function () {
  const episode = n => `${root}/${n}-seriya-3000${n}`;
  const selected = `${episode(1)}/ozvuchka-50001`;
  await this.context.route(root, route => route.fulfill({
    contentType: 'text/html',
    body: '<h1>Fixture series</h1>' + [1, 2, 3, 4].map(n => `<a href="${episode(n)}">Episode ${n}</a>`).join('')
  }));
  await this.context.route(`${root}/*/ozvuchka*`, route => {
    const request = route.request().url();
    const n = Number(request.match(/(\d)-seriya-/)[1]);
    const chosen = `${episode(n)}/ozvuchka-5000${n}`;
    const other = `${episode(n)}/ozvuchka-6000${n}`;
    const body = `<a href="${other}">Other dub</a>`
      + (n < 4 ? `<a href="${chosen}">Fixture Dub</a>` : '')
      + `<a href="/translations/mp4/${request === chosen ? '5000' : '6000'}${n}?height=1080" onclick="return false">1080p</a>`;
    return route.fulfill({ contentType: 'text/html', body });
  });
  this.videoPage = await this.context.newPage();
  this.catalogCspErrors = [];
  this.videoPage.on('console', message => {
    if (/inline event handler.*Content Security Policy/.test(message.text())) this.catalogCspErrors.push(message.text());
  });
  await this.videoPage.goto(`chrome-extension://${this.animeExtensionId}/offline.html?series=${encodeURIComponent(selected)}`);
});

Then('only episodes with the selected dub are offered', async function () {
  await expect(this.videoPage.getByText(/Fixture Dub.*3 of 4 episodes available/)).toBeVisible();
  await expect(this.videoPage.getByRole('list', { name: 'Episode availability' }).locator('li')).toHaveText([
    'Episode 1 · 1080p', 'Episode 2 · 1080p', 'Episode 3 · 1080p', 'Episode 4 · Unavailable'
  ]);
  await expect(this.videoPage.getByRole('link', { name: 'Download this episode · 1080p' })).toHaveAttribute('href', /\/mp4\/50001\?/);
  expect(this.catalogCspErrors).toEqual([]);
});

Then('unchecking the first two episodes submits only episode three', async function () {
  await this.videoPage.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.permissions.request = async () => true;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'SERIES_DOWNLOAD_START') {
        window.seriesDownloadRequest = message;
        return { queue: null };
      }
      return send(message);
    };
  });
  await this.videoPage.getByRole('button', { name: 'Select all' }).click();
  await this.videoPage.getByRole('checkbox', { name: /Episode 1/ }).uncheck();
  await this.videoPage.getByRole('checkbox', { name: /Episode 2/ }).uncheck();
  await this.videoPage.getByRole('button', { name: 'Download 1 episode', exact: true }).click();
  await expect.poll(() => this.videoPage.evaluate(() => window.seriesDownloadRequest?.selectedPages))
    .toEqual([`${root}/3-seriya-30003`]);
});

When('I open a downloaded series folder', async function () {
  const folder = await mkdtempDisposable(join(tmpdir(), 'arc-series-fixture-'));
  try {
    for (const [index, text] of ['一つ目の字幕です。', '二つ目の字幕です。'].entries()) {
      const name = join(folder.path, `Episode ${index + 1}`);
      await copyFile('src/preview/japanese-qa.mp4', name + '.mp4');
      await writeFile(name + '.ass', ass(text));
    }
    await this.videoPage.getByLabel('Open a downloaded series folder').setInputFiles(folder.path);
    await expect(this.videoPage.locator('.caption')).toHaveText('一つ目の字幕です。');
    await this.videoPage.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(this.videoPage.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
    await this.videoPage.getByLabel('Episode', { exact: true }).selectOption({ label: 'Episode 2.mp4' });
    await expect(this.videoPage.locator('.caption')).toHaveText('二つ目の字幕です。');
    await this.videoPage.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(this.videoPage.locator('.caption')).toHaveText('一つ目の字幕です。');
    const video = this.videoPage.locator('video');
    if (await video.evaluate(element => element.paused)) await this.videoPage.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', false);
    await this.videoPage.clock.install();
    await video.hover();
    const fullscreen = this.videoPage.getByRole('button', { name: 'Exit fullscreen' });
    const pause = this.videoPage.getByRole('button', { name: 'Pause', exact: true });
    await this.videoPage.clock.fastForward(9000);
    await expect(fullscreen).toBeVisible();
    await expect(pause).toBeVisible();
    await this.videoPage.clock.fastForward(1200);
    await expect(fullscreen).toBeHidden();
    await expect(pause).toBeHidden();
    await expect(this.videoPage.locator('.caption')).toHaveText('一つ目の字幕です。');
    await video.hover({ position: { x: 24, y: 80 } });
    await expect(fullscreen).toBeVisible();
    await expect(pause).toBeVisible();
    await this.videoPage.clock.fastForward(10200);
    await expect(pause).toBeHidden();
    await this.videoPage.keyboard.press('Shift');
    await expect(fullscreen).toBeVisible();
    await expect(pause).toBeVisible();
    await video.evaluate(element => { element.currentTime = element.duration - 0.2; });
    await expect(this.videoPage.locator('.caption')).toHaveText('二つ目の字幕です。');
    await expect(video).toHaveJSProperty('paused', false);
  } finally { await folder.remove(); }
});

Then('I can switch episodes and their Japanese captions together without leaving fullscreen', async function () {
  await expect(this.videoPage.getByRole('combobox', { name: 'Episode', exact: true })).toHaveValue(/Episode 2\.mp4$/);
  await expect(this.videoPage.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
});

When('I connect a folder with a saved episode', async function () {
  const { readFile } = await import('node:fs/promises');
  const media = Array.from(await readFile('src/preview/japanese-qa.mp4'));
  await this.videoPage.addInitScript(({ media, subtitles }) => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const library = await root.getDirectoryHandle('Arc Anime', { create: true });
      const folder = await library.getDirectoryHandle('Fixture episodes', { create: true });
      const video = new Uint8Array(media);
      for (const [name, body] of [['Episode 002 - 50002.mp4', video], ['Episode 003 - 50003.mp4', video], ['Episode 003 - 50003.ass', subtitles]]) {
        const handle = await folder.getFileHandle(name, { create: true });
        const writer = await handle.createWritable();
        await writer.write(body);
        await writer.close();
      }
      return library;
    };
  }, { media, subtitles: ass('保存した字幕です。') });
  await this.videoPage.reload();
  await this.videoPage.getByRole('button', { name: 'Connect download folder' }).click();
  await this.videoPage.getByLabel('Episode', { exact: true }).selectOption({ label: 'Episode 003 - 50003.mp4' });
  await expect(this.videoPage.locator('.caption')).toHaveText('保存した字幕です。');
});

Then('Offline Study loads the saved episode and position when I reopen it', async function () {
  const video = this.videoPage.locator('video');
  await video.evaluate(async element => {
    element.pause();
    const seeked = new Promise(resolve => element.addEventListener('seeked', resolve, { once: true }));
    element.currentTime = 4.5;
    await seeked;
  });
  const url = this.videoPage.url();
  await this.videoPage.close();
  this.videoPage = await this.context.newPage();
  await this.videoPage.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.dataset.playRequested = 'true';
      return play.call(this);
    };
  });
  await this.videoPage.goto(url);
  await expect(this.videoPage.getByRole('combobox', { name: 'Episode', exact: true })).toHaveValue('Episode 003 - 50003.mp4');
  const resumedVideo = this.videoPage.locator('video');
  await expect(resumedVideo).toHaveAttribute('data-play-requested', 'true');
  await expect.poll(() => resumedVideo.evaluate(element => element.currentTime)).toBeGreaterThanOrEqual(4.5);
  if (await resumedVideo.evaluate(element => element.paused)) {
    await this.videoPage.getByRole('button', { name: 'Play', exact: true }).click();
  }
  await expect(resumedVideo).toHaveJSProperty('paused', false);
  await expect(this.videoPage.locator('.caption')).toHaveText('保存した字幕です。');

  const episodeUrl = new URL(url);
  episodeUrl.searchParams.set('series', `${root}/2-seriya-30002/dub-50002`);
  await this.videoPage.goto(episodeUrl.href);
  await expect(this.videoPage.getByRole('combobox', { name: 'Episode', exact: true })).toHaveValue('Episode 002 - 50002.mp4');
  await expect.poll(() => this.videoPage.locator('video').evaluate(element => element.currentTime)).toBeLessThan(3);
});

Then('I can use Space and the arrow keys to control fullscreen playback', async function () {
  const page = this.videoPage;
  const video = page.locator('video');
  const overlay = page.locator('.offline-controls .panel');
  await expect(video).toHaveJSProperty('paused', false);
  await page.clock.install();
  await video.focus();
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect(overlay).toBeHidden();
  await page.mouse.move(60, 100);
  await expect(overlay).toBeHidden();
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(overlay).toBeHidden();
  await page.clock.fastForward(500);
  await expect(overlay).toBeHidden();
  await page.mouse.move(90, 120);
  await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const fullscreen = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(fullscreen).toBeVisible();

  await page.keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(fullscreen).toBeVisible();
  const position = await video.evaluate(element => element.currentTime);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(position + 5, 1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(position, 1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBe(0);

  await page.keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', false);
  await expect(fullscreen).toBeVisible();

  const controls = page.locator('.player-controls');
  const timeline = await controls.getByRole('slider', { name: 'Playback position' }).boundingBox();
  const episodes = await controls.getByRole('combobox', { name: 'Episode', exact: true }).boundingBox();
  const screen = await video.boundingBox();
  expect(timeline.y).toBeGreaterThan(screen.y + screen.height / 2);
  expect(episodes.y).toBeGreaterThan(timeline.y);

  const caption = page.locator('.caption');
  await expect(caption).toBeVisible();
  await controls.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(controls).toBeHidden();
  await expect(caption).toBeHidden();
  await expect(video).toHaveJSProperty('paused', false);
  await page.keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(controls).toBeHidden();
  await page.mouse.move(screen.x + screen.width / 3, screen.y + screen.height / 2);
  await expect(controls).toBeHidden();
  await page.clock.fastForward(500);
  await expect(controls).toBeHidden();
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await expect(fullscreen).toBeVisible();
  await expect(caption).toBeVisible();
});

Then('the frame checking queue picks up finished videos and preserves its pause state', { timeout: 25000 }, async function () {
  const page = this.videoPage;
  const queue = page.locator('[aria-label="Frame checking queue"]');
  const status = queue.getByRole('status');
  await queue.getByRole('button', { name: 'Queue frame checking' }).click();
  await expect(status).toContainText('2 / 2 episodes checked');
  await queue.getByRole('button', { name: 'Pause frame checking' }).click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle('Arc Anime');
    const folder = await library.getDirectoryHandle('Fixture episodes');
    const source = await (await folder.getFileHandle('Episode 002 - 50002.mp4')).getFile();
    for (const name of ['Episode 004.mp4', 'Episode 005.mp4.crdownload']) {
      const file = await folder.getFileHandle(name, { create: true });
      const writer = await file.createWritable();
      await writer.write(source);
      await writer.close();
    }
  });
  await expect(status).toContainText('2 / 3 episodes checked', { timeout: 8000 });
  await page.reload();
  await expect(status).toContainText('Paused');
  await expect(status).toContainText('2 / 3 episodes checked');
  await queue.getByRole('button', { name: 'Resume frame checking' }).click();
  await expect(status).toContainText('3 / 3 episodes checked');
  await queue.getByRole('button', { name: 'Stop frame checking' }).click();
  await expect(status).toBeHidden();
});

Then('I can keep watching the opening and choose between skipping the ending or going to the next episode', { timeout: 20000 }, async function () {
  const page = this.videoPage;
  const video = page.locator('video');
  // Start on episode 2 so episode 3 is available as the next episode.
  const previousSrc = await video.evaluate(element => element.currentSrc);
  await page.getByLabel('Episode', { exact: true }).selectOption({ label: 'Episode 002 - 50002.mp4' });
  await expect.poll(() => video.evaluate((element, prev) => element.currentSrc !== '' && element.currentSrc !== prev && element.readyState >= 1, previousSrc), { timeout: 5000 }).toBe(true);
  await video.evaluate(element => {
    const track = element.addTextTrack('chapters', 'Episode chapters');
    track.mode = 'hidden';
    track.addCue(new VTTCue(0, 7, 'Opening'));
    track.addCue(new VTTCue(7.5, 14.5, 'Ending'));
    element.currentTime = 0;
    void element.play();
  });
  const opening = page.getByRole('group', { name: 'Skip opening' });
  await expect(opening.getByText('Skipping in 5 s')).toBeVisible({ timeout: 5000 });
  await opening.getByRole('button', { name: 'Keep watching' }).click();
  await expect(opening).toBeHidden();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeLessThan(7);

  await video.evaluate(element => { element.currentTime = 7.6; });
  await video.focus();
  await page.keyboard.press('f');
  await expect(page.locator('.offline-controls .panel')).toBeHidden();
  const ending = page.getByRole('group', { name: 'Skip ending' });
  await expect(ending.getByRole('button', { name: 'Next episode' })).toBeVisible({ timeout: 5000 });
  await expect(ending.getByRole('button', { name: 'Skip ending' })).toBeVisible({ timeout: 5000 });
  await expect(ending.getByText('Next episode in 5 s')).toBeVisible({ timeout: 5000 });
  // Switching the default ending skip action in Player options updates the countdown action.
  await page.waitForTimeout(550);
  await page.mouse.move(100, 100);
  await page.mouse.move(200, 200);
  await page.getByRole('button', { name: 'Player options' }).click();
  await page.getByLabel('Ending skip action').selectOption('skip');
  await expect(ending.getByText(/Skipping in \d+ s/)).toBeVisible();
  await page.getByLabel('Ending skip action').selectOption('next');
  await expect(ending.getByText(/Next episode in \d+ s/)).toBeVisible();
  // Choose "Skip ending" first to stay in the current episode, then undo and let "Next episode" advance.
  await ending.getByRole('button', { name: 'Skip ending' }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime), { timeout: 6000 }).toBeGreaterThanOrEqual(14.5);
  await page.getByRole('button', { name: 'Undo skip' }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeLessThan(9);
  await page.waitForTimeout(550);
  await page.mouse.move(100, 100);
  await page.mouse.move(200, 200);
  await page.getByRole('button', { name: 'Next episode' }).click({ timeout: 5000 });
  await expect(page.getByLabel('Episode', { exact: true })).toHaveValue(/Episode 003 - 50003\.mp4$/);
  await expect(page.locator('.caption')).toHaveText('保存した字幕です。');
});
