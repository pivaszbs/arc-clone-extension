import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

async function openVideoPage(world, path) {
  world.videoPage = await world.context.newPage();
  await world.videoPage.goto(world.url(path));
  await world.videoPage.waitForSelector('#arc-video-picture-in-picture', { state: 'attached' });
}
async function readyVideo(world) {
  await expect.poll(() => world.videoPage.locator('video').first().evaluate(video => video.readyState > 0 && video.videoWidth > 0)).toBe(true);
}
Given('a standard video page', async function () { await openVideoPage(this, 'Video-default'); await readyVideo(this); });
Then('hovering the video reveals an icon-only picture in picture button', async function () {
  const button = this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true });
  const opacity = () => button.evaluate(element => getComputedStyle(element.parentElement).opacity);
  await this.videoPage.locator('h1').hover();
  await expect.poll(opacity).toBe('0');
  await this.videoPage.locator('video').hover();
  await expect.poll(opacity).toBe('1');
  await expect(button.locator('svg')).toHaveCount(1);
  await expect(button).toHaveText('');
  await this.videoPage.locator('h1').hover();
  await expect.poll(opacity).toBe('0');
});
When('I click its picture in picture button', async function () {
  await this.videoPage.locator('video').first().hover();
  await this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true }).click();
});
Then('the original video is in native picture in picture', async function () {
  await expect.poll(() => this.videoPage.evaluate(() => document.pictureInPictureElement === document.querySelector('video'))).toBe(true);
  await expect(this.videoPage.getByRole('button', { name: 'Exit picture in picture', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
When('I click its exit picture in picture button', async function () {
  await this.videoPage.locator('video').first().hover();
  await this.videoPage.getByRole('button', { name: 'Exit picture in picture', exact: true }).click();
});
Then('native picture in picture is closed', async function () {
  await expect.poll(() => this.videoPage.evaluate(() => document.pictureInPictureElement === null)).toBe(true);
});
When('the browser closes picture in picture', async function () {
  await this.videoPage.evaluate(() => document.exitPictureInPicture());
});
Then('the control offers picture in picture again', async function () {
  await expect(this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
Given('a page that inserts a video dynamically', async function () {
  await openVideoPage(this, 'Video-dynamic');
  await this.videoPage.evaluate(() => {
    const video = document.createElement('video');
    video.src = '/video-fixture.mp4'; video.controls = true; video.muted = true; video.loop = true;
    video.width = 480; video.height = 270; document.body.append(video);
  });
  await readyVideo(this);
});
Then('one picture in picture control is available', async function () {
  await expect(this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true })).toHaveCount(1);
  await expect(this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true })).toBeVisible();
});
When('that video is removed', async function () { await this.videoPage.locator('video').evaluate(video => video.remove()); });
Then('no picture in picture controls remain', async function () {
  await expect(this.videoPage.locator('#arc-video-picture-in-picture button')).toHaveCount(0);
});
Given('a page with two standard videos', async function () {
  await openVideoPage(this, 'Video-default');
  await this.videoPage.locator('video').evaluate(video => video.after(video.cloneNode(true)));
  await expect.poll(() => this.videoPage.locator('video').evaluateAll(videos => videos.every(video => video.readyState > 0 && video.videoWidth > 0))).toBe(true);
});
When('I open the second video in picture in picture', async function () {
  await this.videoPage.locator('video').nth(1).hover();
  await this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true }).nth(1).click();
});
Then('only the second video is in native picture in picture', async function () {
  await expect.poll(() => this.videoPage.evaluate(() => document.pictureInPictureElement === document.querySelectorAll('video')[1])).toBe(true);
  await expect(this.videoPage.getByRole('button', { name: 'Exit picture in picture', exact: true })).toHaveCount(1);
});
When('the website disables picture in picture on the video', async function () {
  await this.videoPage.locator('video').evaluate(video => video.disablePictureInPicture = true);
});
Then('the video has no visible picture in picture button', async function () {
  await expect(this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true })).toHaveCount(0);
  await expect(this.videoPage.locator('video')).toHaveJSProperty('disablePictureInPicture', true);
});
When('the website enables picture in picture on the video', async function () {
  await this.videoPage.locator('video').evaluate(video => video.disablePictureInPicture = false);
});
Given('a video page whose permissions policy blocks picture in picture', async function () {
  await openVideoPage(this, 'Video-policy'); await readyVideo(this);
});
Then('the picture in picture control explains that the page blocks it', async function () {
  await expect(this.videoPage.getByRole('status')).toHaveText('Picture in picture is blocked on this page.');
});
When('I switch to another browser tab', async function () {
  const other = await this.context.newPage(); await other.goto(this.url('Destination')); await other.bringToFront();
});
Then('the page still has one original video element', async function () {
  await expect(this.videoPage.locator('video')).toHaveCount(1);
});
Given('a video inside an iframe that allows picture in picture', async function () {
  await openVideoPage(this, 'Video-frame');
  this.videoFrame = this.videoPage.frameLocator('iframe[title="Video frame"]');
  await expect(this.videoFrame.getByRole('button', { name: 'Picture in picture', exact: true })).toBeVisible();
});
When('I click the iframe video picture in picture button', async function () {
  await this.videoFrame.locator('video').hover();
  await this.videoFrame.getByRole('button', { name: 'Picture in picture', exact: true }).click();
});
Then('the iframe original video is in native picture in picture', async function () {
  await expect.poll(() => this.videoFrame.locator('video').evaluate(video => video.ownerDocument.pictureInPictureElement === video)).toBe(true);
});
When('I activate picture in picture with the keyboard', async function () {
  const button = this.videoPage.getByRole('button', { name: 'Picture in picture', exact: true });
  await button.focus(); await button.press('Enter');
});

When('I play the standard video', async function () {
  await this.videoPage.locator('video').evaluate(video => video.play());
  await expect.poll(() => this.videoPage.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0);
});
Then('the original video is still playing', async function () {
  await expect(this.videoPage.locator('video')).toHaveJSProperty('paused', false);
  const time = await this.videoPage.locator('video').evaluate(video => video.currentTime);
  await expect.poll(() => this.videoPage.locator('video').evaluate(video => video.currentTime)).not.toBe(time);
});
