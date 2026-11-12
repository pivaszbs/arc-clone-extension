import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

const fixtureUrl = 'https://www.youtube.com/watch?v=arc-fixture';
const favoriteUrl = 'https://other.example/arc-icon-fixture';
const iconUrl = 'https://other.example/favicon.ico';
const title = 'Arc icon fixture';

Given('a YouTube fixture with an off-site Favorite icon', async function () {
  await this.context.route(fixtureUrl, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Arc fixture</title><video width="480" height="270" controls></video>'
  }));
  await this.context.route(iconUrl, route => route.abort());
  await this.message({ type: 'ADD_FAVORITE', title, url: favoriteUrl, favIconUrl: iconUrl });
  this.videoPage = await this.context.newPage();
  this.extensionErrors = [];
  this.videoPage.on('pageerror', error => this.extensionErrors.push(error.message));
  this.videoPage.on('console', message => {
    if (message.type() === 'error' && message.text().includes('Not allowed to load local resource: chrome://')) {
      this.extensionErrors.push(message.text());
    }
  });
  await this.videoPage.goto(fixtureUrl);
  await expect(this.videoPage.locator('#arc-video-picture-in-picture')).toBeAttached();
  await expect(this.videoPage.locator('#arc-japanese-study')).toBeAttached();
});

When('I open the command bar on the fixture', async function () {
  await this.worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_COMMAND_BAR' });
  }, fixtureUrl);
});

Then('the extension runs without a content script exception', async function () {
  expect(this.extensionErrors).toEqual([]);
  const input = this.videoPage.getByRole('combobox', { name: 'Search tabs, commands, or enter a URL' });
  await expect(input).toBeVisible();
  await input.fill(title);
  await expect(this.videoPage.getByRole('option', { name: /^Arc icon fixture Top Pin in/ })).toBeVisible();
  expect(this.extensionErrors).toEqual([]);
});

Then('the command bar uses a fallback for the off-site icon', async function () {
  const result = this.videoPage.getByRole('option', { name: /^Arc icon fixture Top Pin in/ });
  await expect(result.locator('img')).toHaveCount(0);
});

When('the extension injects the overlay again', async function () {
  await this.videoPage.locator('#arc-chrome-extension-root').evaluate(host => host.dataset.originalOverlay = 'yes');
  await this.worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }, fixtureUrl);
});

Then('the original overlay is still mounted', async function () {
  await expect(this.videoPage.locator('#arc-chrome-extension-root')).toHaveAttribute('data-original-overlay', 'yes');
  expect(this.extensionErrors).toEqual([]);
});

When('I click New Tab in the on-page sidebar', async function () {
  await this.videoPage.getByRole('button', { name: /New Tab$/ }).click();
});

Then('a new tab opens with the Arc command bar focused', async function () {
  const url = `chrome-extension://${this.extensionId}/newtab.html?focused=1`;
  await expect.poll(() => this.context.pages().some(page => page.url() === url)).toBe(true);
  const tab = this.context.pages().find(page => page.url() === url);
  await expect(tab.getByRole('combobox', { name: 'Search tabs, commands, or enter a URL' })).toBeFocused();
  await expect(this.videoPage).toHaveURL(fixtureUrl);
});

When('Chrome opens a standard new tab', async function () {
  this.standardTabId = await this.worker.evaluate(async () => (await chrome.tabs.create({ active: true })).id);
});

Then('the same Chrome tab shows the Arc command bar', async function () {
  await expect.poll(() => this.worker.evaluate(async id => {
    const tab = await chrome.tabs.get(id);
    return tab.url;
  }, this.standardTabId)).toBe(`chrome-extension://${this.extensionId}/newtab.html?focused=1`);
  await expect(this.videoPage).toHaveURL(fixtureUrl);
});

When('I choose chrome extensions with Shift Enter', async function () {
  const input = this.videoPage.getByRole('combobox', { name: 'Search tabs, commands, or enter a URL' });
  await input.fill('chrome://extensions');
  await expect(this.videoPage.getByRole('option', { name: /^Chrome Extensions/ })).toBeVisible();
  await input.press('Shift+Enter');
});

Then('Chrome extensions opens without a blocked iframe', async function () {
  await expect.poll(() => this.context.pages().some(page => page.url() === 'chrome://extensions/')).toBe(true);
  await expect(this.videoPage.locator('iframe[title="Arc Peek Preview"]')).toHaveCount(0);
  expect(this.extensionErrors).toEqual([]);
});
