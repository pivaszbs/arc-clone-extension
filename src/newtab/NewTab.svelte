<script lang="ts">
  import { onMount } from 'svelte';
  import CommandPalette from '../shared/CommandPalette.svelte';
  import Icon from '../shared/Icon.svelte';
  import { getSpaceFavorites, getTodayTabs } from '../shared/tabs';
  import {
    type ArcState,
    type FavoriteItem,
    type OmniboxResultItem,
    type Space,
    type TabInfo,
    SPACE_THEMES,
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
  let activeSpace = $derived<Space>(
    arcState.spaces.find((s) => s.id === arcState.activeSpaceId) || arcState.spaces[0]
  );

  let spaceFavorites = $derived<FavoriteItem[]>(getSpaceFavorites(arcState, activeSpace?.id));
  let showAddFavForm = $state(false);
  let customFavUrl = $state('');
  let customFavTitle = $state('');

  async function addCustomSpaceFavorite() {
    const raw = customFavUrl.trim();
    if (!raw) return;
    const parsed = parseCommandBarInput(raw);
    const url = parsed.isUrl ? parsed.url : `https://${raw}`;
    await chrome.runtime.sendMessage({
      type: 'ADD_FAVORITE',
      spaceId: activeSpace?.id,
      title: customFavTitle.trim() || raw,
      url
    });
    customFavUrl = '';
    customFavTitle = '';
    showAddFavForm = false;
    await refresh();
  }

  let currentTheme = $derived(SPACE_THEMES[activeSpace?.theme || 'indigo'] || SPACE_THEMES.indigo);

  let spaceTabs = $derived<TabInfo[]>(getTodayTabs(arcState, tabs, activeSpace?.id));

  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' });
      if (res?.state) {
        arcState = res.state;
        tabs = res.tabs || [];
      }
    } catch {
      // ignore
    }
  }

  onMount(() => {
    // Fallback if opened directly via chrome://newtab without ?focused=1
    if (!window.location.search.includes('focused=1')) {
      window.location.replace(chrome.runtime.getURL('newtab.html?focused=1'));
      return;
    }

    refresh();

    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'ARC_STATE_UPDATED') {
        refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  });

  async function closeSelfIfTemporary() {
    try {
      const current = await chrome.tabs.getCurrent();
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      if (current?.id && allTabs.length > 1) {
        await chrome.tabs.remove(current.id);
      }
    } catch {
      // ignore
    }
  }

  async function navigateCurrentTab(url: string) {
    if (!url) return;
    try {
      const current = await chrome.tabs.getCurrent();
      if (current?.id) {
        await chrome.tabs.update(current.id, { url });
        return;
      }
    } catch {
      // fallback to background message
    }
    await chrome.runtime.sendMessage({ type: 'NAVIGATE_CURRENT_TAB', url });
  }

  async function openSavedUrl(url: string, spaceId = arcState.activeSpaceId) {
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_OR_SWITCH_URL', url, spaceId });
    if (response?.ok) await closeSelfIfTemporary();
  }

  async function toggleFolder(folderId: string) {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_FOLDER', spaceId: activeSpace.id, folderId });
    await refresh();
  }

  async function executeItem(item: OmniboxResultItem, inLittleArc = false) {
    if (item.kind === 'tab' && typeof item.tabId === 'number' && !inLittleArc) {
      const current = await chrome.tabs.getCurrent();
      if (item.spaceId) {
        await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SPACE', spaceId: item.spaceId });
      }
      await chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId: item.tabId });
      if (current?.id && current.id !== item.tabId) {
        await chrome.tabs.remove(current.id);
      }
      return;
    }

    if (item.kind === 'action' && item.actionId) {
      if (item.actionId.startsWith('ANTIGRAVITY_PROMPT:') || item.actionId === 'SEND_PAGE_TO_ANTIGRAVITY') {
        const prompt = item.actionId.startsWith('ANTIGRAVITY_PROMPT:')
          ? item.actionId.slice('ANTIGRAVITY_PROMPT:'.length).trim()
          : '';
        if (prompt) {
          try {
            await navigator.clipboard.writeText(prompt);
          } catch {
            // ignore
          }
        }
        const a = document.createElement('a');
        a.href = 'antigravity://';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          closeSelfIfTemporary();
        }, 180);
        return;
      }

      await chrome.runtime.sendMessage({
        type: 'EXECUTE_OMNIBOX_ACTION',
        actionId: item.actionId
      });
      await refresh();
      return;
    }

    if (item.url) {
      if (inLittleArc) {
        await chrome.runtime.sendMessage({ type: 'OPEN_LITTLE_ARC', url: item.url });
        await closeSelfIfTemporary();
      } else if (item.kind === 'pinned' || item.kind === 'favorite') {
        await openSavedUrl(item.url, item.spaceId);
      } else {
        await navigateCurrentTab(item.url);
      }
    }
  }

</script>

<div class="arc-newtab-layout" style="background: {currentTheme.gradient};">
  <!-- Left Pinned Arc Sidebar -->
  <aside class="left-sidebar">
    <div class="ls-header">
      <span class="space-badge">{activeSpace?.icon} {activeSpace?.name}</span>
    </div>

    <!-- Space-Specific Top Pins / Favorites Grid -->
    <div class="favs-grid">
      {#each spaceFavorites as fav (fav.id)}
        <div
          class="fav-tile"
          role="button"
          tabindex="0"
          onclick={() => openSavedUrl(fav.url)}
          onkeydown={(e) => e.key === 'Enter' && openSavedUrl(fav.url)}
          title="{fav.title} ({fav.url})"
        >
          {#if getFaviconUrl(fav.url, fav.favIconUrl)}
            <img src={getFaviconUrl(fav.url, fav.favIconUrl)} alt={fav.title} />
          {:else}
            <span>{fav.title.slice(0, 1).toUpperCase()}</span>
          {/if}
          <button
            class="fav-remove"
            onclick={async (e) => {
              e.stopPropagation();
              await chrome.runtime.sendMessage({
                type: 'REMOVE_FAVORITE',
                spaceId: activeSpace?.id,
                favoriteId: fav.id
              });
              refresh();
            }}
            title="Remove {fav.title}"
            aria-label="Remove {fav.title}"
          >
            ×
          </button>
        </div>
      {/each}
      <button
        class="fav-tile fav-add"
        onclick={() => (showAddFavForm = !showAddFavForm)}
        title="Add custom top pin to {activeSpace?.name}"
        aria-label="Add custom top pin"
      >
        ＋
      </button>
    </div>

    {#if showAddFavForm}
      <div class="custom-pin-box">
        <input
          type="text"
          placeholder="URL (e.g. figma.com, github.com)..."
          bind:value={customFavUrl}
          onkeydown={(e) => {
            if (e.key === 'Enter') addCustomSpaceFavorite();
            if (e.key === 'Escape') showAddFavForm = false;
          }}
        />
        <div style="display: flex; gap: 5px;">
          <input
            type="text"
            placeholder="Title (optional)"
            bind:value={customFavTitle}
            onkeydown={(e) => {
              if (e.key === 'Enter') addCustomSpaceFavorite();
            }}
          />
          <button onclick={addCustomSpaceFavorite}>Add</button>
        </div>
      </div>
    {/if}

    <div class="ls-scroll">
      {#if activeSpace?.pinnedItems?.length}
        <div class="section-label">Pinned</div>
        {#each activeSpace.pinnedItems as item (item.id)}
          {#if item.type === 'folder'}
            <button class="ls-row folder" aria-expanded={!item.collapsed} onclick={() => toggleFolder(item.id)}>
              <span>{item.collapsed ? '▸' : '▾'}</span>
              <span class="ls-title">{item.title}</span>
            </button>
            {#if !item.collapsed}
            {#each item.children as child (child.id)}
              <button
                class="ls-row child"
                onclick={() => openSavedUrl(child.url)}
              >
                {#if getFaviconUrl(child.url, child.favIconUrl)}
                  <img src={getFaviconUrl(child.url, child.favIconUrl)} alt="" />
                {:else}
                  <span><Icon name="globe" /></span>
                {/if}
                <span class="ls-title">{child.title}</span>
              </button>
            {/each}
            {/if}
          {:else}
            <button
              class="ls-row"
              onclick={() => openSavedUrl(item.url)}
            >
              {#if getFaviconUrl(item.url, item.favIconUrl)}
                <img src={getFaviconUrl(item.url, item.favIconUrl)} alt="" />
              {:else}
                <span><Icon name="globe" /></span>
              {/if}
              <span class="ls-title">{item.title}</span>
            </button>
          {/if}
        {/each}
      {/if}

      <div class="section-label">Today · {spaceTabs.length}</div>
      {#each spaceTabs as tab (tab.id)}
        <button
          class="ls-row {tab.active ? 'active' : ''}"
          onclick={async () => {
            const current = await chrome.tabs.getCurrent();
            await chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId: tab.id });
            if (current?.id && current.id !== tab.id) {
              await chrome.tabs.remove(current.id);
            }
          }}
        >
          {#if getFaviconUrl(tab.url, tab.favIconUrl)}
            <img src={getFaviconUrl(tab.url, tab.favIconUrl)} alt="" />
          {:else}
            <span><Icon name="globe" /></span>
          {/if}
          <span class="ls-title">{tab.title}</span>
        </button>
      {/each}
    </div>

    <div class="ls-footer">
      {#each arcState.spaces as sp (sp.id)}
        <button
          class="space-pill {sp.id === activeSpace?.id ? 'active' : ''}"
          onclick={async () => {
            await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SPACE', spaceId: sp.id });
            refresh();
          }}
          title={sp.name} aria-label={sp.name} aria-pressed={sp.id === activeSpace?.id}
        >
          {sp.icon}
        </button>
      {/each}
    </div>
  </aside>

  <main class="center-stage">
    <div class="search-stage">
      <CommandPalette embedded onexecute={executeItem} onclose={closeSelfIfTemporary} previewLabel="Little Arc" />
      <p class="newtab-hint">Search tabs, bookmarks, and the web.</p>
    </div>
  </main>
</div>

<style>
  .arc-newtab-layout {
    display: flex;
    width: 100vw;
    height: 100dvh;
    overflow: hidden;
    transition: background 0.35s ease;
  }

  .left-sidebar {
    width: 244px;
    flex-shrink: 0;
    height: 100%;
    background: rgba(20, 20, 28, 0.12);
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(20px);
    padding: 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ls-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 6px;
  }

  .space-badge {
    font-size: 14px;
    font-weight: 600;
    color: #fff;
  }

  .favs-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 7px;
  }

  .fav-tile {
    position: relative;
    height: 44px;
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.12s ease;
  }

  .fav-tile:hover {
    background: rgba(255, 255, 255, 0.18);
    transform: translateY(-1px);
  }

  .fav-tile img {
    width: 22px;
    height: 22px;
    border-radius: 5px;
  }

  .fav-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: none;
    background: rgba(15, 14, 24, 0.85);
    color: #fff;
    font-size: 11px;
    line-height: 1;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .fav-tile:hover .fav-remove {
    display: flex;
  }

  .fav-remove:hover {
    background: #ef4444;
  }

  .fav-add {
    border: 1px dashed rgba(255, 255, 255, 0.28);
    background: rgba(255, 255, 255, 0.04);
    font-size: 16px;
  }

  .custom-pin-box {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(12, 12, 24, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }

  .custom-pin-box input {
    width: 100%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    padding: 5px 8px;
    color: #fff;
    font-size: 12px;
    outline: none;
  }

  .custom-pin-box button {
    background: #8b7cf8;
    border: none;
    border-radius: 6px;
    padding: 5px 10px;
    color: #0e0e18;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
  }

  .ls-scroll {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    
    letter-spacing: .1px;
    color: rgba(255, 255, 255, 0.5);
    padding: 8px 6px 4px;
  }

  .ls-row {
    width: 100%;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.85);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 9px;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .ls-row:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .ls-row.active {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
    font-weight: 600;
  }

  .ls-row.child {
    padding-left: 24px;
  }

  .ls-row img {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .ls-title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ls-footer {
    display: flex;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
  }

  .space-pill {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.09);
    color: #fff;
    font-size: 15px;
    cursor: pointer;
  }

  .space-pill.active {
    background: rgba(255, 255, 255, 0.24);
    border-color: #fff;
  }

  /* Center Command Bar */
  .center-stage {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 13vh;
  }

  .search-stage { width: min(600px, 90%); }
  .newtab-hint { text-align: center; color: #ffffff5c; font-size: 12px; margin-top: 22px; letter-spacing: .1px; }
  @media (max-width: 700px) { .left-sidebar { display: none; } .center-stage { padding-top: 12vh; } }
  .arc-newtab-layout :global(button:focus-visible) { outline: 2px solid #c5bdf6; outline-offset: 2px; }
  .ls-scroll { min-height: 0; overscroll-behavior: contain; }
  .ls-row { min-height: 36px; }
  @media (prefers-reduced-motion: reduce) { .arc-newtab-layout, .arc-newtab-layout :global(*) { animation: none !important; transition: none !important; } }
</style>
