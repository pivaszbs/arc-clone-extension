import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

Given('a video on a Japanese learning site with subtitles loaded by the embedded player', async function () {
  await this.context.route('https://smotret-anime.com/test-episode', route => route.fulfill({
    contentType: 'text/html', body: '<iframe title="Player" src="https://example.com/embed" width="700" height="500"></iframe>'
  }));
  await this.context.route('https://example.com/embed', route => route.fulfill({
    contentType: 'text/html', body: '<script>window.playerFetch = window.fetch;</script><video controls muted width="480" height="270" src="/fixture.mp4"></video>'
  }));
  await this.context.route('https://example.com/fixture.mp4', async route => route.fulfill({
    contentType: 'video/mp4', body: await readFile('src/preview/japanese-qa.mp4')
  }));
  await this.context.route('https://example.com/file?id=42', route => route.fulfill({
    contentType: 'text/vtt', body: 'WEBVTT\n\n00:00.000 --> 00:15.000\nそれは何ですか。'
  }));
  this.videoPage = await this.context.newPage();
  await this.videoPage.goto('https://smotret-anime.com/test-episode');
  this.studyFrame = this.videoPage.frameLocator('iframe[title="Player"]');
  const launcher = this.studyFrame.getByRole('button', { name: 'Learn Japanese', exact: true });
  await launcher.click({timeout:5000});
  await expect(this.studyFrame.locator('section[aria-label="Japanese learning"]')).toBeVisible();
});

When('I scan for subtitles and the player requests its subtitle track', async function () {
  await this.studyFrame.getByRole('button', {name:'Scan for subtitles'}).click({timeout:5000});
  const video = this.studyFrame.locator('video');
  await expect.poll(() => video.evaluate(() => window.fetch !== window.playerFetch)).toBe(true);
  const subtitle = await video.evaluate(async () => (await fetch('/file?id=42')).text());
  expect(subtitle).toContain('それは何ですか。');
});

Then('the study panel shows the Japanese cue from the response', async function () {
  await expect(this.studyFrame.locator('.caption')).toHaveText('それは何ですか。', {timeout:20000});
  expect(await this.studyFrame.locator('video').evaluate(() => window.fetch === window.playerFetch)).toBe(true);
});
