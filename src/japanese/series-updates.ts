import { loadDubOrder } from './dub-order';
import { planSeries, resolveSeriesTeam, seriesRoot, type PlanProgress } from './series';

const anime365 = 'https://smotret-anime.com';

async function catalogPath(resource: string) {
  const response = await fetch(`${anime365}/api/${resource}?fields=url`, {
    cache: 'no-cache',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Could not find the series on Smotret Anime.');
  const { data } = await response.json();
  // The API can return the site's canonical domain. Use the supported download host.
  return new URL(data.url).pathname;
}

export async function checkSeriesUpdates(id: string, credit: string, downloaded: ReadonlySet<number>, translationId: string | undefined, onProgress: PlanProgress) {
  const [path, translation] = await Promise.all([
    catalogPath(`series/${id}`),
    translationId ? catalogPath(`translations/${translationId}`).catch(() => '') : ''
  ]);
  const series = seriesRoot(new URL(path, anime365).href);
  if (!series.pathname.endsWith(`-${id}`)) throw new Error('Smotret Anime returned a different series.');

  const category = translation.startsWith(series.pathname + '/')
    ? translation.match(/\/([\w-]+)-\d+\/?$/)?.[1]
    : undefined;
  const plan = await planSeries(series.href, onProgress, {
    update: { downloaded, category: category || (credit ? 'ozvuchka' : 'yaponskie-subtitry') }
  });
  const isDub = !category ? !!credit : category.endsWith('ozvuchka');
  if (!isDub) return plan;
  const teams = plan.episodes.flatMap(episode => episode.variants?.map(variant => variant.team) || []);
  const key = (name: string) => name.replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 60).toLowerCase();
  plan.primaryTeam = teams.find(team => team.toLowerCase() === credit.toLowerCase())
    ?? teams.find(team => credit && key(team) === key(credit));
  for (const episode of plan.episodes) {
    // The site redirects the generic dub page to its default, even when we haven't picked a dub.
    if (episode.team?.toLowerCase() === plan.primaryTeam?.toLowerCase() && plan.primaryTeam) continue;
    delete episode.video;
    delete episode.subtitle;
    delete episode.team;
  }
  return resolveSeriesTeam(plan, await loadDubOrder(), (checked, total) => onProgress(checked, total));
}
