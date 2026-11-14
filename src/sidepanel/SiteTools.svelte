<script lang="ts">
  // Editor for Air Traffic Control routes, Site Search shortcuts and Boosts.
  import { requestArc } from '../shared/messaging';
  import { containFocus } from '../shared/focus';
  import { hostOf } from '../shared/site-tools';
  import type { ArcState, Boost, SiteSearch } from '../shared/types';

  type Section = 'routes' | 'search' | 'boosts';
  let { arcState, activeUrl = '', onstate, onclose, notify }: {
    arcState: ArcState;
    activeUrl?: string;
    onstate: (state: ArcState) => void;
    onclose: () => void;
    notify: (message: string) => void;
  } = $props();

  let section = $state<Section>('routes');
  let error = $state('');
  const currentHost = $derived(hostOf(activeUrl));

  let routePattern = $state('');
  let routeSpaceId = $state('');

  let siteId = $state<string | undefined>();
  let siteName = $state('');
  let siteShortcut = $state('');
  let siteUrl = $state('');

  let boostId = $state<string | undefined>();
  let boostHost = $state('');
  let boostCss = $state('');

  const spaceLabel = (id: string) => {
    const space = arcState.spaces.find((entry) => entry.id === id);
    return space ? `${space.icon} ${space.name}` : 'Deleted Space';
  };

  async function send(message: { type: string; [key: string]: unknown }, done: string) {
    error = '';
    try {
      const response = await requestArc(message);
      if (response?.state) onstate(response.state);
      notify(done);
      return true;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not save. Try again.';
      return false;
    }
  }

  function show(next: Section) { section = next; error = ''; }

  async function saveRoute() {
    const spaceId = routeSpaceId || arcState.activeSpaceId;
    if (await send({ type: 'SAVE_ROUTING_RULE', pattern: routePattern, spaceId }, 'Route saved')) routePattern = '';
  }

  function editSite(site?: SiteSearch) {
    siteId = site?.id; siteName = site?.name || ''; siteShortcut = site?.shortcut || ''; siteUrl = site?.url || '';
    error = '';
  }
  async function saveSite() {
    if (await send({ type: 'SAVE_SITE_SEARCH', id: siteId, name: siteName, shortcut: siteShortcut, url: siteUrl }, 'Site Search saved')) editSite();
  }

  function editBoost(boost?: Boost) {
    boostId = boost?.id; boostHost = boost?.host || ''; boostCss = boost?.css || '';
    error = '';
  }
  async function saveBoost() {
    const enabled = arcState.boosts?.find((boost) => boost.id === boostId)?.enabled ?? true;
    if (await send({ type: 'SAVE_BOOST', id: boostId, host: boostHost, css: boostCss, enabled }, 'Boost saved')) editBoost();
  }
  const toggleBoost = (boost: Boost) =>
    send({ type: 'SAVE_BOOST', ...boost, enabled: !boost.enabled }, boost.enabled ? 'Boost turned off' : 'Boost turned on');
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="Site tools">
  <div class="card" use:containFocus>
    <div class="header">
      <h3>Site tools</h3>
      <button class="close" aria-label="Close site tools" onclick={onclose}>×</button>
    </div>

    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={section === 'routes'} onclick={() => show('routes')}>Routes</button>
      <button role="tab" aria-selected={section === 'search'} onclick={() => show('search')}>Site Search</button>
      <button role="tab" aria-selected={section === 'boosts'} onclick={() => show('boosts')}>Boosts</button>
    </div>

    {#if section === 'routes'}
      <p class="hint">Air Traffic Control. A link to a matching site, opened from a page or another app, lands in the Space you choose.</p>
      <div class="list">
        {#each arcState.routingRules || [] as rule (rule.id)}
          <div class="entry">
            <div><strong>{rule.pattern}</strong><small>opens in {spaceLabel(rule.spaceId)}</small></div>
            <button class="ghost" aria-label="Remove route for {rule.pattern}" onclick={() => send({ type: 'REMOVE_ROUTING_RULE', id: rule.id }, 'Route removed')}>Remove</button>
          </div>
        {:else}<p class="hint">No routes yet.</p>{/each}
      </div>
      <form onsubmit={(event) => { event.preventDefault(); saveRoute(); }}>
        <label for="route-pattern">Site</label>
        <div class="inline">
          <input id="route-pattern" placeholder="github.com or google.com/maps" bind:value={routePattern} autocomplete="off" spellcheck="false" data-autofocus />
          {#if currentHost && routePattern !== currentHost}<button type="button" class="ghost" onclick={() => routePattern = currentHost}>This site</button>{/if}
        </div>
        <label for="route-space">Open in</label>
        <select id="route-space" value={routeSpaceId || arcState.activeSpaceId} onchange={(event) => routeSpaceId = event.currentTarget.value}>
          {#each arcState.spaces as space (space.id)}<option value={space.id}>{space.icon} {space.name}</option>{/each}
        </select>
        <button class="primary" disabled={!routePattern.trim()}>Add route</button>
      </form>
    {:else if section === 'search'}
      <p class="hint">In the command bar, type a shortcut, a space, then your query: <kbd>yt lofi</kbd> searches YouTube.</p>
      <div class="list">
        {#each arcState.siteSearches || [] as site (site.id)}
          <div class="entry">
            <div><strong>{site.name} <kbd>{site.shortcut}</kbd></strong><small>{site.url}</small></div>
            <button class="ghost" aria-label="Edit {site.name}" onclick={() => editSite(site)}>Edit</button>
            <button class="ghost" aria-label="Remove {site.name}" onclick={() => send({ type: 'REMOVE_SITE_SEARCH', id: site.id }, 'Site Search removed')}>Remove</button>
          </div>
        {:else}<p class="hint">No site searches yet.</p>{/each}
      </div>
      <form onsubmit={(event) => { event.preventDefault(); saveSite(); }}>
        <div class="inline">
          <div class="grow"><label for="site-name">Name</label><input id="site-name" placeholder="MDN" bind:value={siteName} autocomplete="off" /></div>
          <div class="short"><label for="site-shortcut">Shortcut</label><input id="site-shortcut" placeholder="mdn" bind:value={siteShortcut} autocomplete="off" spellcheck="false" /></div>
        </div>
        <label for="site-url">Search URL, with %s for the query</label>
        <input id="site-url" placeholder="https://developer.mozilla.org/search?q=%s" bind:value={siteUrl} autocomplete="off" spellcheck="false" />
        <div class="inline">
          <button class="primary grow" disabled={!siteName.trim() || !siteShortcut.trim() || !siteUrl.trim()}>{siteId ? 'Save changes' : 'Add site search'}</button>
          {#if siteId}<button type="button" class="ghost" onclick={() => editSite()}>Cancel</button>{/if}
        </div>
      </form>
    {:else}
      <p class="hint">Your own CSS for a site, applied every time it loads. Subdomains are included.</p>
      <div class="list">
        {#each arcState.boosts || [] as boost (boost.id)}
          <div class="entry">
            <div><strong>{boost.host}</strong><small>{boost.enabled ? 'On' : 'Off'} · {boost.css.trim().split('\n').length} lines</small></div>
            <button class="ghost" aria-label="Turn {boost.enabled ? 'off' : 'on'} Boost for {boost.host}" aria-pressed={boost.enabled} onclick={() => toggleBoost(boost)}>{boost.enabled ? 'Turn off' : 'Turn on'}</button>
            <button class="ghost" aria-label="Edit Boost for {boost.host}" onclick={() => editBoost(boost)}>Edit</button>
            <button class="ghost" aria-label="Remove Boost for {boost.host}" onclick={() => send({ type: 'REMOVE_BOOST', id: boost.id }, 'Boost removed')}>Remove</button>
          </div>
        {:else}<p class="hint">No Boosts yet.</p>{/each}
      </div>
      <form onsubmit={(event) => { event.preventDefault(); saveBoost(); }}>
        <label for="boost-host">Site</label>
        <div class="inline">
          <input id="boost-host" placeholder="news.ycombinator.com" bind:value={boostHost} autocomplete="off" spellcheck="false" />
          {#if currentHost && boostHost !== currentHost}<button type="button" class="ghost" onclick={() => boostHost = currentHost}>This site</button>{/if}
        </div>
        <label for="boost-css">CSS</label>
        <textarea id="boost-css" rows="6" placeholder={'body { font-family: Georgia, serif; }\n.sidebar-ad { display: none; }'} bind:value={boostCss} spellcheck="false"></textarea>
        <div class="inline">
          <button class="primary grow" disabled={!boostHost.trim() || !boostCss.trim()}>{boostId ? 'Save changes' : 'Add Boost'}</button>
          {#if boostId}<button type="button" class="ghost" onclick={() => editBoost()}>Cancel</button>{/if}
        </div>
      </form>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</div>

<style>
  .overlay { position: absolute; inset: 0; background: rgba(8, 8, 16, 0.72); backdrop-filter: blur(8px); display: flex; align-items: flex-end; z-index: 50; }
  .card { width: 100%; max-height: 88%; overflow-y: auto; background: #292830; border-top: 1px solid rgba(255, 255, 255, 0.18); border-radius: 16px; margin: 8px; box-shadow: 0 16px 48px #0005; padding: 16px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
  .header { display: flex; align-items: center; justify-content: space-between; }
  .header h3 { font-size: 15px; font-weight: 600; }
  .close { background: rgba(255, 255, 255, 0.1); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; }
  .tabs { display: flex; gap: 4px; background: rgba(255, 255, 255, 0.07); border-radius: 9px; padding: 3px; }
  .tabs button { flex: 1; border: none; background: none; color: rgba(255, 255, 255, 0.7); font: inherit; font-size: 12px; font-weight: 600; padding: 6px 4px; border-radius: 7px; cursor: pointer; }
  .tabs button[aria-selected='true'] { background: rgba(255, 255, 255, 0.18); color: #fff; }
  .hint { font-size: 11.5px; color: rgba(255, 255, 255, 0.65); line-height: 1.4; }
  .error { font-size: 12px; color: #fda4af; }
  .list { max-height: 34dvh; overflow-y: auto; }
  .entry { display: flex; gap: 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid #ffffff20; }
  .entry > div { flex: 1; min-width: 0; }
  .entry strong, .entry small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .entry small { opacity: 0.65; margin-top: 3px; font-size: 10.5px; }
  form { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  label { color: rgba(255, 255, 255, 0.75); font-weight: 500; display: block; margin-bottom: 4px; }
  input, select, textarea { width: 100%; box-sizing: border-box; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 8px; padding: 7px 9px; color: #fff; font-size: 12.5px; font-family: inherit; }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; resize: vertical; }
  .inline { display: flex; gap: 6px; align-items: flex-end; }
  .inline > input, .grow { flex: 1; min-width: 0; }
  .short { width: 84px; }
  .primary { background: #d8d3fa; color: #252131; font-weight: 700; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; margin-top: 4px; }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .ghost { background: rgba(255, 255, 255, 0.1); border: none; color: #fff; border-radius: 7px; padding: 6px 8px; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
  .ghost:hover { background: rgba(255, 255, 255, 0.2); }
  kbd { font: inherit; font-size: 10.5px; background: rgba(255, 255, 255, 0.14); border-radius: 4px; padding: 1px 5px; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #d8d3fa; outline-offset: 1px; }
  @media (prefers-reduced-motion: no-preference) { .ghost, .tabs button { transition: background 0.12s; } }
</style>
