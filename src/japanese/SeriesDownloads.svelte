<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from './client';
  import {
    AUTO_FALLBACK,
    currentEpisodeDownloads,
    normalizeTeamOrder,
    planSeries,
    resolveEpisodeVariant,
    resolveSeriesTeam,
    type SeriesPlan
  } from './series';
  import { loadDubOrder, saveDubOrder } from './dub-order';
  import type { EpisodeDownloads } from './page-captions';
  import type { SeriesQueue } from '../background/series-downloads';

  const source = new URLSearchParams(location.search).get('series') || '';
  let { expanded = $bindable(!!source) }: { expanded?: boolean } = $props();
  let url = $state(source);
  let episode = $state<EpisodeDownloads | null>(null);
  let plan = $state<SeriesPlan>();
  /** This series' dubbing order, primary first; AUTO_FALLBACK last means "then any other". */
  let order = $state<string[]>([]);
  let savedOrder: string[] = [];
  let selectedPages = $state<string[]>([]);
  let queue = $state<SeriesQueue>();
  let status = $state('');
  let progress = $state<{ checked: number; total: number }>();
  let busy = $state(false);
  const ready = $derived(plan?.episodes.filter(episode => episode.video) || []);
  const activeTeams = $derived.by(() => {
    const teams: string[] = [];
    for (const ep of ready) {
      if (ep.team && !teams.includes(ep.team)) teams.push(ep.team);
    }
    return teams;
  });
  const summaryEdition = $derived(activeTeams.length ? activeTeams.join(' + ') : plan?.edition || '');
  /** Every dubbing the series has, with how many episodes each one covers. */
  const teamStats = $derived.by(() => {
    const stats = new Map<string, { team: string; total: number }>();
    for (const ep of plan?.episodes || []) {
      for (const variant of ep.variants || []) {
        const key = variant.team.toLowerCase();
        const entry = stats.get(key) || { team: variant.team, total: 0 };
        entry.total += 1;
        stats.set(key, entry);
      }
    }
    return [...stats.values()].sort((a, b) => b.total - a.total || a.team.localeCompare(b.team));
  });
  const isDubPlan = $derived(!!plan && plan.edition !== 'Japanese subtitles' && teamStats.length > 0);
  const namedOrder = $derived(order.filter(team => team !== AUTO_FALLBACK));
  const anyOther = $derived(order.includes(AUTO_FALLBACK));
  const addable = $derived(teamStats.filter(item => !namedOrder.some(team => team.toLowerCase() === item.team.toLowerCase())));
  const coverage = (team: string) => teamStats.find(item => item.team.toLowerCase() === team.toLowerCase())?.total || 0;
  const completed = $derived(queue?.files.filter(file => file.state === 'done').length || 0);
  const failed = $derived(queue?.files.filter(file => file.state === 'failed') || []);
  const activeFile = $derived(queue?.files.find(file => file.state === 'downloading'));
  const remaining = $derived(queue?.files.some(file => file.state === 'queued' || file.state === 'downloading') || false);
  const queueMatchesSeries = $derived.by(() => {
    const seriesId = (plan?.series || url).match(/\/catalog\/[^/]+-(\d+)(?:\/|[?#]|$)/)?.[1];
    return !seriesId || !!queue?.folder.match(new RegExp(` - ${seriesId}(?: - |$)`));
  });

  async function refresh() {
    try { queue = (await requestArc({ type: 'SERIES_DOWNLOAD_STATUS' })).queue; } catch { /* Wait for the next refresh. */ }
  }

  onMount(() => {
    void refresh();
    void loadDubOrder().then(saved => { savedOrder = saved; });
    if (source) void currentEpisodeDownloads(source).then(downloads => { episode = downloads; }).catch(() => {});
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  });

  function track(checked: number, total: number, partial?: SeriesPlan) {
    progress = { checked: Math.min(checked, total), total };
    status = checked < total ? `Checking episodes · ${checked} of ${total}` : 'Picking dubbing…';
    if (partial) plan = structuredClone(partial);
  }

  async function checkSeries(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    plan = undefined;
    selectedPages = [];
    status = 'Opening the series…';
    progress = undefined;
    try {
      savedOrder = await loadDubOrder();
      const loaded = await planSeries(url.trim(), track, { priorities: savedOrder });
      plan = loaded;
      order = normalizeTeamOrder([loaded.primaryTeam, ...savedOrder]);
      status = '';
    } catch (error) { status = error instanceof Error ? error.message : 'Could not check this series.'; }
    finally { busy = false; progress = undefined; }
  }

  function pruneSelected(nextPlan: SeriesPlan) {
    const available = new Set(nextPlan.episodes.filter(ep => ep.video).map(ep => ep.page));
    selectedPages = selectedPages.filter(page => available.has(page));
  }

  /** Change the dubbing order, remember it for every series, and re-pick each episode. */
  async function setOrder(next: string[]) {
    if (busy || !plan) return;
    order = normalizeTeamOrder(next);
    savedOrder = order;
    void saveDubOrder(order);
    const effective = order.length ? order : [AUTO_FALLBACK];
    busy = true;
    status = 'Picking dubbing…';
    try {
      const primaryTeam = effective[0] === AUTO_FALLBACK ? undefined : effective[0];
      const updated = await resolveSeriesTeam({ ...$state.snapshot(plan), primaryTeam }, effective, (checked, total) => {
        progress = { checked, total };
        status = `Loading other dubbing · ${checked} of ${total}`;
      });
      plan = updated;
      pruneSelected(updated);
      status = '';
    } catch (error) { status = error instanceof Error ? error.message : 'Could not load that dubbing.'; }
    finally { busy = false; progress = undefined; }
  }

  function move(index: number, by: number) {
    const next = [...namedOrder];
    const [team] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, team);
    void setOrder(anyOther ? [...next, AUTO_FALLBACK] : next);
  }

  function remove(index: number) {
    const next = namedOrder.filter((_, i) => i !== index);
    void setOrder(anyOther ? [...next, AUTO_FALLBACK] : next);
  }

  function add(team: string) {
    if (team) void setOrder([...namedOrder, team, ...(anyOther ? [AUTO_FALLBACK] : [])]);
  }

  async function changeEpisodeTeam(episodePage: string, team: string) {
    if (busy || !plan) return;
    busy = true;
    status = team ? 'Loading episode dubbing…' : '';
    try {
      const updated = await resolveEpisodeVariant($state.snapshot(plan), episodePage, team);
      plan = updated;
      pruneSelected(updated);
      status = '';
    } catch (error) { status = error instanceof Error ? error.message : 'Could not load episode dubbing.'; }
    finally { busy = false; }
  }

  async function start() {
    if (busy || !plan || !selectedPages.length) return;
    if (remaining && !queueMatchesSeries) return;
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

<details bind:open={expanded}>
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
  {#if busy && progress}<progress aria-label="Checking progress" max={progress.total} value={progress.checked}></progress>{/if}
  {#if plan}
    <p><strong>{summaryEdition}</strong> · {ready.length} of {plan.episodes.length} episodes available</p>
    {#if isDubPlan}
      <fieldset class="dub-order" disabled={busy}>
        <legend>Dubbing order</legend>
        <p class="hint">Each episode uses the first dubbing on this list that has it. The order is saved for every series.</p>
        {#if namedOrder.length}
          <ol aria-label="Dubbing order">
            {#each namedOrder as team, index (team)}
              <li>
                <span class="rank">{['Primary', 'Secondary', 'Third'][index] || `#${index + 1}`}</span>
                <span class="team">{team}</span>
                <span class="count">{coverage(team)}/{plan.episodes.length}</span>
                <button type="button" class="icon" aria-label={`Move ${team} up`} disabled={index === 0} onclick={() => move(index, -1)}>↑</button>
                <button type="button" class="icon" aria-label={`Move ${team} down`} disabled={index === namedOrder.length - 1} onclick={() => move(index, 1)}>↓</button>
                <button type="button" class="icon" aria-label={`Remove ${team}`} onclick={() => remove(index)}>×</button>
              </li>
            {/each}
          </ol>
        {/if}
        <div class="row">
          {#if addable.length}
            <select aria-label="Add a dubbing" value="" onchange={(e) => { add(e.currentTarget.value); e.currentTarget.value = ''; }}>
              <option value="">{namedOrder.length ? 'Add a fallback dubbing…' : 'Choose a dubbing…'}</option>
              {#each addable as option (option.team)}
                <option value={option.team}>{option.team} ({option.total}/{plan.episodes.length})</option>
              {/each}
            </select>
          {/if}
          <label class="any">
            <input type="checkbox" checked={anyOther} onchange={(e) => setOrder(e.currentTarget.checked ? [...namedOrder, AUTO_FALLBACK] : namedOrder)} />
            Then any other dubbing
          </label>
        </div>
      </fieldset>
    {/if}
    {#if ready.length}
      <div class="row">
        <button type="button" disabled={busy || selectedPages.length === ready.length} onclick={() => { selectedPages = ready.map(episode => episode.page); }}>Select all</button>
        <button type="button" disabled={busy || !selectedPages.length} onclick={() => { selectedPages = []; }}>Clear selection</button>
        <button type="button" disabled={busy || !selectedPages.length || (remaining && !queueMatchesSeries)} onclick={start}>
          {remaining && queueMatchesSeries ? 'Apply selection to queue' : selectedPages.length ? `Download ${selectedPages.length} ${selectedPages.length === 1 ? 'episode' : 'episodes'}` : 'Download selected'}
        </button>
      </div>
    {/if}
    <ul aria-label="Episode availability">
      {#each plan.episodes as episode (episode.page)}
        <li>
          {#if episode.video}
            <div class="ep-row">
              <label>
                <input type="checkbox" bind:group={selectedPages} value={episode.page} disabled={busy} />
                {episode.label} · {episode.video.height ? `${episode.video.height}p` : 'Video'}{episode.team ? ` · ${episode.team}` : ''}{episode.subtitle ? ' + Japanese subtitles' : ''}
              </label>
              {#if episode.variants && episode.variants.length > 1}
                <select class="ep-team" aria-label={`Dubbing for ${episode.label}`} value={episode.team || ''} disabled={busy} onchange={(e) => changeEpisodeTeam(episode.page, e.currentTarget.value)}>
                  {#each episode.variants as variant (variant.page)}
                    <option value={variant.team}>{variant.team}</option>
                  {/each}
                </select>
              {/if}
            </div>
          {:else if episode.variants?.length}
            <div class="ep-row">
              <span>{episode.label} · Unavailable</span>
              <select class="ep-team" aria-label={`Dubbing for ${episode.label}`} value="" disabled={busy} onchange={(e) => changeEpisodeTeam(episode.page, e.currentTarget.value)}>
                <option value="">Choose dubbing…</option>
                {#each episode.variants as variant (variant.page)}
                  <option value={variant.team}>{variant.team}</option>
                {/each}
              </select>
            </div>
          {:else}
            <span>{episode.label} · {busy ? 'Checking…' : 'Unavailable'}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if queue && (queueMatchesSeries || remaining)}
    {#if !queueMatchesSeries}<p>Another series has an active download queue. Finish or stop it to download this series.</p>{/if}
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
  details { padding: 15px 16px; background: var(--surface, #171719); border: 1px solid var(--line, #2f2d2d); border-radius: 10px; overflow-wrap: anywhere; }
  summary { cursor: pointer; font-weight: 650; }
  form { margin-top: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .dub-order { margin: 8px 0; padding: 10px 12px; border: 1px solid #ffffff1f; border-radius: 8px; }
  .dub-order legend { padding: 0 4px; font-weight: 600; }
  .dub-order .hint { margin: 0 0 8px; opacity: .7; font-size: .9em; }
  .dub-order ol { list-style: none; margin: 0 0 8px; padding: 0; max-height: none; }
  .dub-order li { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .dub-order .rank { min-width: 72px; font-size: .8em; opacity: .65; text-transform: uppercase; letter-spacing: .03em; }
  .dub-order .team { flex: 1; min-width: 0; }
  .dub-order .count { font-size: .85em; opacity: .7; font-variant-numeric: tabular-nums; }
  .dub-order .icon { padding: 1px 7px; line-height: 1.3; }
  .dub-order .any { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .dub-order .row { align-items: center; }
  progress { width: 100%; height: 6px; margin: 2px 0 8px; accent-color: var(--accent, #ff8248); }
  .ep-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .episode { margin-top: 12px; gap: 16px; }
  a { color: var(--accent, #ff8248); }
  input[type='url'] { flex: 1; min-width: 180px; }
  input, button, select { font: inherit; color: inherit; background: #201f22; padding: 6px 9px; border: 1px solid #ffffff2e; border-radius: 6px; }
  select.ep-team { padding: 2px 6px; max-width: 170px; font-size: 0.9em; }
  button { cursor: pointer; }
  button:disabled, select:disabled { cursor: default; opacity: .45; }
  :is(a, summary, input, button, select):focus-visible { outline: 2px solid var(--accent, #ff8248); outline-offset: 2px; }
  ul { max-height: 150px; overflow: auto; margin-bottom: 8px; }
  ul[aria-label='Episode availability'] { list-style: none; padding: 0; }
  li label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
  li span { display: block; padding: 4px 0; }
  input[type='checkbox'] { margin: 0; }
</style>
