import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const page = 'https://smotret-anime.com/catalog/fixture-show-37446/episode-371545/subtitles-5842632';
const download = 'https://smotret-anime.com/translations/ass/5842632?download=1';
const captions = `[Script Info]
ScriptType: v4.00+
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.80,Default,,0,0,0,,最初の字幕です。
Dialogue: 0,0:00:01.80,0:00:07.00,Default,,0,0,0,,次の字幕です。
`;

async function setupEpisode(embedOrigin, embedOnly = false) {
  const embed = `${embedOrigin}/translations/embed/5842632`;
  await this.context.route(page, route => route.fulfill({
    contentType: 'text/html',
    body: `<meta charset="utf-8"><body style="margin-left:310px"><a href="/translations/mp4/5842632?format=mp4&height=720">720p</a>
      <a href="/translations/mp4/5842632?format=mp4&height=1080">1080p</a>
      <a href="/translations/mp4/9999999?format=mp4&height=2160">Other episode</a>
      <a href="/translations/ass/5842632?download=1">Скачать субтитры</a>
      <div class="card-image"><div class="video-container" style="position:relative;width:960px;height:640px">
        <iframe title="Episode player" src="${embed}" width="960" height="640" style="position:absolute;inset:0"></iframe>
      </div></div>`
  }));
  await this.context.route(download, route => {
    if (embedOnly && route.request().headers().referer !== embed) return route.fulfill({ status: 403 });
    return route.fulfill({
      contentType: 'application/octet-stream', headers: { 'content-disposition': 'attachment; filename="episode.ass"' }, body: captions
    });
  });
  await this.context.route(embed, route => route.fulfill({
    contentType: 'text/html',
    body: '<video controls muted width="480" height="270" src="/fixture.mp4"></video>'
  }));
  const media = await readFile('src/preview/japanese-qa.mp4');
  await this.context.route(`${embedOrigin}/fixture.mp4`, async route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
    const headers = { 'accept-ranges': 'bytes' };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${media.length}`;
    await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', headers, body: media.subarray(start, end + 1) });
  });
  this.videoPage = await this.context.newPage();
  await this.videoPage.setViewportSize({ width: 1360, height: 900 });
  await this.videoPage.goto(page);
  this.studyFrame = this.videoPage.frameLocator('iframe[title="Episode player"]');
  await expect(this.studyFrame.getByRole('button', { name: 'Return to page player' })).toBeVisible();
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('controls', false);
}

Given('an episode page with an ASS download and an embedded video', async function () {
  await setupEpisode.call(this, 'https://player.example.com');
});

Given('an episode whose subtitle download is only available from inside its embedded player', async function () {
  await setupEpisode.call(this, new URL(page).origin, true);
});

When('I open the study player inside the embed', async function () {
  await expect(this.studyFrame.getByRole('button', { name: 'Return to page player' })).toBeVisible();
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('controls', false);
});

When('the embedded player waits for its Play button to attach the video', async function () {
  await this.studyFrame.getByRole('button', { name: 'Return to page player' }).click();
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('controls', true);
  await this.studyFrame.locator('video').evaluate(video => {
    video.removeAttribute('src');
    video.load();
    const wrapper = document.createElement('div');
    wrapper.className = 'video-js';
    video.before(wrapper);
    wrapper.append(video);
    const play = document.createElement('button');
    play.className = 'vjs-big-play-button';
    play.textContent = 'Original Play';
    play.onclick = () => { video.src = '/fixture.mp4'; void video.play(); };
    wrapper.append(play);
  });
});

Then('Arc Play starts the episode and replaces the original controls', async function () {
  await this.videoPage.locator('#arc-anime-inline-studio').getByRole('button', { name: 'Open study player' }).click();
  await expect(this.studyFrame.getByText('Start the video to switch to the Arc player.')).toBeVisible();
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('controls', true);
  await this.studyFrame.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('controls', false);
  await expect(this.studyFrame.locator('video')).toHaveJSProperty('paused', false);
});

Then('the episode download follows the video clock', async function () {
  const video = this.studyFrame.locator('video');
  await this.studyFrame.getByRole('button', { name: 'Player options' }).click();
  await this.studyFrame.getByText('Subtitles', { exact: true }).click();
  await expect(this.studyFrame.getByText('Episode subtitle download', { exact: true })).toBeVisible();
  await this.studyFrame.getByText('Playback details', { exact: true }).click();
  await expect(this.studyFrame.getByText('2 Japanese subtitle cues loaded', { exact: true })).toBeVisible();
  await this.studyFrame.getByText('Playback details', { exact: true }).click();
  await expect(this.studyFrame.locator('.caption')).toHaveText('最初の字幕です。');
  await video.evaluate(element => { element.currentTime = 2.1; });
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(2.1);
  await expect(this.studyFrame.locator('.caption')).toHaveText('次の字幕です。');
  await this.studyFrame.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(this.studyFrame.locator('.caption')).toHaveText('最初の字幕です。');
  await expect(this.studyFrame.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await this.studyFrame.getByRole('button', { name: 'Player options' }).click();
});

Then('closing the study player restores the original controls', async function () {
  await this.studyFrame.getByRole('button', { name: 'Return to page player' }).click();
  const video = this.studyFrame.locator('video');
  await expect(video).toHaveJSProperty('controls', true);
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(2.1);
});

Then('the page offers the highest listed download quality for this episode', async function () {
  const opened = this.context.waitForEvent('page');
  await this.videoPage.locator('#arc-anime-inline-studio').getByRole('button', { name: 'Offline', exact: true }).click();
  const offline = await opened;
  await expect(offline.getByRole('link', { name: 'Download this episode · 1080p' })).toHaveAttribute('href', /\/translations\/mp4\/5842632\?.*height=1080/);
});

Given('the offline study page is open without a network connection', async function () {
  await this.context.setOffline(true);
  this.videoPage = await this.context.newPage();
  await this.videoPage.goto(`chrome-extension://${this.animeExtensionId}/offline.html`);
});

When('I open a local episode and its subtitles', async function () {
  await this.videoPage.getByLabel('Episode video').setInputFiles('src/preview/japanese-qa.mp4');
  await this.videoPage.locator('video').evaluate(video => video.pause());
  await this.videoPage.getByRole('button', { name: 'Player options' }).click();
  await this.videoPage.getByText('Subtitles', { exact: true }).click();
  await this.videoPage.getByLabel('Japanese subtitle file').setInputFiles({
    name: 'episode.ass', mimeType: 'text/plain', buffer: Buffer.from(captions)
  });
});

Then('offline study shows the Japanese subtitle at the video position', async function () {
  await expect(this.videoPage.locator('.caption')).toHaveText('最初の字幕です。');
  await this.videoPage.locator('video').evaluate(video => { video.currentTime = 2.1; });
  await expect(this.videoPage.locator('.caption')).toHaveText('次の字幕です。');
});

Then('the player skips the opening and ending using their chapters', async function () {
  const video = this.studyFrame.locator('video');
  await video.evaluate(element => {
    const chapters = element.addTextTrack('chapters', 'Episode chapters');
    chapters.mode = 'hidden';
    chapters.addCue(new VTTCue(0, 2.5, 'Opening'));
    chapters.addCue(new VTTCue(10, 13, 'Ending'));
  });
  await this.studyFrame.getByRole('button', { name: 'Skip opening' }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(2.5);
  await video.evaluate(element => { element.currentTime = 10; });
  await this.studyFrame.getByRole('button', { name: 'Skip ending' }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(13);
});

Then('clicking a subtitle pauses playback and opens the phrase', async function () {
  const video = this.studyFrame.locator('video');
  await video.evaluate(element => { element.currentTime = 3; });
  await this.studyFrame.getByRole('button', { name: 'Play', exact: true }).click();
  await this.studyFrame.getByRole('button', { name: '次の字幕です。' }).click();
  await expect(video).toHaveJSProperty('paused', true);
  await expect(this.studyFrame.locator('.phrase-text')).toHaveText('次の字幕です。');
  await this.studyFrame.getByRole('button', { name: 'Replay' }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeLessThan(3);
  await this.studyFrame.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', false);
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThanOrEqual(3);
});

Then('Every phrase pauses at the next subtitle boundary and saves a phrase offline', async function () {
  const page = this.videoPage;
  const video = page.locator('video');
  await page.getByRole('button', { name: 'Player options' }).click();
  await page.getByRole('button', { name: 'Learn', exact: true }).click();
  await page.getByLabel('Pause to study').selectOption('1');
  await page.getByLabel('Playback position').fill('1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.phrase-text')).toHaveText('最初の字幕です。');
  await expect(video).toHaveJSProperty('paused', true);
  await page.getByLabel('Meaning', { exact: true }).fill('The first subtitle.');
  await page.getByRole('button', { name: 'Save phrase' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Phrase saved.' })).toBeVisible();
});
