import { When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
When('I open the video across desktops', async function () {
  this.originalMute = await this.videoPage.locator('video').evaluate(video => video.muted);
  await this.videoPage.locator('video').hover();
  await this.videoPage.getByRole('button', {name:'Picture in picture across desktops',exact:true}).click();
  await expect(this.videoPage.getByRole('button',{name:'Exit picture in picture across desktops',exact:true})).toBeVisible({timeout:20000});
});
When('I open a downloaded video across desktops', async function () {
  await this.videoPage.getByLabel('Episode video', { exact: true }).setInputFiles('tests/fixtures/pip-with-audio.mp4');
  await this.videoPage.locator('video').evaluate(video => { video.loop = true; });
  await this.videoPage.getByRole('button', { name: 'Player options' }).click();
  await this.videoPage.getByRole('button', { name: 'Picture in picture across desktops', exact: true }).click({ timeout: 5000 });
  await expect(this.videoPage.getByRole('button', { name: 'Exit picture in picture across desktops', exact: true })).toBeVisible({ timeout: 20000 });
});
async function status(world) {
  const message = { type: 'DESKTOP_PIP_STATUS' };
  if (world.videoPage.url().startsWith(`chrome-extension://${world.animeExtensionId}/`)) {
    return world.videoPage.evaluate(value => chrome.runtime.sendMessage(value), message);
  }
  return world.message(message);
}
When('the source video pauses and resumes', async function () {
  const video = this.videoPage.locator('video');
  await video.evaluate(element => element.pause());
  await expect.poll(async () => {
    const state = await status(this);
    return [state.source?.paused, state.media?.paused];
  }).toEqual([true, true]);
  const pausedAt = (await status(this)).media.time;
  await expect.poll(async () => (await status(this)).media.time).toBe(pausedAt);
  await video.evaluate(element => element.play());
});
Then('the desktop panel follows the source playback state', async function () {
  await expect.poll(async () => {
    const state = await status(this);
    return [state.source?.paused, state.media?.paused];
  }).toEqual([false, false]);
});
Then('the desktop panel joins all Spaces and full-screen Spaces', async function () {
  const state = await status(this);
  assert.equal(state.ok,true,state.error);
  assert.equal(state.window.allSpaces,true);
  assert.equal(state.window.fullScreenAuxiliary,true);
  assert.equal(state.window.nonactivating,true);
  assert.equal(state.window.hidesOnDeactivate,false);
  assert.equal(state.window.floating,true);
});
Then('the desktop panel decodes the captured video', async function () {
  await expect.poll(async () => (await status(this)).media?.videoWidth || 0,{timeout:15000}).toBeGreaterThan(0);
  await expect.poll(async () => (await status(this)).media?.time || 0,{timeout:15000}).toBeGreaterThan(0);
});
Then('the desktop panel video keeps advancing', async function () {
  const start=(await status(this)).media.time;
  await expect.poll(async () => (await status(this)).media?.time || 0,{timeout:10000}).toBeGreaterThan(start);
});
When('I return the desktop video to the page', async function () {
  await this.videoPage.locator('video').hover();
  await this.videoPage.getByRole('button',{name:'Exit picture in picture across desktops',exact:true}).click();
});
Then('the desktop player has closed', async function () {
  await expect.poll(async () => (await status(this)).active).toBe(false);
});
Then('the original player is muted while desktop playback is active', async function () {
  await expect(this.videoPage.locator('video')).toHaveJSProperty('muted',true);
});
Then('the original player mute state is restored', async function () {
  await expect(this.videoPage.locator('video')).toHaveJSProperty('muted',this.originalMute);
});
When('the video source becomes a blob URL', async function () {
  await this.videoPage.locator('video').evaluate(async video => {
    video.src = URL.createObjectURL(await (await fetch('/video-fixture.mp4')).blob());
    await new Promise(resolve => video.addEventListener('loadedmetadata',resolve,{once:true}));
  });
});
Then('the original video still uses its blob URL', async function () {
  assert.ok((await this.videoPage.locator('video').evaluate(video=>video.currentSrc)).startsWith('blob:'));
});
When('I load a video with audio and set its volume', async function () {
  await this.videoPage.locator('video').evaluate(async video => {
    video.src='/video-with-audio.mp4';video.muted=false;video.volume=.2;
    await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));
  });
});
Then('the desktop panel retains the captured audio track and requested volume', async function () {
  await expect.poll(async () => (await status(this)).media?.audioTracks || 0,{timeout:15000}).toBeGreaterThan(0);
  const state=await status(this);
  assert.equal(state.media.muted,false);
  assert.ok(Math.abs(state.media.volume-.2)<.01);
});

Then('the desktop panel keeps receiving a playing live stream', async function () {
  await expect.poll(async () => {
    const state=await status(this);
    return state.media?.received>=4 && state.media?.paused===false && state.media?.ended===false;
  },{timeout:15000}).toBe(true);
});
