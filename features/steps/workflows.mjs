import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

When('I create a Space named {string} using the sidebar', async function (name) {
  await this.panel.getByTitle('Create New Space', { exact: true }).click();
  const dialog = this.panel.getByRole('dialog');
  await dialog.locator('input[type=text]').first().fill(name);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  this.createdSpace = name;
});
Then('the active Space is {string}', async function (name) {
  await expect(this.panel.locator('.space-name')).toHaveText(name);
});
Then('the Space persists after reloading the sidebar', async function () {
  await this.refresh(); await expect(this.panel.locator('.space-name')).toHaveText(this.createdSpace);
});
Given('a Today tab named {string}', async function (name) {
  await this.open(name); await this.refresh();
});
When('I switch to the {string} Space', async function (name) {
  await this.panel.getByRole('button', { name, exact: true }).click();
  await expect(this.panel.locator('.space-name')).toHaveText(name);
});
Then('Today contains {string}', async function (name) {
  await expect(this.panel.locator('.today-tabs .row-title').filter({ hasText: name })).toBeVisible();
});
Then('Today does not contain {string}', async function (name) {
  await expect(this.panel.locator('.today-tabs .row-title').filter({ hasText: name })).toHaveCount(0);
});
Given('a Favorite named {string}', async function (name) {
  await this.message({ type: 'ADD_FAVORITE', title: name, url: this.url(name) }); await this.refresh();
});
Then('the Favorite named {string} is visible', async function (name) {
  await expect(this.panel.locator('.favorite-tile').filter({ has: this.panel.locator(`button[aria-label="Remove ${name} from Favorites"]`) })).toBeVisible();
});
Given('a pinned page named {string}', async function (name) {
  await this.open(name);
  await this.message({ type: 'PIN_TAB_TO_SPACE', title: name, url: this.url(name) });
  await this.message({ type: 'OPEN_OR_SWITCH_URL', url: this.url(name), spaceId: 'space-personal' });
  this.pinName = name;
  await this.refresh();
});
Then('a pinned row named {string} is visible', async function (name) {
  await expect(this.panel.locator('.pinned-section .row-title').filter({ hasText: name })).toBeVisible();
});
When('the pinned tab navigates to {string}', async function (name) {
  await this.worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: this.tabIds[this.pinName], url: this.url(name) });
  await this.refresh();
});
When('I reset the Space through the command bar', async function () {
  await this.panel.getByRole('button', { name: 'New Tab', exact: true }).click();
  await this.panel.getByRole('combobox').fill('Reset Space');
  await this.panel.getByRole('option').filter({ has: this.panel.getByText('Reset Space', { exact: true }) }).click();
});
Then('the pinned tab is back at its saved URL', async function () {
  await expect.poll(async () => (await this.snapshot()).tabs.find(tab => tab.id === this.tabIds[this.pinName])?.url).toBe(this.url(this.pinName));
});
When('I rename {string} to {string}', async function (oldName, name) {
  await this.panel.locator('.pinned-row').filter({ has: this.panel.getByText(oldName, { exact: true }) }).last().hover();
  await this.panel.getByRole('button', { name: `Rename ${oldName}`, exact: true }).click();
  await this.panel.getByRole('textbox', { name: 'Pinned item name' }).fill(name);
  await this.panel.getByRole('button', { name: 'Save name', exact: true }).click();
  this.renamedPin = name;
});
Then('the pin name persists after reloading the sidebar', async function () {
  await this.refresh(); await expect(this.panel.locator('.pinned-section .row-title').filter({ hasText: this.renamedPin })).toBeVisible();
});
When('I create a pinned folder named {string}', async function (name) {
  await this.panel.getByTitle('New Pinned Folder', { exact: true }).click();
  await this.panel.getByPlaceholder('Folder name', { exact: true }).fill(name);
  await this.panel.getByRole('button', { name: 'Add', exact: true }).click();
  this.folder = name;
});
Then('the folder is expanded', async function () {
  await expect(this.panel.locator('.folder-row').filter({ has: this.panel.getByText(this.folder, { exact: true }) })).toHaveAttribute('aria-expanded', 'true');
});
When('I collapse the folder', async function () {
  await this.panel.locator('.folder-row').filter({ has: this.panel.getByText(this.folder, { exact: true }) }).click();
});
Then('the folder is collapsed', async function () {
  await expect(this.panel.locator('.folder-row').filter({ has: this.panel.getByText(this.folder, { exact: true }) })).toHaveAttribute('aria-expanded', 'false');
});
When('I clear Today using the sidebar', async function () {
  // Preserve one active fixture; Arc-style clearing only closes inactive Today tabs.
  await this.open('Active-anchor', true); await this.refresh();
  await this.panel.getByRole('button', { name: 'Clear', exact: true }).click();
});
Then('{string} is in the archive', async function (name) {
  await expect.poll(async () => (await this.snapshot()).state.archive.some(entry => entry.url === this.url(name))).toBe(true);
});
Then('{string} is absent from the archive', async function (name) {
  assert.ok(!(await this.snapshot()).state.archive.some(entry => entry.url === this.url(name)));
});
When('I restore {string} using the archive drawer', async function (name) {
  await this.panel.getByRole('button', { name: 'Archived Tabs', exact: true }).click();
  await this.panel.getByRole('button', { name: `Restore ${name}`, exact: true }).click();
  await this.panel.getByRole('button', { name: 'Close archive', exact: true }).click();
});
When('I search the archive for {string}', async function (query) {
  await this.panel.getByRole('button', { name: 'Archived Tabs', exact: true }).click();
  await this.panel.getByRole('textbox', { name: 'Search archived tabs' }).fill(query);
});
Then('only {string} is shown in the archive', async function (name) {
  await expect(this.panel.locator('.archive-entry')).toHaveCount(1);
  await expect(this.panel.locator('.archive-entry strong')).toHaveText(name);
});
When('I open {string} using the keyboard command bar', async function (name) {
  await this.panel.locator('body').press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await this.panel.getByRole('combobox').fill(this.url(name));
  await this.panel.getByRole('combobox').press('Enter');
});
Then('a real browser tab contains {string}', async function (name) {
  await expect.poll(async () => (await this.snapshot()).tabs.some(tab => tab.url === this.url(name))).toBe(true);
});
When('I search for and select {string} in the command bar', async function (name) {
  await this.panel.getByRole('button', { name: 'New Tab', exact: true }).click();
  await this.panel.getByRole('combobox').fill(name);
  await this.panel.getByRole('option').filter({ hasText: name }).first().click();
});
Then('exactly one real browser tab contains {string}', async function (name) {
  await expect.poll(async () => (await this.snapshot()).tabs.filter(tab => tab.url === this.url(name)).length).toBe(1);
});
When('I open the command bar and press Escape', async function () {
  await this.panel.getByRole('button', { name: 'New Tab', exact: true }).click();
  await expect(this.panel.getByRole('combobox')).toBeFocused();
  await this.panel.getByRole('combobox').press('Escape');
});
Then('the command bar is closed', async function () { await expect(this.panel.getByRole('combobox')).toHaveCount(0); });
When('I set auto archive to {string}', async function (label) {
  await this.panel.getByTitle('Arc Settings', { exact: true }).click();
  await this.panel.getByLabel('Auto archive inactive tabs', { exact: true }).selectOption({ label });
  await expect.poll(async () => (await this.snapshot()).state.settings.autoArchiveHours).toBe(168);
});
Then('auto archive is set to {int} hours after a reload', async function (hours) {
  await this.refresh(); assert.equal((await this.snapshot()).state.settings.autoArchiveHours, hours);
});
When('I move {string} to the {string} Space', async function (name, spaceName) {
  const { state } = await this.snapshot();
  await this.message({ type: 'MOVE_TAB_TO_SPACE', tabId: this.tabIds[name], spaceId: state.spaces.find(space => space.name === spaceName).id });
  await this.refresh();
});
Given('an active fixture page', async function () {
  const tab = await this.open('Peek-parent', true);
  this.fixture = this.context.pages().find(page => page.url() === this.url('Peek-parent'));
  if (!this.fixture) { await expect.poll(() => this.context.pages().find(page => page.url() === this.url('Peek-parent'))).toBeTruthy(); this.fixture = this.context.pages().find(page => page.url() === this.url('Peek-parent')); }
  await this.fixture.waitForSelector('#arc-chrome-extension-root', { state: 'attached' });
});
When('I Shift-click its destination link', async function () {
  await this.fixture.getByRole('link', { name: 'Preview destination' }).click({ modifiers: ['Shift'] });
});
Then('a Peek dialog shows the destination', async function () {
  await expect(this.fixture.locator('iframe')).toHaveAttribute('src', this.url('Destination'));
  await expect(this.fixture.frameLocator('iframe').getByRole('heading')).toHaveText('Browser comparison fixture');
});
Then('the parent remains at the fixture URL', async function () { expect(this.fixture.url()).toBe(this.url('Peek-parent')); });
When('I open {string} in Little Arc', async function (name) { await this.message({ type: 'OPEN_LITTLE_ARC', url: this.url(name) }); });
Then('a popup window contains {string}', async function (name) {
  const windows = await this.worker.evaluate(() => chrome.windows.getAll({ populate: true }));
  assert.ok(windows.some(window => window.type === 'popup' && window.tabs.some(tab => tab.url === this.url(name))));
});
When('I split those two tabs', async function () {
  this.splitResult = await this.panel.evaluate(({ firstTabId, secondTabId }) => chrome.runtime.sendMessage({ type: 'CREATE_SPLIT_VIEW', firstTabId, secondTabId }), { firstTabId: this.tabIds['Split-one'], secondTabId: this.tabIds['Split-two'] });
});
Then('they share a native split or an explicit unsupported error is returned', async function () {
  const supported = await this.worker.evaluate(() => typeof chrome.tabs.createSplit === 'function');
  if (!supported) assert.match(this.splitResult.error, /does not expose the Split View API/);
  else {
    assert.equal(this.splitResult.ok, true, this.splitResult.error);
    const tabs = await this.worker.evaluate(ids => Promise.all(ids.map(id => chrome.tabs.get(id))), [this.tabIds['Split-one'], this.tabIds['Split-two']]);
    assert.ok(tabs[0].splitViewId >= 0); assert.equal(tabs[0].splitViewId, tabs[1].splitViewId);
  }
});
When('the auto archive alarm runs with an elapsed test interval', async function () {
  await this.message({ type: 'UPDATE_SETTINGS', settings: { autoArchiveHours: 1 / 3600000 } });
  await this.worker.evaluate(() => chrome.alarms.create('arc-auto-archive', { when: Date.now() + 25 }));
  // Observe completion through the actual extension state, not an artificial timer callback.
  await expect.poll(async () => {
    const snapshot = await this.snapshot();
    return snapshot.tabs.filter(tab => !tab.active && /^http:/.test(tab.url)
      && !snapshot.state.spaces.some(space => space.pinnedItems.some(item => item.type === 'link' && item.tabId === tab.id))).length;
  }).toBe(0);
  await this.refresh();
});
Then('the active fixture tab is still open', async function () {
  assert.ok((await this.snapshot()).tabs.some(tab => tab.url === this.url('Peek-parent')));
});
When('the sidebar is 360 pixels wide', async function () { await this.panel.setViewportSize({ width: 360, height: 900 }); });
Then('the sidebar has no horizontal overflow', async function () {
  const dimensions = await this.panel.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(dimensions.content <= dimensions.viewport, JSON.stringify(dimensions));
});
Then('its archive and settings controls remain visible', async function () {
  for (const button of [this.panel.getByRole('button', { name: 'Archived Tabs', exact: true }), this.panel.getByTitle('Arc Settings', { exact: true })]) {
    await expect(button).toBeInViewport();
  }
});
