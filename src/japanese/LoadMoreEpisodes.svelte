<script lang="ts">
  import { onDestroy } from 'svelte';
  import { requestArc } from './client';
  import { checkSeriesUpdates } from './series-updates';
  import { resolveEpisodeVariant, type SeriesEpisode, type SeriesPlan } from './series';

  let { id, folder, credit, downloaded, translationId, connected }: {
    id: string;
    folder: string;
    credit: string;
    downloaded: ReadonlySet<number>;
    translationId?: string;
    connected: boolean;
  } = $props();

  let busy = $state(false);
  let status = $state('');
  let plan = $state.raw<SeriesPlan>();
  let choices = $state<Record<string, string>>({});
  const missing = $derived(plan ? missingEpisodes(plan.episodes) : []);
  const needsDub = $derived(missing.filter(episode => !episode.video && episode.variants?.length));
  const canDownload = $derived(missing.some(episode => episode.video || choices[episode.page]));
  let disposed = false;
  onDestroy(() => { disposed = true; });

  function missingEpisodes(episodes: SeriesEpisode[]) {
    return episodes.filter((_, index) => !downloaded.has(index + 1));
  }

  async function queueDownloads(loaded: SeriesPlan) {
    if (disposed) return;
    const selectedPages = missingEpisodes(loaded.episodes).filter(episode => episode.video).map(episode => episode.page);
    if (!selectedPages.length) {
      plan = undefined;
      status = 'The selected episodes are already in your library.';
      return;
    }
    await requestArc({ type: 'SERIES_DOWNLOAD_ADD', plan: loaded, selectedPages, folder });
    plan = undefined;
    status = connected
      ? 'Episodes will appear here when their downloads finish.'
      : 'Connect your download folder in Gallery to see new episodes here.';
  }

  async function loadMore() {
    if (busy) return;
    busy = true;
    plan = undefined;
    choices = {};
    status = 'Checking Smotret Anime…';
    try {
      if (!await chrome.permissions.request({ permissions: ['downloads'] })) {
        status = 'Allow downloads to load more episodes.';
        return;
      }
      const loaded = await checkSeriesUpdates(id, credit, downloaded, translationId, (checked, total) => {
        if (total) status = `Checking episodes · ${Math.min(checked, total)} of ${total}`;
      });
      if (disposed) return;
      // The connected folder can refresh while the catalog is loading.
      const pending = missingEpisodes(loaded.episodes);
      if (pending.some(episode => !episode.video && episode.variants?.length)) {
        plan = loaded;
        status = '';
      } else if (pending.some(episode => episode.video)) {
        await queueDownloads(loaded);
      } else {
        status = pending.length
          ? 'Episodes are listed, but downloads are unavailable for this edition.'
          : 'No new episodes on Smotret Anime.';
      }
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not check for new episodes.';
    } finally {
      busy = false;
    }
  }

  async function downloadSelected() {
    if (busy || !plan || !canDownload) return;
    busy = true;
    status = 'Loading dubbing…';
    try {
      let loaded = structuredClone(plan);
      for (const episode of needsDub) {
        const team = choices[episode.page];
        if (!team) continue;
        loaded = await resolveEpisodeVariant(loaded, episode.page, team);
        if (!loaded.episodes.find(item => item.page === episode.page)?.video) {
          status = `${team} is unavailable for ${episode.label}. Pick another dubbing or skip it.`;
          return;
        }
      }
      await queueDownloads(loaded);
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not queue the new episodes.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="load-more">
  {#if plan}
    <fieldset disabled={busy}>
      <legend>Choose dubbing for new episodes</legend>
      {#each needsDub as episode (episode.page)}
        <label>
          Episode {plan.episodes.indexOf(episode) + 1}
          <select bind:value={choices[episode.page]}>
            <option value="">Skip episode</option>
            {#each episode.variants ?? [] as variant (variant.page)}
              <option value={variant.team}>{variant.team}</option>
            {/each}
          </select>
        </label>
      {/each}
      <div class="actions">
        <button type="button" disabled={!canDownload} onclick={downloadSelected}>Download episodes</button>
        <button type="button" onclick={() => { plan = undefined; status = ''; }}>Cancel</button>
      </div>
    </fieldset>
  {:else}
    <button class="load-button" type="button" disabled={busy} onclick={loadMore}>Load more</button>
  {/if}
  <p role="status">{status}</p>
</div>

<style>
  .load-more { display: grid; gap: 8px; border-top: 1px solid var(--line); padding: 12px 16px; }
  .load-more p { margin: 0; color: var(--muted); font-size: 12px; }
  .load-more p:empty { display: none; }
  fieldset { display: grid; gap: 8px; border: 0; margin: 0; min-width: 0; padding: 0; }
  legend { padding: 0 0 8px; font-weight: 620; }
  label { display: grid; gap: 4px; font-size: 13px; }
  select, button { min-width: 0; border: 1px solid var(--line); border-radius: 6px; color: inherit; background: var(--surface); font: inherit; padding: 6px 9px; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .55; }
  .load-button { width: 100%; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
