<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from '../shared/messaging';
  import { shouldPeek } from '../shared/interaction';
  import CommandPalette from '../shared/CommandPalette.svelte';
  import Icon from '../shared/Icon.svelte';
  import { containFocus, isActivationKey } from '../shared/focus';
  import { getSpaceFavorites, getTodayTabs, isRootDomainUrl, sameHost, urlKey } from '../shared/tabs';
  import {
    type ArcState,
    type FavoriteItem,
    type OmniboxResultItem,
    type Space,
    type SpaceThemeId,
    type TabInfo,
    SPACE_THEMES,
    SUPPORTED_LANGUAGES,
    getFaviconUrl,
    parseCommandBarInput
  } from '../shared/types';

  let arcState = $state<ArcState>({
    spaces: [
      {
        id: 'space-personal',
        name: 'Personal',
        icon: '✨',
        theme: 'indigo',
        pinnedItems: []
      }
    ],
    activeSpaceId: 'space-personal',
    favorites: [],
    tabSpaceMap: {},
    tabLastAccessed: {},
    settings: {
      targetLanguage: 'en',
      translateOnSelectMode: 'pill',
      peekTrigger: 'shift-click',
      peekMode: 'overlay',
      leftSidebarMode: 'hover',
      syncChromeTabGroups: false,
      autoArchiveHours: 12
    }
  });

  let tabs = $state<TabInfo[]>([]);
  let copiedUrl = $state(false);
  let panelWindowId = $state<number | undefined>();
  let notice = $state('');
  let noticeTimer: ReturnType<typeof setTimeout>;
  let translationError = $state('');
  function notify(message: string) {
    notice = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice = '', 3500);
  }
  function focusInput(node: HTMLInputElement) { node.focus(); }
  function isCurrentUrl(url: string) {
    if (!activeTab) return false;
    return urlKey(url) === urlKey(activeTab.url) || (isRootDomainUrl(url) && sameHost(url, activeTab.url));
  }


  // Command Bar modal state inside Side Panel
  let showCommandBar = $state(false);

  // Space Creator / Editor modal
  let showSpaceModal = $state(false);
  let editingSpaceId = $state<string | null>(null);
  let savingSpace = $state(false);
  let confirmSpaceDelete = $state(false);
  let creatingFolder = $state(false);
  let spaceNameInput = $state('');
  let spaceIconInput = $state('✨');
  let spaceThemeInput = $state<SpaceThemeId>('indigo');

  // New Folder inline prompt
  let showNewFolderInput = $state(false);
  let newFolderName = $state('');

  // Quick Translator drawer in Sidebar
  let showTranslator = $state(false);
  let translateInputText = $state('');
  let translatedOutput = $state('');
  let translating = $state(false);

  // Settings drawer
  let showSettings = $state(false);
  let showArchive = $state(false);
  let archiveQuery = $state('');
  let renamingItem = $state<string | null>(null);
  let renameValue = $state('');
  let splitTargetId = $state('');
  let showSplit = $state(false);
  let archivedTabs = $derived((arcState.archive || []).filter((entry) =>
    `${entry.title} ${entry.url}`.toLowerCase().includes(archiveQuery.toLowerCase())));

  async function restoreArchive(archiveId: string) {
    try {
      await requestArc({ type: 'RESTORE_ARCHIVED_TAB', archiveId });
      await refreshSnapshot();
      notify('Tab restored');
    } catch { notify('Could not restore this tab. Try again.'); }
  }

  function startRename(event: MouseEvent, id: string, title: string) {
    event.stopPropagation(); renamingItem = id; renameValue = title;
  }

  async function saveRename() {
    try {
      await requestArc({ type: 'RENAME_PINNED_ITEM', itemId: renamingItem, title: renameValue });
      await refreshSnapshot(); renamingItem = null;
    } catch { notify('Could not rename this item.'); }
  }

  async function createSplit() {
    try {
      await requestArc({ type: 'CREATE_SPLIT_VIEW', firstTabId: activeTab?.id, secondTabId: Number(splitTargetId) });
      showSplit = false;
    } catch (error) { notify(error instanceof Error ? error.message : 'Split View unavailable'); }
  }


  // Move tab menu
  let movingTabId = $state<number | null>(null);

  const SPACE_ICONS = ['✨', '🚀', '🧪', '🎨', '📚', '💼', '🎮', '🌱', '⚡', '🪐'];

  let activeSpace = $derived<Space>(
    arcState.spaces.find((s) => s.id === arcState.activeSpaceId) || arcState.spaces[0]
  );

  let spaceFavorites = $derived<FavoriteItem[]>(getSpaceFavorites(arcState, activeSpace?.id));
  let showAddFavForm = $state(false);
  let customFavUrl = $state('');
  let customFavTitle = $state('');
  let showAddPinForm = $state(false);
  let customPinUrl = $state('');
  let customPinTitle = $state('');

  let currentTheme = $derived(SPACE_THEMES[activeSpace?.theme || 'indigo'] || SPACE_THEMES.indigo);

  let activeTab = $derived<TabInfo | undefined>(tabs.find((t) => t.active && (panelWindowId === undefined || t.windowId === panelWindowId)));

  let spaceTabs = $derived<TabInfo[]>(
    getTodayTabs(arcState, tabs, activeSpace?.id)
  );

  async function refreshSnapshot() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' });
      if (response?.state) {
        arcState = response.state;
        tabs = response.tabs || [];
      }
    } catch (err) {
      console.warn('Snapshot fetch error:', err);
    }
  }

  onMount(() => {
    chrome.windows.getCurrent().then((window) => panelWindowId = window.id).catch(() => {});
    refreshSnapshot();

    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'ARC_STATE_UPDATED') {
        refreshSnapshot();
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandBar();
      } else if (e.key === 'Escape') {
        showCommandBar = false;
        showSpaceModal = false;
        showSettings = false;
        showTranslator = false;
        movingTabId = null;
        showArchive = false;
        renamingItem = null;
        showSplit = false;
      }
    };
    window.addEventListener('keydown', handleKeydown);

    return () => {
      clearTimeout(noticeTimer);
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  function formatDisplayUrl(url?: string): string {
    if (!url) return 'Search or Enter URL...';
    if (url.startsWith('chrome://')) return url;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '');
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${host}${path}`.slice(0, 42);
    } catch {
      return url.slice(0, 42);
    }
  }

  async function copyText(text: string, message = 'Copied') {
    try { await navigator.clipboard.writeText(text); notify(message); return true; }
    catch { notify('Could not copy. Try again.'); return false; }
  }

  async function copyActiveUrl(e: MouseEvent) {
    e.stopPropagation();
    if (!activeTab?.url || !await copyText(activeTab.url, 'Link copied')) return;
    copiedUrl = true;
    setTimeout(() => copiedUrl = false, 1600);
  }

  function openCommandBar() {
    showCommandBar = true;
    showSpaceModal = false;
    showSettings = false;
    showTranslator = false;
  }

  async function executeOmniboxItem(item: OmniboxResultItem, inLittleArc = false) {
    if (item.kind === 'tab' && typeof item.tabId === 'number' && !inLittleArc) {
      if (item.spaceId && item.spaceId !== arcState.activeSpaceId) {
        await requestArc({ type: 'SET_ACTIVE_SPACE', spaceId: item.spaceId });
      }
      await requestArc({ type: 'SWITCH_TAB', tabId: item.tabId });
    } else if (item.kind === 'action' && item.actionId) {
      await requestArc({
        type: 'EXECUTE_OMNIBOX_ACTION',
        actionId: item.actionId
      });
    } else if (item.url) {
      if (inLittleArc) {
        await requestArc({ type: 'REQUEST_PEEK', url: item.url });
      } else {
        await requestArc({
          type: 'OPEN_OR_SWITCH_URL',
          url: item.url,
          spaceId: item.spaceId || arcState.activeSpaceId
        });
      }
    }
    await refreshSnapshot();
    showCommandBar = false;
  }

  async function switchSpace(spaceId: string) {
    const res = await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SPACE', spaceId });
    if (res?.state) {
      arcState = res.state;
      tabs = res.tabs;
    }
  }

  function openCreateSpaceModal() {
    confirmSpaceDelete = false;
    showSettings = false;
    showTranslator = false;
    editingSpaceId = null;
    spaceNameInput = '';
    spaceIconInput = '🪐';
    spaceThemeInput = 'sunset';
    showSpaceModal = true;
  }

  function openEditSpaceModal(space: Space) {
    confirmSpaceDelete = false;
    showSettings = false;
    showTranslator = false;
    editingSpaceId = space.id;
    spaceNameInput = space.name;
    spaceIconInput = space.icon;
    spaceThemeInput = space.theme;
    showSpaceModal = true;
  }

  async function saveSpaceModal() {
    if (!spaceNameInput.trim() || savingSpace) return;
    savingSpace = true;
    try {
      const res = await requestArc({ type: editingSpaceId ? 'UPDATE_SPACE' : 'CREATE_SPACE', spaceId: editingSpaceId,
        name: spaceNameInput, icon: spaceIconInput, theme: spaceThemeInput });
      if (res?.state) { arcState = res.state; tabs = res.tabs; }
      showSpaceModal = false;
      notify('Space saved');
    } catch { notify('Could not save this Space. Try again.'); }
    finally { savingSpace = false; }
  }

  async function deleteCurrentEditingSpace() {
    if (!editingSpaceId || arcState.spaces.length <= 1 || savingSpace) return;
    if (!confirmSpaceDelete) { confirmSpaceDelete = true; return; }
    savingSpace = true;
    try {
      const res = await requestArc({ type: 'DELETE_SPACE', spaceId: editingSpaceId });
      if (res?.state) { arcState = res.state; tabs = res.tabs; }
      showSpaceModal = false;
      notify('Space deleted. Open tabs were kept.');
    } catch { notify('Could not delete this Space. Try again.'); }
    finally { savingSpace = false; }
  }

  async function addActiveTabToFavorites() {
    if (!activeTab?.url) return;
    const res = await chrome.runtime.sendMessage({
      type: 'ADD_FAVORITE',
      spaceId: activeSpace.id,
      title: activeTab.title,
      url: activeTab.url,
      favIconUrl: activeTab.favIconUrl
    });
    if (res?.state) arcState = res.state;
  }

  async function addCustomSpaceFavorite() {
    const raw = customFavUrl.trim();
    if (!raw) return;
    const parsed = parseCommandBarInput(raw);
    const url = parsed.isUrl ? parsed.url : `https://${raw}`;
    const res = await chrome.runtime.sendMessage({
      type: 'ADD_FAVORITE',
      spaceId: activeSpace.id,
      title: customFavTitle.trim() || raw,
      url
    });
    if (res?.state) arcState = res.state;
    customFavUrl = '';
    customFavTitle = '';
    showAddFavForm = false;
  }

  async function addCustomSpacePin() {
    const raw = customPinUrl.trim();
    if (!raw) return;
    const parsed = parseCommandBarInput(raw);
    const url = parsed.isUrl ? parsed.url : `https://${raw}`;
    const res = await chrome.runtime.sendMessage({
      type: 'PIN_TAB_TO_SPACE',
      spaceId: activeSpace.id,
      title: customPinTitle.trim() || raw,
      url
    });
    if (res?.state) arcState = res.state;
    customPinUrl = '';
    customPinTitle = '';
    showAddPinForm = false;
  }

  async function removeFavorite(e: MouseEvent, favoriteId: string) {
    e.stopPropagation();
    const res = await chrome.runtime.sendMessage({
      type: 'REMOVE_FAVORITE',
      spaceId: activeSpace.id,
      favoriteId
    });
    if (res?.state) arcState = res.state;
  }

  async function pinTabToCurrentSpace(tab: TabInfo, folderId?: string) {
    const res = await chrome.runtime.sendMessage({
      type: 'PIN_TAB_TO_SPACE',
      spaceId: activeSpace.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      folderId
    });
    if (res?.state) arcState = res.state;
  }

  async function removePinnedItem(e: MouseEvent, itemId: string) {
    e.stopPropagation();
    const res = await chrome.runtime.sendMessage({
      type: 'REMOVE_PINNED_ITEM',
      spaceId: activeSpace.id,
      itemId
    });
    if (res?.state) arcState = res.state;
  }

  async function createNewFolder() {
    if (!newFolderName.trim() || creatingFolder) return;
    creatingFolder = true;
    try {
      const res = await requestArc({ type: 'CREATE_FOLDER', spaceId: activeSpace.id, title: newFolderName });
      if (res?.state) arcState = res.state;
      newFolderName = '';
      showNewFolderInput = false;
    } catch { notify('Could not create this folder. Try again.'); }
    finally { creatingFolder = false; }
  }

  async function toggleFolder(folderId: string) {
    const res = await chrome.runtime.sendMessage({
      type: 'TOGGLE_FOLDER',
      spaceId: activeSpace.id,
      folderId
    });
    if (res?.state) arcState = res.state;
  }

  async function openUrlOrSwitch(url: string, e?: MouseEvent) {
    if (e && shouldPeek(e, arcState.settings)) {
      await chrome.runtime.sendMessage({ type: 'REQUEST_PEEK', url });
      return;
    }
    await chrome.runtime.sendMessage({
      type: 'OPEN_OR_SWITCH_URL',
      url,
      spaceId: activeSpace.id
    });
  }

  async function activateTab(tabId: number) {
    await chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId });
  }

  async function closeTab(e: MouseEvent, tabId: number) {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: 'CLOSE_TAB', tabId });
  }

  async function toggleMuteTab(e: MouseEvent, tabId: number) {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TAB_MUTE', tabId });
  }

  async function clearTodayTabs() {
    const res = await chrome.runtime.sendMessage({
      type: 'CLEAR_TODAY_TABS',
      spaceId: activeSpace.id
    });
    if (res?.state) {
      arcState = res.state;
      tabs = res.tabs;
    }
  }

  async function moveTabToSpace(tabId: number, targetSpaceId: string) {
    const res = await chrome.runtime.sendMessage({
      type: 'MOVE_TAB_TO_SPACE',
      tabId,
      spaceId: targetSpaceId
    });
    if (res?.state) {
      arcState = res.state;
      tabs = res.tabs;
    }
    movingTabId = null;
  }

  async function runSidebarTranslation() {
    if (!translateInputText.trim()) return;
    translating = true;
    translationError = '';
    translatedOutput = '';
    const text = translateInputText;
    const language = arcState.settings.targetLanguage;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT', text, targetLang: language });
      if (res?.error || !res?.translatedText) throw new Error('Translation unavailable');
      if (translateInputText === text && arcState.settings.targetLanguage === language) translatedOutput = res.translatedText;
    } catch { translationError = 'Could not translate. Check your connection and try again.'; }
    finally { translating = false; }
  }

  async function updateSettings(partial: Partial<ArcState['settings']>) {
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: partial
    });
    if (res?.state) { arcState = res.state; notify('Settings saved'); }
  }
</script>

<div
  class="arc-sidebar"
  style="background: {currentTheme.gradient}; --accent: {currentTheme.accent}; --surface: {currentTheme.surface}; --border: {currentTheme.border};"
>
  <!-- Top Command / URL Bar -->
  <header class="top-section">
    <div
      class="url-bar"
      role="button"
      tabindex="0"
      onclick={openCommandBar}
      onkeydown={(e) => isActivationKey(e) && openCommandBar()}
      title="Click or press Cmd+K to open Command Bar"
    >
      <span class="url-icon"><Icon name="search" size={15} /></span>
      <span class="url-text">{formatDisplayUrl(activeTab?.url)}</span>
      <div class="url-actions">
        {#if activeTab?.url && !activeTab.url.startsWith('chrome://')}
          <button
            class="icon-btn"
            onclick={copyActiveUrl}
            title="Copy page link"
          >
            <Icon name={copiedUrl ? 'check' : 'link'} size={14} />
          </button>
          <button
            class="icon-btn"
            onclick={(e) => {
              e.stopPropagation();
              if (activeTab?.url) {
                chrome.runtime.sendMessage({ type: 'OPEN_LITTLE_ARC', url: activeTab.url });
              }
            }}
            title="Pop out into Little Arc window"
          >
            <Icon name="window" size={14} />
          </button>
        {/if}
      </div>
    </div>

    <!-- Space-Specific Top Pins / Favorites Grid -->
    <div class="favorites-grid">
      {#each spaceFavorites as fav (fav.id)}
        <div
          class="favorite-tile" class:active={isCurrentUrl(fav.url)}
          aria-label={fav.title} role="button"
          tabindex="0"
          onclick={(e) => openUrlOrSwitch(fav.url, e)}
          onkeydown={(e) => isActivationKey(e) && openUrlOrSwitch(fav.url)}
          title="{fav.title} ({fav.url}) — Shift+Click for Peek"
        >
          {#if getFaviconUrl(fav.url, fav.favIconUrl)}
            <img src={getFaviconUrl(fav.url, fav.favIconUrl)} alt={fav.title} class="fav-icon" />
          {:else}
            <span class="fav-fallback">{fav.title.slice(0, 1).toUpperCase()}</span>
          {/if}
          <button
            class="fav-remove"
            onclick={(e) => removeFavorite(e, fav.id)}
            title="Remove from {activeSpace?.name} top pins" aria-label="Remove {fav.title} from Favorites"
          >
            ×
          </button>
        </div>
      {/each}

      {#if spaceFavorites.length < 12}
        <button
          class="favorite-tile add-fav-tile"
          onclick={() => {
            showAddFavForm = !showAddFavForm;
            showAddPinForm = false;
          }}
          title="Add custom top pin to {activeSpace?.name}" aria-label="Add custom top pin to {activeSpace?.name}"
        >
          <span>+</span>
        </button>
      {/if}
    </div>

    {#if showAddFavForm}
      <div class="new-folder-box" style="flex-direction: column; align-items: stretch; gap: 6px; margin-top: 8px;">
        {#if activeTab?.url && !activeTab.url.startsWith('chrome://')}
          <button
            style="width: 100%;"
            onclick={async () => {
              await addActiveTabToFavorites();
              showAddFavForm = false;
            }}
          >
            📌 Pin Current Tab ({formatDisplayUrl(activeTab.url)})
          </button>
        {/if}
        <input
          type="text"
          placeholder="Custom URL (e.g. figma.com, github.com)..."
          use:focusInput
          bind:value={customFavUrl}
          onkeydown={(e) => {
            if (e.key === 'Enter') addCustomSpaceFavorite();
            if (e.key === 'Escape') { e.stopPropagation(); showAddFavForm = false; }
          }}
        />
        <div style="display: flex; gap: 6px;">
          <input
            type="text"
            placeholder="Title (optional)"
            bind:value={customFavTitle}
            onkeydown={(e) => {
              if (e.key === 'Enter') addCustomSpaceFavorite();
            }}
          />
          <button onclick={addCustomSpaceFavorite} disabled={!customFavUrl.trim()}>Add</button>
        </div>
      </div>
    {/if}
  </header>

  <!-- Main Scrollable Area: Space Header, Pinned Items, Divider, Today's Tabs -->
  <main class="sidebar-scroll">
    <!-- Active Space Title Bar -->
    <div class="space-header">
      <button
        class="space-title-btn"
        onclick={() => openEditSpaceModal(activeSpace)}
        title="Click to customize Space name, icon & theme"
      >
        <span class="space-emoji">{activeSpace?.icon}</span>
        <span class="space-name">{activeSpace?.name}</span>
      </button>
      <div class="space-header-actions">
        <button
          class="mini-action-btn"
          onclick={() => {
            showAddPinForm = !showAddPinForm;
            showNewFolderInput = false;
          }}
          title="Add custom pinned URL to {activeSpace?.name}"
        >
          +
        </button>
        <button
          class="mini-action-btn"
          onclick={() => {
            showNewFolderInput = !showNewFolderInput;
            showAddPinForm = false;
          }}
          title="New Pinned Folder"
        >
          <Icon name="folder" size={14} />
        </button>
        {#if activeTab}
          <button
            class="mini-action-btn"
            onclick={() => activeTab && pinTabToCurrentSpace(activeTab)}
            title="Pin active tab to {activeSpace?.name}"
          >
            <Icon name="pin" size={14} />
          </button>
        {/if}
      </div>
    </div>

    {#if showAddPinForm}
      <div class="new-folder-box" style="flex-direction: column; align-items: stretch; gap: 6px;">
        <input
          type="text"
          placeholder="Custom URL to pin in {activeSpace?.name}..."
          use:focusInput
          bind:value={customPinUrl}
          onkeydown={(e) => {
            if (e.key === 'Enter') addCustomSpacePin();
            if (e.key === 'Escape') { e.stopPropagation(); showAddPinForm = false; }
          }}
        />
        <div style="display: flex; gap: 6px;">
          <input
            type="text"
            placeholder="Custom title (optional)"
            bind:value={customPinTitle}
            onkeydown={(e) => {
              if (e.key === 'Enter') addCustomSpacePin();
            }}
          />
          <button onclick={addCustomSpacePin} disabled={!customPinUrl.trim()}>Pin</button>
        </div>
      </div>
    {/if}

    {#if showNewFolderInput}
      <div class="new-folder-box">
        <input
          type="text"
          placeholder="Folder name"
          use:focusInput
          bind:value={newFolderName}
          onkeydown={(e) => { if (e.key === 'Enter') createNewFolder(); if (e.key === 'Escape') { e.stopPropagation(); showNewFolderInput = false; } }}
        />
        <button onclick={createNewFolder} disabled={creatingFolder || !newFolderName.trim()}>Add</button>
      </div>
    {/if}

    <!-- Pinned Tabs & Folders -->
    {#if activeSpace?.pinnedItems.length > 0}
      <section class="pinned-section">
        {#each activeSpace.pinnedItems as item (item.id)}
          {#if item.type === 'folder'}
            <div class="folder-group">
              <div
                class="pinned-row folder-row" aria-expanded={!item.collapsed}
                role="button"
                tabindex="0"
                onclick={() => toggleFolder(item.id)}
                onkeydown={(e) => isActivationKey(e) && toggleFolder(item.id)}
              >
                <span class="folder-caret">{item.collapsed ? '▸' : '▾'}</span>
                <span class="folder-icon"><Icon name="folder" size={16} /></span>
                <span class="row-title">{item.title}</span>
                <div class="row-hover-actions">
                  <button class="row-btn" aria-label="Rename {item.title}" title="Rename" onclick={(event) => startRename(event, item.id, item.title)}>✎</button>
                  {#if activeTab}
                    <button
                      class="row-btn"
                      onclick={(e) => {
                        e.stopPropagation();
                        if (activeTab) pinTabToCurrentSpace(activeTab, item.id);
                      }}
                      title="Pin current tab into this folder"
                    >
                      +
                    </button>
                  {/if}
                  <button
                    class="row-btn"
                    onclick={(e) => removePinnedItem(e, item.id)}
                    title="Delete folder" aria-label="Remove folder {item.title}"
                  >
                    ×
                  </button>
                </div>
              </div>

              {#if !item.collapsed}
                <div class="folder-children">
                  {#each item.children as child (child.id)}
                    <div
                      class="pinned-row child-row" class:active={isCurrentUrl(child.url) || activeTab?.id === child.tabId}
                      role="button"
                      tabindex="0"
                      onclick={(e) => openUrlOrSwitch(child.url, e)}
                      onkeydown={(e) => isActivationKey(e) && openUrlOrSwitch(child.url)}
                      title="{child.title} ({child.url})"
                    >
                      {#if getFaviconUrl(child.url, child.favIconUrl)}
                        <img
                          src={getFaviconUrl(child.url, child.favIconUrl)}
                          alt=""
                          class="row-favicon"
                        />
                      {:else}
                        <span class="row-favicon-fallback"><Icon name="globe" /></span>
                      {/if}
                      <span class="row-title">{child.title}</span>
                      <div class="row-hover-actions">
                        <button class="row-btn" aria-label="Rename {child.title}" title="Rename" onclick={(event) => startRename(event, child.id, child.title)}>✎</button>
                        <button
                          class="row-btn"
                          onclick={(e) => {
                            e.stopPropagation();
                            chrome.runtime.sendMessage({ type: 'REQUEST_PEEK', url: child.url });
                          }}
                          title="Open in Peek / Little Arc"
                        >
                          <Icon name="eye" size={14} />
                        </button>
                        <button
                          class="row-btn"
                          onclick={(e) => removePinnedItem(e, child.id)}
                          title="Unpin" aria-label="Unpin {child.title}"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div
              class="pinned-row" class:active={isCurrentUrl(item.url) || activeTab?.id === item.tabId}
              role="button"
              tabindex="0"
              onclick={(e) => openUrlOrSwitch(item.url, e)}
              onkeydown={(e) => isActivationKey(e) && openUrlOrSwitch(item.url)}
              title="{item.title} ({item.url}) — Shift+Click for Peek"
            >
              {#if getFaviconUrl(item.url, item.favIconUrl)}
                <img
                  src={getFaviconUrl(item.url, item.favIconUrl)}
                  alt=""
                  class="row-favicon"
                />
              {:else}
                <span class="row-favicon-fallback"><Icon name="globe" /></span>
              {/if}
              <span class="row-title">{item.title}</span>
              <div class="row-hover-actions">
                <button class="row-btn" aria-label="Rename {item.title}" title="Rename" onclick={(event) => startRename(event, item.id, item.title)}>✎</button>
                <button
                  class="row-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    chrome.runtime.sendMessage({ type: 'REQUEST_PEEK', url: item.url });
                  }}
                  title="Open in Peek / Little Arc"
                >
                  <Icon name="eye" size={14} />
                </button>
                <button
                  class="row-btn"
                  onclick={(e) => removePinnedItem(e, item.id)}
                  title="Unpin" aria-label="Unpin {item.title}"
                >
                  ×
                </button>
              </div>
            </div>
          {/if}
        {/each}
      </section>
    {/if}

    <!-- Arc Divider between Pinned and Today's Tabs -->
    <div class="arc-divider">
      <span class="divider-label">Today · {spaceTabs.length}</span>
      <div class="divider-line"></div>
      {#if spaceTabs.some((tab) => !tab.active)}
        <button class="clear-btn" onclick={clearTodayTabs} title="Close inactive tabs in Today">
          Clear
        </button>
      {/if}
    </div>

    <!-- New Tab Button -->
    <button
      class="new-tab-row" aria-label="New Tab"
      onclick={openCommandBar}
    >
      <span class="plus-icon">+</span>
      <span>New Tab</span>
      <span class="shortcut-hint">⌘K</span>
    </button>

    <!-- Today's Open Tabs in Current Space -->
    <section class="today-tabs">
      {#each spaceTabs as tab (tab.id)}
        <div
          class="tab-row {tab.active ? 'active' : ''}"
          role="button"
          tabindex="0"
          onclick={() => activateTab(tab.id)}
          onkeydown={(e) => isActivationKey(e) && activateTab(tab.id)}
          title={tab.title}
        >
          {#if getFaviconUrl(tab.url, tab.favIconUrl)}
            <img src={getFaviconUrl(tab.url, tab.favIconUrl)} alt="" class="row-favicon" />
          {:else}
            <span class="row-favicon-fallback"><Icon name="globe" /></span>
          {/if}

          <span class="row-title">{tab.title}</span>

          {#if tab.audible || tab.muted}
            <button
              class="audio-badge"
              onclick={(e) => toggleMuteTab(e, tab.id)}
              title={tab.muted ? 'Unmute tab' : 'Mute tab'}
            >
              {tab.muted ? '🔇' : '🔊'}
            </button>
          {/if}

          <div class="row-hover-actions">
            <button
              class="row-btn"
              onclick={(e) => {
                e.stopPropagation();
                pinTabToCurrentSpace(tab);
              }}
              title="Pin to {activeSpace?.name}"
            >
              <Icon name="pin" size={13} />
            </button>
            <button
              class="row-btn"
              onclick={(e) => {
                e.stopPropagation();
                movingTabId = movingTabId === tab.id ? null : tab.id;
              }}
              title="Move tab to another Space"
            >
              <Icon name="move" size={13} />
            </button>
            <button
              class="row-btn close-btn"
              onclick={(e) => closeTab(e, tab.id)}
              title="Close tab" aria-label="Close {tab.title}"
            >
              ×
            </button>
          </div>
        </div>

        {#if movingTabId === tab.id}
          <div class="move-space-strip">
            <span>Move to:</span>
            {#each arcState.spaces as sp (sp.id)}
              {#if sp.id !== activeSpace.id}
                <button onclick={() => moveTabToSpace(tab.id, sp.id)}>
                  {sp.icon} {sp.name}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      {/each}
      {#if !spaceTabs.length}
        <p class="empty-state">No tabs in Today.<br /><span>Open a new tab to get started.</span></p>
      {/if}
    </section>
  </main>

  <!-- Bottom Dock: Space Switcher, Translator & Settings -->
  <footer class="bottom-dock">
    <div class="spaces-switcher">
      {#each arcState.spaces as space (space.id)}
        <button
          class="space-pill {space.id === activeSpace?.id ? 'active' : ''}"
          onclick={() => switchSpace(space.id)}
          ondblclick={() => openEditSpaceModal(space)}
          title="{space.name} Space (Double-click to edit)" aria-label={space.name} aria-pressed={space.id === activeSpace?.id}
        >
          <span>{space.icon}</span>
        </button>
      {/each}
      <button
        class="space-pill add-space-pill"
        onclick={openCreateSpaceModal}
        title="Create New Space"
      >
        +
      </button>
    </div>

    <div class="dock-utilities">
      <button class="utility-btn" title="Archived Tabs" aria-label="Archived Tabs" onclick={() => showArchive = true}>↺</button>
      <button class="utility-btn" title="Split View" aria-label="Split View" onclick={() => { splitTargetId = ''; showSplit = true; }}>◫</button>
      <button
        class="utility-btn {showTranslator ? 'active' : ''}"
        onclick={() => {
          showTranslator = !showTranslator;
          showSettings = false;
        }}
        title="Arc Quick Translator"
      >
        <Icon name="globe" size={16} />
      </button>
      <button
        class="utility-btn {showSettings ? 'active' : ''}"
        onclick={() => {
          showSettings = !showSettings;
          showTranslator = false;
        }}
        title="Arc Settings"
      >
        <Icon name="settings" size={16} />
      </button>
    </div>
  </footer>

  {#if showArchive}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Archived Tabs">
      <div class="drawer-card" use:containFocus>
        <div class="drawer-header"><h3>Archived Tabs</h3><button class="close-drawer" aria-label="Close archive" onclick={() => showArchive = false}>×</button></div>
        <input aria-label="Search archived tabs" placeholder="Search archived tabs" bind:value={archiveQuery} data-autofocus />
        <div class="archive-list">
          {#each archivedTabs as entry (entry.id)}
            <div class="archive-entry"><div><strong>{entry.title}</strong><small>{entry.url}</small><small>{new Date(entry.archivedAt).toLocaleString()}</small></div><button class="primary-btn" aria-label="Restore {entry.title}" onclick={() => restoreArchive(entry.id)}>Restore</button></div>
          {:else}<p class="drawer-hint">No archived tabs found.</p>{/each}
        </div>
      </div>
    </div>
  {/if}
  {#if renamingItem}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Rename pinned item">
      <form class="drawer-card" use:containFocus onsubmit={(event) => { event.preventDefault(); saveRename(); }}>
        <div class="drawer-header"><h3>Rename</h3><button type="button" class="close-drawer" aria-label="Cancel rename" onclick={() => renamingItem = null}>×</button></div>
        <input aria-label="Pinned item name" bind:value={renameValue} data-autofocus />
        <button class="primary-btn" disabled={!renameValue.trim()}>Save name</button>
      </form>
    </div>
  {/if}
  {#if showSplit}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Split View">
      <div class="drawer-card" use:containFocus>
        <div class="drawer-header"><h3>Split View</h3><button class="close-drawer" aria-label="Close split view" onclick={() => showSplit = false}>×</button></div>
        <p class="drawer-hint">Show two tabs side by side. Requires a browser with native extension Split View support.</p>
        <select aria-label="Tab to split with" bind:value={splitTargetId}>
          <option value="">Choose a tab</option>
          {#each tabs.filter((tab) => tab.id !== activeTab?.id && tab.windowId === activeTab?.windowId && tab.spaceId === activeSpace.id) as tab}
            <option value={String(tab.id)}>{tab.title}</option>
          {/each}
        </select>
        <button class="primary-btn" disabled={!splitTargetId} onclick={createSplit}>Create split</button>
      </div>
    </div>
  {/if}

  <!-- Quick Translator Drawer -->
  {#if showTranslator}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Quick Translator">
      <div class="drawer-card" use:containFocus>
        <div class="drawer-header">
          <h3>Translate</h3>
          <button class="close-drawer" aria-label="Close dialog" onclick={() => (showTranslator = false)}>×</button>
        </div>
        <p class="drawer-hint">
          Translate text here, or select text on a page to translate it there.
        </p>
        <div class="form-row">
          <label for="sidebar-target-lang">Translate into</label>
          <select
            id="sidebar-target-lang"
            value={arcState.settings.targetLanguage}
            onchange={(e) =>
              updateSettings({ targetLanguage: (e.currentTarget as HTMLSelectElement).value })}
          >
            {#each SUPPORTED_LANGUAGES as lang}
              <option value={lang.code}>{lang.name}</option>
            {/each}
          </select>
        </div>
        <textarea
          rows="4" aria-label="Text to translate" data-autofocus
          placeholder="Paste or type text to translate..."
          bind:value={translateInputText}
          onkeydown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runSidebarTranslation();
          }}
        ></textarea>
        <button class="primary-btn" onclick={runSidebarTranslation} disabled={translating || !translateInputText.trim()}>
          {translating ? 'Translating...' : 'Translate'}
        </button>
        {#if translationError}<p class="form-error" role="alert">{translationError}</p>{/if}
        {#if translatedOutput}
          <div class="translation-result" aria-live="polite">
            <p>{translatedOutput}</p>
            <button
              class="mini-copy-btn"
              onclick={() => copyText(translatedOutput, 'Translation copied')}
            >
              Copy
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Settings Drawer -->
  {#if showSettings}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Arc Settings">
      <div class="drawer-card" use:containFocus>
        <div class="drawer-header">
          <h3>Settings</h3>
          <button class="close-drawer" aria-label="Close dialog" onclick={() => (showSettings = false)}>×</button>
        </div>

        <div class="form-row">
          <label for="setting-target-lang">Translation language</label>
          <select
            id="setting-target-lang"
            value={arcState.settings.targetLanguage}
            onchange={(e) =>
              updateSettings({ targetLanguage: (e.currentTarget as HTMLSelectElement).value })}
          >
            {#each SUPPORTED_LANGUAGES as lang}
              <option value={lang.code}>{lang.name}</option>
            {/each}
          </select>
        </div>

        <div class="form-row">
          <label for="setting-translate-mode">When selecting text</label>
          <select
            id="setting-translate-mode"
            value={arcState.settings.translateOnSelectMode}
            onchange={(e) =>
              updateSettings({
                translateOnSelectMode: (e.currentTarget as HTMLSelectElement).value as
                  | 'pill'
                  | 'instant'
                  | 'shortcut'
              })}
          >
            <option value="pill">Show Translate button</option>
            <option value="instant">Translate automatically</option>
            <option value="shortcut">Use shortcut only</option>
          </select>
        </div>

        <div class="form-row">
          <label for="setting-peek-trigger">Open links in Peek</label>
          <select
            id="setting-peek-trigger"
            value={arcState.settings.peekTrigger}
            onchange={(e) =>
              updateSettings({
                peekTrigger: (e.currentTarget as HTMLSelectElement).value as
                  | 'shift-click'
                  | 'alt-click'
                  | 'off'
              })}
          >
            <option value="shift-click">Shift-click</option>
            <option value="alt-click">Option / Alt-click</option>
            <option value="off">Use menu only</option>
          </select>
        </div>

        <div class="form-row">
          <label for="setting-peek-mode">Preview style</label>
          <select
            id="setting-peek-mode"
            value={arcState.settings.peekMode}
            onchange={(e) =>
              updateSettings({
                peekMode: (e.currentTarget as HTMLSelectElement).value as 'overlay' | 'popup'
              })}
          >
            <option value="overlay">Peek over the current page</option>
            <option value="popup">Little Arc window</option>
          </select>
        </div>

        <div class="form-row">
          <label for="setting-left-sidebar">Sidebar on webpages</label>
          <select
            id="setting-left-sidebar"
            value={arcState.settings.leftSidebarMode}
            onchange={(e) =>
              updateSettings({
                leftSidebarMode: (e.currentTarget as HTMLSelectElement).value as
                  | 'hover'
                  | 'pinned'
                  | 'off'
              })}
          >
            <option value="hover">Show on hover</option>
            <option value="pinned">Always visible</option>
            <option value="off">Hidden</option>
          </select>
        </div>

        <button
          class="primary-btn"
          onclick={() =>
            chrome.runtime.sendMessage({
              type: 'CREATE_TAB',
              url: 'chrome://settings/appearance'
            })}
        >
          Open Chrome sidebar settings
        </button>

        <div class="form-row">
          <label for="auto-archive-hours">Auto archive inactive tabs</label>
          <select id="auto-archive-hours" value={arcState.settings.autoArchiveHours} onchange={(event) => updateSettings({ autoArchiveHours: Number(event.currentTarget.value) })}>
            <option value="0">Never</option><option value="12">After 12 hours</option><option value="24">After 24 hours</option><option value="168">After 7 days</option><option value="720">After 30 days</option>
          </select>
        </div>
        <button class="primary-btn" onclick={async () => { try { await requestArc({ type: 'RESET_SPACE' }); notify('Pinned tabs reset'); } catch { notify('Could not reset pinned tabs.'); } }}>Reset pinned tabs to saved URLs</button>
        <div class="shortcuts-summary">
          <div><span>Toggle Left Sidebar</span><kbd>Alt + S</kbd></div>
          <div><span>Command Bar</span><kbd>⌘K / Ctrl+K</kbd></div>
          <div><span>Peek Link</span><kbd>Shift + Click</kbd></div>
          <div><span>Translate Selection</span><kbd>Highlight / Alt+T</kbd></div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Space Create/Edit Modal -->
  {#if showSpaceModal}
    <div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Customize Space">
      <div class="drawer-card" use:containFocus>
        <div class="drawer-header">
          <h3>{editingSpaceId ? 'Customize Space' : 'New Space'}</h3>
          <button class="close-drawer" aria-label="Close dialog" onclick={() => (showSpaceModal = false)}>×</button>
        </div>

        <div class="form-row">
          <label for="space-name-input">Name</label>
          <input
            id="space-name-input" data-autofocus
            type="text"
            placeholder="Space name"
            onkeydown={(e) => { if (e.key === 'Enter' && spaceNameInput.trim()) saveSpaceModal(); }}
            bind:value={spaceNameInput}
          />
        </div>

        <div class="form-row">
          <span>Icon</span>
          <div class="icon-picker">
            {#each SPACE_ICONS as ic}
              <button
                class="icon-choice {spaceIconInput === ic ? 'selected' : ''}" aria-pressed={spaceIconInput === ic} aria-label="Use {ic} for this Space"
                onclick={() => (spaceIconInput = ic)}
              >
                {ic}
              </button>
            {/each}
          </div>
        </div>

        <div class="form-row">
          <span>Theme</span>
          <div class="theme-picker">
            {#each Object.values(SPACE_THEMES) as th}
              <button
                class="theme-swatch {spaceThemeInput === th.id ? 'selected' : ''}" aria-pressed={spaceThemeInput === th.id}
                style="background: {th.gradient}; border-color: {spaceThemeInput === th.id ? '#fff' : 'transparent'};"
                onclick={() => (spaceThemeInput = th.id)}
                title={th.name}
              >
                <span>{th.name}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if confirmSpaceDelete}
          <p class="drawer-hint" role="alert">Delete this Space and its saved links? Open tabs will move to another Space.</p>
        {/if}
        <div class="modal-actions">
          {#if editingSpaceId && arcState.spaces.length > 1}
            <button class="danger-btn" onclick={deleteCurrentEditingSpace} disabled={savingSpace}>{confirmSpaceDelete ? 'Confirm delete' : 'Delete Space'}</button>
          {/if}
          {#if confirmSpaceDelete}
            <button class="mini-action-btn" onclick={() => confirmSpaceDelete = false} disabled={savingSpace}>Cancel</button>
          {:else}
            <button class="primary-btn" onclick={saveSpaceModal} disabled={savingSpace || !spaceNameInput.trim()}>{savingSpace ? 'Saving…' : 'Save'}</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <div class="notice" class:visible={!!notice} role="status" aria-live="polite">{notice}</div>
  {#if showCommandBar}
    <div class="cmd-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) showCommandBar = false; }}>
      <CommandPalette onexecute={executeOmniboxItem} onclose={() => showCommandBar = false} />
    </div>
  {/if}
</div>

<style>
  .archive-list { max-height: 55dvh; overflow-y: auto; margin-top: 12px; }
  .archive-entry { display: flex; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid #ffffff20; }
  .archive-entry > div { flex: 1; min-width: 0; }
  .archive-entry strong, .archive-entry small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .archive-entry small { opacity: .65; margin-top: 4px; font-size: 10px; }
  .archive-entry .primary-btn { width: auto; }

  .arc-sidebar {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100dvh;
    min-height: 0;
    padding: 14px 12px 10px;
    transition: background 0.35s ease;
    position: relative;
    overflow: hidden;
  }

  .top-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 16px;
  }

  .url-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid #ffffff0c;
    backdrop-filter: blur(16px);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .url-bar:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .url-icon {
    font-size: 13px;
    opacity: 0.75;
  }

  .url-text {
    flex: 1;
    font-size: 12.5px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .url-actions {
    display: flex;
    gap: 4px;
  }

  .icon-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #fff;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  /* Favorites Grid */
  .favorites-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(48px, 1fr));
    gap: 7px;
  }

  .favorite-tile {
    position: relative;
    height: 48px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.09);
    border: 1px solid rgba(255, 255, 255, 0.07);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.15s ease;
  }

  .favorite-tile:hover {
    background: rgba(255, 255, 255, 0.17);
    transform: translateY(-1px);
  }

  .fav-icon {
    width: 22px;
    height: 22px;
    border-radius: 5px;
  }

  .fav-fallback {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
  }

  .fav-remove {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    background: rgba(20, 20, 35, 0.9);
    color: #fff;
    font-size: 11px;
    line-height: 1;
    display: flex;
    opacity: 0;
    pointer-events: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .favorite-tile:hover .fav-remove,
  .favorite-tile:focus-within .fav-remove {
    opacity: 1;
    pointer-events: auto;
  }

  .add-fav-tile {
    color: rgba(255, 255, 255, 0.55);
    font-size: 18px;
    border-style: dashed;
  }

  /* Scrollable middle area */
  .sidebar-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    overscroll-behavior: contain;
    padding-right: 2px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .sidebar-scroll::-webkit-scrollbar {
    width: 4px;
  }

  .sidebar-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
    border-radius: 4px;
  }

  .space-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px;
    margin-bottom: 2px;
  }

  .space-title-btn {
    background: none;
    border: none;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -.1px;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 7px;
  }

  .space-title-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .space-header-actions {
    display: flex;
    gap: 4px;
  }

  .mini-action-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.07);
    color: rgba(255, 255, 255, 0.85);
    font-size: 11px;
    padding: 5px 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    border-radius: 6px;
    cursor: pointer;
  }

  .mini-action-btn:hover {
    background: rgba(255, 255, 255, 0.18);
  }

  .new-folder-box {
    display: flex;
    gap: 6px;
    padding: 4px 6px;
  }

  .new-folder-box input {
    flex: 1;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
    color: #fff;
    font-size: 12px;
  }

  .new-folder-box button {
    background: var(--accent);
    border: none;
    color: #111;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }

  .pinned-section,
  .today-tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .pinned-row,
  .tab-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 9px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.86);
    font-size: 13px;
    min-height: 36px;
    transition: background 0.12s ease;
    position: relative;
  }

  .pinned-row:hover,
  .tab-row:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .tab-row.active,
  .pinned-row.active {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  }

  .child-row {
    padding-left: 26px;
  }

  .folder-caret {
    font-size: 11px;
    opacity: 0.7;
    width: 10px;
  }

  .row-favicon {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .row-favicon-fallback {
    width: 16px;
    height: 16px;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .row-title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .audio-badge {
    background: rgba(255, 255, 255, 0.14);
    border: none;
    border-radius: 5px;
    padding: 2px 5px;
    font-size: 11px;
    cursor: pointer;
  }

  .row-hover-actions {
    display: flex;
    opacity: 0;
    pointer-events: none;
    align-items: center;
    gap: 2px;
  }

  .pinned-row:hover .row-hover-actions,
  .tab-row:hover .row-hover-actions,
  .pinned-row:focus-within .row-hover-actions,
  .tab-row:focus-within .row-hover-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .row-btn {
    background: rgba(255, 255, 255, 0.12);
    border: none;
    color: #fff;
    width: 24px;
    height: 24px;
    border-radius: 5px;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .row-btn:hover {
    background: rgba(255, 255, 255, 0.26);
  }

  .arc-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 6px 4px;
  }

  .divider-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .1px;
    color: rgba(255, 255, 255, 0.5);
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: rgba(255, 255, 255, 0.14);
  }

  .clear-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 5px;
  }

  .clear-btn:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.12);
  }

  .new-tab-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border-radius: 9px;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }

  .new-tab-row:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  .plus-icon {
    font-size: 15px;
    font-weight: 600;
    width: 16px;
    text-align: center;
  }

  .shortcut-hint {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.45;
  }

  .move-space-strip {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    padding: 5px 8px;
    margin: 2px 4px 4px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.28);
    font-size: 11px;
  }

  .move-space-strip button {
    background: rgba(255, 255, 255, 0.12);
    border: none;
    color: #fff;
    padding: 3px 7px;
    border-radius: 5px;
    font-size: 11px;
    cursor: pointer;
  }

  /* Bottom Dock */
  .bottom-dock {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 8px;
    margin-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }

  .spaces-switcher {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    overflow-x: auto;
  }

  .space-pill {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    font-size: 15px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .space-pill:hover {
    background: rgba(255, 255, 255, 0.18);
  }

  .space-pill.active {
    background: rgba(255, 255, 255, 0.24);
    border-color: var(--accent);

  }

  .add-space-pill {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.65);
  }

  .dock-utilities {
    flex-shrink: 0;
    display: flex;
    gap: 5px;
  }

  .utility-btn {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    border: none;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    font-size: 14px;
    cursor: pointer;
  }

  .utility-btn.active,
  .utility-btn:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  /* Drawers & Modals */
  .drawer-overlay {
    position: absolute;
    inset: 0;
    background: rgba(8, 8, 16, 0.72);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-end;
    z-index: 50;
  }

  .drawer-card {
    width: 100%;
    max-height: 88%;
    overflow-y: auto;
    background: #292830;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 16px;
    margin: 8px;
    box-shadow: 0 16px 48px #0005;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .drawer-header h3 {
    font-size: 15px;
    font-weight: 600;
  }

  .close-drawer {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #fff;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    cursor: pointer;
  }

  .drawer-hint {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.65);
    line-height: 1.4;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
  }

  .form-row label,
  .form-row > span {
    color: rgba(255, 255, 255, 0.75);
    font-weight: 500;
  }

  .form-row select,
  .form-row input,
  .drawer-card textarea {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    padding: 7px 9px;
    color: #fff;
    font-size: 12.5px;
    font-family: inherit;
  }

  .primary-btn {
    background: #d8d3fa;
    color: #252131;
    font-weight: 700;
    border: none;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12.5px;
  }

  .danger-btn {
    background: rgba(244, 63, 94, 0.2);
    color: #fda4af;
    border: 1px solid rgba(244, 63, 94, 0.4);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12.5px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .translation-result {
    background: rgba(255, 255, 255, 0.09);
    padding: 10px;
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.45;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mini-copy-btn {
    align-self: flex-end;
    background: rgba(255, 255, 255, 0.14);
    border: none;
    color: #fff;
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 11px;
    cursor: pointer;
  }

  .icon-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .icon-choice {
    width: 30px;
    height: 30px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
    font-size: 15px;
  }

  .icon-choice.selected {
    border-color: var(--accent);
    background: rgba(255, 255, 255, 0.22);
  }

  .theme-picker {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }

  .theme-swatch {
    padding: 8px;
    border-radius: 8px;
    border: 2px solid transparent;
    color: #fff;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }

  .theme-swatch.selected {
    border-color: #fff;
  }

  .shortcuts-summary {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11.5px;
  }

  .shortcuts-summary div {
    display: flex;
    justify-content: space-between;
    color: rgba(255, 255, 255, 0.75);
  }

  .shortcuts-summary kbd {
    background: rgba(255, 255, 255, 0.14);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10.5px;
  }

  .cmd-backdrop { position: absolute; inset: 0; background: #10101488; backdrop-filter: blur(12px); padding: 16px 10px; z-index: 60; display: flex; align-items: flex-start; }
  .space-title-btn { min-width: 0; }
  .space-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .space-header-actions, .space-pill, .utility-btn, .row-btn { flex-shrink: 0; }
  .favorite-tile.active { background: #ffffff23; box-shadow: inset 0 0 0 1px #ffffff30; }
  .empty-state { text-align: center; padding: 32px 12px; color: #ffffffb3; font-size: 12px; line-height: 1.8; }
  .empty-state span { color: #ffffff75; }
  .notice { position: absolute; bottom: 62px; left: 16px; right: 16px; border: 1px solid #ffffff1a; border-radius: 10px; background: #313039; color: #f4f3fa; padding: 11px 14px; font-size: 12px; box-shadow: 0 8px 24px #0003; z-index: 80; opacity: 0; pointer-events: none; transform: translateY(4px); transition: opacity 140ms ease, transform 140ms ease; }
  .notice.visible { opacity: 1; transform: none; }
  .form-error { color: #ffc1bf; font-size: 12px; line-height: 1.5; }
  .arc-sidebar :global(button), .arc-sidebar :global(input), .arc-sidebar :global(select), .arc-sidebar :global(textarea) { font-family: inherit; }
  .arc-sidebar :global(button:focus-visible), .arc-sidebar :global([role="button"]:focus-visible), .arc-sidebar :global(input:focus-visible), .arc-sidebar :global(select:focus-visible), .arc-sidebar :global(textarea:focus-visible) { outline: 2px solid #c5bdf6; outline-offset: 2px; }
  .arc-sidebar :global(button:disabled) { opacity: .4; cursor: default; }
  .arc-sidebar :global(button:active:not(:disabled)) { filter: brightness(.9); }
  @media (prefers-reduced-motion: reduce) { .arc-sidebar, .arc-sidebar :global(*) { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
</style>
