<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ago, clock, episodeLabel, fetchServerStatus, seriesLabel, type ServerStatus } from '../../shared/sync/server-status';
  import { tvServerBaseUrl } from './tv-sync';

  /** The Mac library server at a glance (status.json), the same summary as the phone's Server tab. */
  let { visible = true }: { visible?: boolean } = $props();

  const POLL_MS = 10_000;
  let summary = $state<ServerStatus | null>(null);
  let health = $state<'loading' | 'online' | 'old' | 'offline'>('loading');
  let error = $state('');
  let checkedAt = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    clearTimeout(timer);
    try {
      const next = await fetchServerStatus(tvServerBaseUrl());
      summary = next;
      health = next ? 'online' : 'old';
      error = '';
    } catch (cause) {
      health = 'offline';
      error = cause instanceof Error ? cause.message : String(cause);
    }
    checkedAt = Date.now();
    if (visible) timer = setTimeout(refresh, POLL_MS);
  }

  $effect(() => {
    if (visible) void refresh();
    else clearTimeout(timer);
  });
  onDestroy(() => clearTimeout(timer));

  const missing = $derived(summary ? summary.library.perSeries.filter(item => item.withTimings < item.episodes) : []);
  const working = $derived(summary ? summary.workers.nodes.filter(node => node.status === 'working') : []);
</script>

<div class="pipeline-card mac-card" aria-label="Mac server">
  <div class="pipeline-head">
    <strong>Mac server</strong>
    <span class="mac-health" data-state={health}>
      <span class="dot" aria-hidden="true"></span>
      {health === 'online' ? 'Online' : health === 'old' ? 'Update npm run mac:up' : health === 'offline' ? 'Not answering' : 'Checking…'}
    </span>
  </div>

  {#if health === 'offline'}
    <small>{tvServerBaseUrl()} — {error || 'no answer'}. Is <code>npm run mac:up</code> running?</small>
  {:else if health === 'old'}
    <small>This Mac server has no status.json yet. Restart it with the current code.</small>
  {:else if summary}
    <div class="mac-grid">
      <div>
        <span class="num">{summary.library.series}</span>
        <small>series · {summary.library.episodes} episodes</small>
      </div>
      <div>
        <span class="num">{summary.library.withTimings}/{summary.library.episodes}</span>
        <small>with skip timings</small>
      </div>
      <div>
        <span class="num">{summary.workers.counts.pending ?? 0}</span>
        <small>tasks waiting{summary.workers.quarantinedEpisodes.length ? ` · ${summary.workers.quarantinedEpisodes.length} stuck` : ''}</small>
      </div>
      <div>
        <span class="num">{summary.liveConnections}</span>
        <small>live connections</small>
      </div>
    </div>

    {#each working as node (node.nodeId)}
      <small>
        <strong>{node.nodeName}</strong> · {seriesLabel(node.currentSeries)} {episodeLabel(node.currentEpisode)}
        {#if typeof node.progress === 'number'} · {node.progress}%{/if}
      </small>
      {#if typeof node.progress === 'number'}<progress max="100" value={node.progress}></progress>{/if}
    {:else}
      <small>Workers: {summary.workers.nodes.length ? summary.workers.nodes.map(node => `${node.nodeName} (${node.status})`).join(', ') : 'none connected'}</small>
    {/each}

    {#if summary.tv.active}
      <small>TV: {summary.tv.seriesLabel} {summary.tv.episodeLabel}{summary.tv.paused ? ' · paused' : ''}{summary.tv.position ? ` · ${clock(summary.tv.position)}` : ''}</small>
    {/if}

    {#if missing.length}
      <small>Without timings: {missing.map(item => `${seriesLabel(item.folder)} (${item.episodes - item.withTimings})`).join(', ')}</small>
    {/if}

    {#each summary.workers.quarantinedEpisodes.slice(0, 3) as item (item.seriesName + item.episode)}
      <small class="stuck">Stuck: {seriesLabel(item.seriesName)} {episodeLabel(item.episode)} — {item.error || `${item.attempts} attempts`}</small>
    {/each}

    {#if summary.devices.length}
      <small>Synced: {summary.devices.slice(0, 5).map(device => `${device.kind} ${ago(device.secondsAgo)}`).join(' · ')}</small>
    {/if}
    <small class="addresses">
      {summary.addresses.join(' · ')}{summary.tailscale.running ? ` · Tailscale ${summary.tailscale.name ?? ''}` : ' · Tailscale off'}
      {#if checkedAt} · checked {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}{/if}
    </small>
  {/if}
</div>

<style>
  /* Same look as the other cards on the Pipelines screen (their styles are scoped to OfflineStudy). */
  .pipeline-card {
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.03);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pipeline-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .pipeline-card progress { width: 100%; height: 6px; accent-color: #ff6a2b; }
  .pipeline-card small { font-size: 12px; opacity: 0.75; }
  .mac-card { grid-column: 1 / -1; }
  .mac-health { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.4); }
  .mac-health[data-state='online'] .dot { background: #34d399; }
  .mac-health[data-state='old'] .dot { background: #fbbf24; }
  .mac-health[data-state='offline'] .dot { background: #f87171; }
  .mac-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .mac-grid div { display: flex; flex-direction: column; }
  .num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stuck { color: #f87171; }
  .addresses { overflow-wrap: anywhere; }
</style>
