import { useEffect, useMemo, useState } from 'react';
import { animeCore, type Cue, type OpEdIntervals, type SkipRanges } from 'react-native-anime-core';

import { readText, type Episode } from './library';

export type SkipPart = 'recap' | 'op' | 'ed';
export const skipLabels: Record<SkipPart, string> = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };

type Loaded = { key: string; body: string; cues: Cue[]; japanese: boolean; references: Cue[][] };

/**
 * Loads the episode's subtitles and works out where its opening, ending and recap are.
 * Parsing, theme detection and range merging all run in the shared C++ core.
 */
export function useEpisodeStudy(episode: Episode | undefined, neighbours: Episode[], duration: number) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (!episode) return;
    (async () => {
      const body = episode.subtitleUri ? await readText(episode.subtitleUri).catch(() => '') : '';
      const cues = body ? animeCore.parseSubtitles(body) : [];
      // Other episodes' lyrics find themes that move around between episodes.
      const references: Cue[][] = [];
      for (const other of neighbours) {
        if (!other.subtitleUri || other.key === episode.key) continue;
        const text = await readText(other.subtitleUri).catch(() => '');
        if (text) references.push(animeCore.parseSubtitles(text));
      }
      if (!cancelled) setLoaded({ key: episode.key, body, cues, japanese: animeCore.isJapanese(cues, false), references });
    })();
    return () => { cancelled = true; };
  }, [episode, neighbours]);

  const ready = loaded && loaded.key === episode?.key ? loaded : null;

  const subtitles: OpEdIntervals = useMemo(
    () => (ready && ready.cues.length ? animeCore.detectOpEd(ready.body, ready.cues, duration, ready.references) : {}),
    [ready, duration],
  );

  const skips: SkipRanges = useMemo(
    () => (episode ? animeCore.resolveSkipRanges(episode.frames, subtitles, 0) : {}),
    [episode, subtitles],
  );

  return { cues: ready?.cues ?? [], japanese: ready?.japanese ?? false, loading: !!episode && !ready, subtitles, skips };
}
