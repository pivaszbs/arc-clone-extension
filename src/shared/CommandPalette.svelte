<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { containFocus } from './focus';
  import { getFaviconUrl, parseCommandBarInput, type OmniboxResultItem } from './types';

  let { onexecute, onclose, initialQuery = '', label = 'Search', previewLabel = 'Peek', embedded = false }: {
    onexecute: (item: OmniboxResultItem, preview: boolean) => void | Promise<void>;
    onclose: () => void;
    initialQuery?: string;
    label?: string;
    previewLabel?: string;
    embedded?: boolean;
  } = $props();
  const uid = $props.id();
  let query = $state(untrack(() => initialQuery));
  let items = $state<OmniboxResultItem[]>([]);
  let selected = $state(-1);
  let loading = $state(true);
  let error = $state('');
  let executing = $state(false);
  let input: HTMLInputElement;
  let list: HTMLDivElement;
  let version = 0;
  let pending: Promise<void> = Promise.resolve();

  onMount(() => {
    input.focus();
    if (initialQuery) input.select();
    return () => { version++; };
  });

  async function search(value: string) {
    const request = ++version;
    loading = true;
    error = '';
    items = [];
    selected = -1;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SEARCH_OMNIBOX', query: value });
      if (request !== version) return;
      if (response?.error) throw new Error(response.error);
      items = response?.items || [];
      selected = value.trim() && items.length ? 0 : -1;
    } catch {
      if (request !== version) return;
      error = 'Search is unavailable. Try again.';
    } finally {
      if (request === version) loading = false;
    }
  }

  $effect(() => { pending = search(query); });
  $effect(() => {
    const index = selected;
    void tick().then(() => list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }));
  });

  async function execute(item: OmniboxResultItem, preview = false) {
    if (executing) return;
    executing = true;
    try {
      await onexecute(item, preview);
    } catch {
      error = 'Could not open this item. Try again.';
    } finally {
      executing = false;
    }
  }

  async function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); onclose(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      selected = event.key === 'ArrowDown' ? (selected + 1) % items.length
        : selected <= 0 ? items.length - 1 : selected - 1;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const value = query;
      // Enter waits for the current query, never a result left over from an older query.
      await pending;
      if (query !== value || executing) return;
      const chosen = items[selected] || (value.trim() ? items[0] : undefined);
      if (chosen) await execute(chosen, event.shiftKey || event.altKey);
      else if (value.trim() && !error) {
        const parsed = parseCommandBarInput(value);
        await execute({ id: 'input', kind: 'search', title: value, subtitle: '', url: parsed.url }, event.shiftKey || event.altKey);
      }
    }
  }
</script>

<div class="palette" class:embedded use:containFocus={!embedded} role="dialog" aria-modal={!embedded} aria-label={label} tabindex="-1">
  <div class="search-row">
    <span class="search-icon"><Icon name="search" size={19} /></span>
    <input bind:this={input} bind:value={query} onkeydown={keydown} data-autofocus
      role="combobox" aria-label="Search tabs, commands, or enter a URL" aria-autocomplete="list"
      aria-expanded="true" aria-controls="{uid}-results" aria-activedescendant={selected >= 0 ? `${uid}-result-${selected}` : undefined}
      placeholder="Search or enter URL" autocomplete="off" spellcheck="false" />
    {#if loading}<span class="spinner" aria-label="Searching"></span>{/if}
    <button class="dismiss" aria-label="Close search" onclick={onclose}><kbd>esc</kbd></button>
  </div>
  <div class="results" bind:this={list} id="{uid}-results" role="listbox" aria-label="Search results" aria-busy={loading}>
    {#if error}
      <div class="status" role="status"><span>{error}</span><button onclick={() => { pending = search(query); }}>Retry</button></div>
    {:else if loading}
      <div class="status" role="status">Searching…</div>
    {:else if !items.length}
      <div class="status" role="status">Search your tabs, bookmarks, and history.</div>
    {:else}
      {#if !query.trim()}<div class="section-label">Tabs & suggestions</div>{/if}
      {#each items as item, index (item.id)}
        <div class="result" class:selected={selected === index} role="option" aria-selected={selected === index}
          id="{uid}-result-{index}" data-index={index} tabindex="-1"
          onpointermove={() => selected = index}
          onmousedown={(event) => event.preventDefault()}
          onclick={(event) => execute(item, event.shiftKey || event.altKey)}
          onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void execute(item); } }}>
          <span class="item-icon">
            {#if getFaviconUrl(item.url, item.favIconUrl)}
              <img src={getFaviconUrl(item.url, item.favIconUrl)} alt="" onerror={(event) => (event.currentTarget as HTMLImageElement).style.visibility = 'hidden'} />
            {:else}<Icon name={item.kind === 'action' ? 'command' : 'globe'} size={17} />{/if}
          </span>
          <span class="item-text"><span class="title">{item.title}</span><span class="subtitle">{item.subtitle}</span></span>
          <span class="kind">{selected === index ? '↵' : item.shortcut || ''}</span>
        </div>
      {/each}
    {/if}
  </div>
  <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open <span class="preview-hint">· <kbd>⇧↵</kbd> {previewLabel}</span></span></footer>
</div>

<style>
  .palette { container-type: inline-size; width: min(600px, 100%); min-width: 0; margin: 0 auto; display: flex; flex-direction: column; max-height: min(540px, 80dvh); overflow: hidden; border: 1px solid #ffffff24; border-radius: 16px; background: #25252bef; backdrop-filter: blur(36px); color: #f7f7fa; box-shadow: 0 24px 80px #0006, 0 4px 16px #0004; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; text-align: left; animation: appear 140ms ease-out; }
  .palette * { box-sizing: border-box; }
  .search-row { display: flex; align-items: center; gap: 12px; padding: 18px; border-bottom: 1px solid #ffffff12; }
  .search-icon { color: #b2b2bf; display: flex; }
  input { flex: 1; min-width: 0; padding: 0; margin: 0; background: none; border: 0; outline: 0; color: inherit; font: inherit; font-size: 18px; letter-spacing: -.3px; }
  input::placeholder { color: #aaaab7; }
  .palette input:focus-visible { outline: none !important; }
  kbd { font-family: inherit; font-size: 10px; line-height: 16px; color: #b4b4c0; border: 1px solid #ffffff15; border-radius: 4px; padding: 0 4px; }
  .results { overflow-y: auto; overscroll-behavior: contain; min-height: 64px; padding: 6px; scrollbar-width: thin; scrollbar-color: #ffffff24 transparent; }
  .section-label { padding: 7px 10px; font-size: 11px; font-weight: 500; color: #a7a7b6; }
  .result { display: flex; align-items: center; gap: 11px; min-height: 52px; padding: 9px 10px; border-radius: 9px; cursor: pointer; }
  .selected { background: #ffffff12; }
  .item-icon { display: flex; justify-content: center; align-items: center; width: 28px; height: 28px; border-radius: 7px; background: #ffffff08; color: #b9b9ca; flex-shrink: 0; }
  img { width: 18px; height: 18px; border-radius: 4px; object-fit: contain; }
  .item-text { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 3px; }
  .title, .subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { font-size: 13px; font-weight: 500; letter-spacing: -.1px; }
  .subtitle { font-size: 11px; color: #a9a9b9; }
  .kind { font-size: 10px; color: #b2b2c2; flex-shrink: 0; max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  footer { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 16px; border-top: 1px solid #ffffff10; color: #a9a9b8; font-size: 10px; }
  footer > span { display: flex; gap: 4px; align-items: center; }
  .status { min-height: 70px; padding: 22px 12px; font-size: 12px; color: #b9b9c7; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  button { border: 1px solid #ffffff24; border-radius: 6px; padding: 5px 9px; color: #efeff5; font: inherit; background: #ffffff10; cursor: pointer; }
  button:focus-visible { outline: 2px solid #bcb4fa; outline-offset: 2px; }
  .dismiss { flex-shrink: 0; padding: 2px; background: none; border: 0; }
  .dismiss:hover kbd { color: #fff; background: #ffffff14; }
  .spinner { width: 14px; height: 14px; border: 1.5px solid #ffffff20; border-top-color: #c9c9d7; border-radius: 50%; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes appear { from { opacity: 0; transform: translateY(-3px) scale(.99); } to { opacity: 1; transform: none; } }
  @container (max-width: 400px) { .search-row { padding: 14px; gap: 9px; } input { font-size: 15px; } .preview-hint { display: none; } .kind { max-width: 46px; } }
  @media (prefers-reduced-motion: reduce) { .palette, .spinner { animation: none; } }
</style>
