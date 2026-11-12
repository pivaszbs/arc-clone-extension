<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from './client';
  import { currentEpisodeDownloads, planSeries, type SeriesPlan } from './series';
  import type { EpisodeDownloads } from './page-captions';
  import type { SeriesQueue } from '../background/series-downloads';

  const source = new URLSearchParams(location.search).get('series') || '';
  let url = $state(source);
  let episode = $state<EpisodeDownloads | null>(null);
  let plan = $state<SeriesPlan>();
  let selectedPages = $state<string[]>([]);
  let queue = $state<SeriesQueue>();
  let status = $state('');
  let busy = $state(false);
  const ready = $derived(plan?.episodes.filter(episode => episode.video) || []);
  const completed = $derived(queue?.files.filter(file => file.state === 'done').length || 0);
  const failed = $derived(queue?.files.filter(file => file.state === 'failed') || []);
  const activeFile = $derived(queue?.files.find(file => file.state === 'downloading'));
  const remaining = $derived(queue?.files.some(file => file.state === 'queued' || file.state === 'downloading') || false);

  async function refresh() {
    try { queue = (await requestArc({ type: 'SERIES_DOWNLOAD_STATUS' })).queue; } catch { /* Wait for the next refresh. */ }
  }

  onMount(() => {
    void refresh();
    if (source) void currentEpisodeDownloads(source).then(downloads => { episode = downloads; }).catch(() => {});
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  });

  async function checkSeries(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    plan = undefined;
    selectedPages = [];
    status = 'Checking episodes…';
    try {
      plan = await planSeries(url.trim(), (checked, total) => { status = `Checked ${checked} of ${total} episodes`; });
      status = '';
    } catch (error) { status = error instanceof Error ? error.message : 'Could not check this series.'; }
    finally { busy = false; }
  }

  async function start() {
    if (busy || !plan || !selectedPages.length) return;
    const type = remaining ? 'SERIES_DOWNLOAD_APPLY' : 'SERIES_DOWNLOAD_START';
    const selection = [...selectedPages];
    busy = true;
    status = '';
    try {
      const allowed = await chrome.permissions.request({ permissions: ['downloads'] });
      if (!allowed) { status = 'Allow Chrome downloads to save the series.'; return; }
      queue = (await requestArc({
        type,
        plan: $state.snapshot(plan),
        selectedPages: selection
      })).queue;
    } catch (error) { status = error instanceof Error ? error.message : 'Could not start the queue.'; }
    finally { busy = false; }
  }

  async function control(action: 'PAUSE' | 'RESUME' | 'RETRY' | 'STOP') {
    if (busy) return;
    busy = true;
    try { queue = (await requestArc({ type: `SERIES_DOWNLOAD_${action}` })).queue; }
    catch (error) { status = error instanceof Error ? error.message : 'Could not update the queue.'; }
    finally { busy = false; }
  }
</script>

<details open={!!url}>
  <summary>Download a series</summary>
  {#if source === url && episode?.video}
    <div class="row episode">
      <a href={episode.video.url} download target="_blank" rel="noopener">{episode.video.height ? `Download this episode · ${episode.video.height}p` : 'Download this episode'}</a>
      {#if episode.subtitle}<a href={episode.subtitle} download target="_blank" rel="noopener">Download subtitles</a>{/if}
    </div>
  {/if}
  <form onsubmit={checkSeries}>
    <label for="series-url">Anime365 series or episode link</label>
    <div class="row">
      <input id="series-url" type="url" bind:value={url} required />
      <button disabled={busy}>Check episodes</button>
    </div>
  </form>
  {#if status}<p role="status">{status}</p>{/if}
  {#if plan}
    <p><strong>{plan.edition}</strong> · {ready.length} of {plan.episodes.length} episodes available</p>
    {#if ready.length}
      <div class="row">
        <button type="button" disabled={busy || selectedPages.length === ready.length} onclick={() => { selectedPages = ready.map(episode => episode.page); }}>Select all</button>
        <button type="button" disabled={busy || !selectedPages.length} onclick={() => { selectedPages = []; }}>Clear selection</button>
        <button type="button" disabled={busy || !selectedPages.length} onclick={start}>
          {remaining ? 'Apply selection to queue' : selectedPages.length ? `Download ${selectedPages.length} ${selectedPages.length === 1 ? 'episode' : 'episodes'}` : 'Download selected'}
        </button>
      </div>
    {/if}
    <ul aria-label="Episode availability">
      {#each plan.episodes as episode (episode.page)}
        <li>
          {#if episode.video}
            <label>
              <input type="checkbox" bind:group={selectedPages} value={episode.page} disabled={busy} />
              {episode.label} · {episode.video.height ? `${episode.video.height}p` : 'Video'}{episode.subtitle ? ' + Japanese subtitles' : ''}
            </label>
          {:else}
            <span>{episode.label} · Unavailable</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if queue}
    <p><strong>{queue.title}</strong> · {completed} / {queue.files.length} files saved{remaining && queue.paused ? ' · Paused' : ''}</p>
    <p>Downloads / {queue.folder}</p>
    {#if activeFile}<p>Downloading {activeFile.filename.split('/').at(-1)}</p>{/if}
    {#if remaining}
      <div class="row">
        <button type="button" disabled={busy} onclick={() => control(queue?.paused ? 'RESUME' : 'PAUSE')}>{queue.paused ? 'Resume queue' : 'Pause after current file'}</button>
        <button type="button" disabled={busy} onclick={() => control('STOP')}>Stop queue</button>
      </div>
    {/if}
    {#if failed.length}
      <button type="button" disabled={busy} onclick={() => control('RETRY')}>Retry failed files</button>
      <ul aria-label="Failed downloads">{#each failed as file}<li>{file.filename.split('/').at(-1)} · {file.error}</li>{/each}</ul>
    {/if}
  {/if}
</details>

<style>
  details { margin: 16px 0; padding: 12px 16px; background: #22212b; border-radius: 12px; max-width: 720px; }
  summary { cursor: pointer; font-weight: 600; }
  form { margin-top: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .episode { margin-top: 12px; gap: 16px; }
  a { color: #decaff; }
  input[type='url'] { flex: 1; min-width: 180px; }
  input, button { font: inherit; padding: 6px 9px; border: 1px solid #ffffff2e; border-radius: 6px; }
  ul { max-height: 150px; overflow: auto; margin-bottom: 8px; }
  ul[aria-label='Episode availability'] { list-style: none; padding: 0; }
  li label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
  li span { display: block; padding: 4px 0; }
  input[type='checkbox'] { margin: 0; }
</style>
