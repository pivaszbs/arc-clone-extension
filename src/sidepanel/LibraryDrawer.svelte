<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from '../shared/messaging';
  import { cleanUrl } from '../shared/arc-sync';
  import type { EaselDocument } from '../shared/easels';
  import type { ArcState, CapturedImage } from '../shared/types';

  interface Props {
    arcState: ArcState;
    notify: (message: string) => void;
    onstate: (state: ArcState) => void;
    onclose: () => void;
    onOpenBoosts?: () => void;
  }

  let { arcState, notify, onstate, onclose, onOpenBoosts }: Props = $props();

  type LibraryTab = 'archive' | 'easels' | 'boosts' | 'captures' | 'downloads';
  let activeTab = $state<LibraryTab>('archive');
  let query = $state('');
  let easels = $state<EaselDocument[]>([]);
  let captures = $state<CapturedImage[]>([]);
  let downloads = $state<{ id: number; filename: string; url: string; state?: string }[]>([]);

  let filteredArchive = $derived(
    (arcState.archive || []).filter((e) =>
      `${e.title} ${e.url}`.toLowerCase().includes(query.toLowerCase())
    )
  );
  let filteredEasels = $derived(
    easels.filter((e) => e.title.toLowerCase().includes(query.toLowerCase()))
  );
  let filteredBoosts = $derived(
    (arcState.boosts || []).filter((b) =>
      `${b.name || ''} ${b.host}`.toLowerCase().includes(query.toLowerCase())
    )
  );
  let filteredCaptures = $derived(
    captures.filter((c) =>
      `${c.title} ${c.pageUrl}`.toLowerCase().includes(query.toLowerCase())
    )
  );
  let filteredDownloads = $derived(
    downloads.filter((d) =>
      `${d.filename} ${d.url}`.toLowerCase().includes(query.toLowerCase())
    )
  );

  async function loadLibrary() {
    try {
      const res = await requestArc({ type: 'GET_LIBRARY_DATA' });
      easels = Array.isArray(res?.easels) ? res.easels : [];
      captures = Array.isArray(res?.captures) ? res.captures : [];
      downloads = Array.isArray(res?.downloads) ? res.downloads : [];
    } catch {
      // ignore
    }
  }

  async function restoreArchive(archiveId: string) {
    try {
      const res = await requestArc({ type: 'RESTORE_ARCHIVED_TAB', archiveId });
      if (res?.state) onstate(res.state);
      notify('Tab restored');
    } catch {
      notify('Could not restore tab');
    }
  }

  async function newEasel() {
    const res = await requestArc({ type: 'SAVE_EASEL', title: `Easel ${easels.length + 1}` });
    if (Array.isArray(res?.easels)) easels = res.easels;
    if (res?.easel?.id) await requestArc({ type: 'OPEN_EASEL', id: res.easel.id });
  }

  async function openEasel(id: string) {
    await requestArc({ type: 'OPEN_EASEL', id });
  }

  async function deleteEasel(id: string) {
    const res = await requestArc({ type: 'DELETE_EASEL', id });
    if (Array.isArray(res?.easels)) easels = res.easels;
  }

  async function deleteCapture(id: string) {
    const res = await requestArc({ type: 'DELETE_CAPTURE', id });
    if (Array.isArray(res?.captures)) captures = res.captures;
  }

  async function toggleBoost(boostId: string) {
    const boost = (arcState.boosts || []).find((b) => b.id === boostId);
    if (!boost) return;
    const res = await requestArc({
      type: 'SAVE_BOOST',
      ...boost,
      enabled: !boost.enabled
    });
    if (res?.state) onstate(res.state);
  }

  onMount(() => {
    void loadLibrary();
  });
</script>

<div class="drawer-overlay" role="dialog" aria-modal="true" aria-label="Arc Library">
  <div class="drawer-card library-card">
    <div class="drawer-header">
      <h3>Arc Library</h3>
      <button class="close-drawer" aria-label="Close Library" onclick={onclose}>×</button>
    </div>

    <div class="lib-tabs" role="tablist">
      {#each [
        ['archive', 'Archive'],
        ['easels', 'Easels'],
        ['boosts', 'Boosts'],
        ['captures', 'Captures'],
        ['downloads', 'Downloads']
      ] as [key, label]}
        <button
          role="tab"
          aria-selected={activeTab === key}
          class="lib-tab {activeTab === key ? 'active' : ''}"
          onclick={() => (activeTab = key as LibraryTab)}
        >
          {label}
        </button>
      {/each}
    </div>

    <input placeholder="Filter {activeTab}..." bind:value={query} />

    <div class="lib-scroll">
      {#if activeTab === 'archive'}
        {#each filteredArchive as entry (entry.id)}
          <div class="lib-row">
            <div class="lib-meta">
              <strong>{entry.title}</strong>
              <small>{cleanUrl(entry.url)}</small>
            </div>
            <button class="primary-btn" onclick={() => restoreArchive(entry.id)}>Restore</button>
          </div>
        {:else}
          <p class="drawer-hint">No archived tabs yet.</p>
        {/each}

      {:else if activeTab === 'easels'}
        <div class="lib-actions">
          <button class="primary-btn" onclick={newEasel}>+ New Easel</button>
        </div>
        {#each filteredEasels as easel (easel.id)}
          <div class="lib-row">
            <div class="lib-meta">
              <strong>{easel.title}</strong>
              <small>{easel.items.length} item(s) · {new Date(easel.updatedAt).toLocaleDateString()}</small>
            </div>
            <button class="primary-btn" onclick={() => openEasel(easel.id)}>Open</button>
            <button class="mini-danger" aria-label="Delete {easel.title}" onclick={() => deleteEasel(easel.id)}>×</button>
          </div>
        {:else}
          <p class="drawer-hint">Create a freeform board for images, diagrams, and live link cards.</p>
        {/each}

      {:else if activeTab === 'boosts'}
        <div class="lib-actions">
          <button class="primary-btn" onclick={() => { onclose(); onOpenBoosts?.(); }}>Open Boost Editor</button>
        </div>
        {#each filteredBoosts as boost (boost.id)}
          <div class="lib-row">
            <div class="lib-meta">
              <strong>{boost.name || boost.host}</strong>
              <small>{boost.host}{boost.zappedSelectors?.length ? ` · ${boost.zappedSelectors.length} zapped` : ''}</small>
            </div>
            <button class="primary-btn" onclick={() => toggleBoost(boost.id)}>
              {boost.enabled ? 'On' : 'Off'}
            </button>
          </div>
        {:else}
          <p class="drawer-hint">No Boosts saved yet.</p>
        {/each}

      {:else if activeTab === 'captures'}
        <div class="lib-actions">
          <button class="primary-btn" onclick={() => requestArc({ type: 'START_CAPTURE_MODE' })}>Capture Area on Active Tab</button>
        </div>
        <div class="capture-grid">
          {#each filteredCaptures as cap (cap.id)}
            <div class="capture-card">
              <img src={cap.dataUrl} alt={cap.title} />
              <div class="capture-footer">
                <span>{cap.title}</span>
                <button class="mini-danger" onclick={() => deleteCapture(cap.id)}>×</button>
              </div>
            </div>
          {:else}
            <p class="drawer-hint">No captured screenshots yet.</p>
          {/each}
        </div>

      {:else if activeTab === 'downloads'}
        {#each filteredDownloads as dl (dl.id)}
          <div class="lib-row">
            <div class="lib-meta">
              <strong>{dl.filename.split('/').pop() || dl.url}</strong>
              <small>{dl.state || 'complete'}</small>
            </div>
            <button class="primary-btn" onclick={() => chrome.downloads?.show(dl.id)}>Show</button>
          </div>
        {:else}
          <p class="drawer-hint">No recent Chrome downloads.</p>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .library-card { width: min(94vw, 390px); max-height: 84vh; display: flex; flex-direction: column; gap: 10px; }
  .lib-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .lib-tab { flex: 1; background: #ffffff14; color: #fff; border: none; border-radius: 7px; padding: 6px 8px; font-size: 11px; cursor: pointer; }
  .lib-tab.active { background: #6366f1; font-weight: 600; }
  .lib-scroll { overflow-y: auto; max-height: 55vh; display: flex; flex-direction: column; gap: 8px; }
  .lib-actions { display: flex; gap: 6px; }
  .lib-row { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 8px; background: #ffffff10; }
  .lib-meta { flex: 1; min-width: 0; }
  .lib-meta strong, .lib-meta small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lib-meta small { opacity: 0.7; font-size: 10px; }
  .mini-danger { background: #ef444433; color: #fca5a5; border: none; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  .capture-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .capture-card { background: #ffffff10; border-radius: 8px; overflow: hidden; }
  .capture-card img { width: 100%; height: 90px; object-fit: cover; display: block; }
  .capture-footer { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; font-size: 11px; }
  .capture-footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
