import { Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

Then('Arc has its saved Space and pin alongside the independent Anime Study extension', async function () {
  const state = (await this.snapshot()).state;
  assert.equal(state.activeSpaceId, 'saved-space');
  assert.equal(state.spaces[0].pinnedItems[0].title, 'Saved pin');
  await this.panel.reload();
  await expect(this.panel.locator('.space-name')).toHaveText('Saved Space');
  const arc = await this.panel.evaluate(() => chrome.runtime.getManifest());
  assert.equal(arc.name, 'Arc for Chrome');
  assert.ok(arc.chrome_url_overrides?.newtab);
  assert.ok(!arc.content_scripts.some(script => script.js.includes('japanese.js')));
  const page = await this.context.newPage();
  await page.goto(`chrome-extension://${this.animeExtensionId}/offline.html`);
  await expect(page.getByRole('heading', { name: 'Offline study' })).toBeVisible();
  const anime = await page.evaluate(() => chrome.runtime.getManifest());
  assert.equal(anime.name, 'Anime Study');
  assert.equal(anime.chrome_url_overrides, undefined);
  assert.equal(anime.side_panel, undefined);
  assert.deepEqual(anime.content_scripts.flatMap(script => script.js), ['japanese.js']);
});
