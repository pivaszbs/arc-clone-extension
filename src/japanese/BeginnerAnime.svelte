<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from './client';
  import list from '../../shared/study/beginner-anime.json';
  import { describePace, levelOf, type BeginnerSeries } from './beginner-anime';
  import { isKnown, type WordCard } from './word-cards';

  let { onDownload }: { onDownload: (url: string) => void } = $props();
  const series = list.series as BeginnerSeries[];
  let known = $state<Set<string> | null>(null);

  onMount(() => {
    // Progress is optional here: without it the list still shows how hard each series is.
    void requestArc({ type: 'JAPANESE_LIST' }).then(response => {
      known = new Set((response.words as WordCard[] || []).filter(isKnown).map(word => word.id));
    }).catch(() => {});
  });
</script>

<div class="library-header">
  <h2 id="beginner-title">Beginner anime</h2>
</div>
<p>The {series.length} easiest of the {list.ranked} series on smotret-anime with Japanese subtitles, easiest first. Each was measured from the Japanese subtitles of its first {list.sampleEpisodes} episodes: how fast people talk, how many different words you need, and how many of them are everyday words.</p>
<ol class="beginner-list">
  {#each series as item, index (item.id)}
    {@const level = levelOf(index, list.ranked)}
    {@const knownCount = known ? item.topWords.filter(id => known!.has(id)).length : null}
    <li class="beginner-card">
      {#if item.poster}<img class="beginner-poster" src={item.poster} alt="" loading="lazy" />{:else}<span class="beginner-poster"></span>{/if}
      <div class="beginner-body">
        <p class="beginner-level" data-level={level.key}>{index + 1}. {level.label}</p>
        <h3>{item.title}</h3>
        {#if item.titleJa || item.titleEn}<p class="beginner-alt">{[item.titleEn, item.titleJa].filter(Boolean).join(' · ')}</p>{/if}
        <ul class="beginner-facts">
          <li>{describePace(item.wordsPerMinute)} · {item.wordsPerMinute} words a minute while talking</li>
          <li>{item.wordsFor90} different words cover 90% of an episode’s dialogue</li>
          {#if knownCount !== null}<li>You know {knownCount} of its 50 most frequent words</li>{/if}
          <li>{item.japaneseEpisodes} {item.japaneseEpisodes === 1 ? 'episode' : 'episodes'} with Japanese subtitles{item.year ? ` · ${item.year}` : ''}</li>
        </ul>
        {#if item.genres.length}<p class="beginner-genres">{item.genres.join(' · ')}</p>{/if}
        <div class="beginner-actions">
          {#if item.firstEpisode}<a class="beginner-watch" href={item.firstEpisode} target="_blank" rel="noopener noreferrer">Watch episode 1</a>{/if}
          <button type="button" onclick={() => onDownload(item.url)}>Download series</button>
        </div>
      </div>
    </li>
  {/each}
</ol>
<p class="beginner-note">Ranked {list.generated}. Openings and endings are left out of the measurements. Names and rare words count against a series. A low rank does not mean a series is good for children: check the genres.</p>

<style>
  .beginner-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
  .beginner-card { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: #ffffff05; }
  .beginner-poster { width: 96px; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px; background: #ffffff10; }
  .beginner-body { display: grid; align-content: start; gap: 4px; min-width: 0; }
  .beginner-body h3 { margin: 0; font-size: 16px; line-height: 1.25; overflow-wrap: anywhere; }
  .beginner-body p { margin: 0; }
  .beginner-level { font-size: 12px; font-weight: 600; color: var(--accent) !important; }
  .beginner-level[data-level='next'] { color: #e6c46a !important; }
  .beginner-level[data-level='later'] { color: var(--muted) !important; }
  .beginner-alt, .beginner-genres { font-size: 12px !important; overflow-wrap: anywhere; }
  .beginner-facts { margin: 2px 0; padding-left: 16px; font-size: 13px; }
  .beginner-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .beginner-watch { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 6px; background: var(--accent); color: #21130c; font-size: 13px; font-weight: 600; text-decoration: none; }
  .beginner-note { font-size: 12px !important; }
  @media (max-width: 480px) {
    .beginner-card { grid-template-columns: 72px minmax(0, 1fr); }
    .beginner-poster { width: 72px; }
  }
</style>
