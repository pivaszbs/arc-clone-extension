// Movies & TV on the phone: search, seasons, episodes and torrent streams; a stream plays on the TV.
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  continueLabel,
  episodeCode,
  metaPath,
  nextPath,
  playPath,
  saveJobLabel,
  searchPath,
  seasonName,
  seasonsOf,
  streamLabel,
  streamsPath,
  type HistoryEntry,
  type SaveJob,
  type SeriesMeta,
  type StreamOption,
  type StremioEpisode,
  type StremioType,
  type TitleCard,
} from '../../../shared/tv-stremio';
import { haptics } from '../lib/haptics';
import { fetchStremio, postStremio, type TvStream } from '../lib/tv-remote';
import { colors, radius, space, type } from '../theme';
import { Button } from './ui';

type Screen =
  | { kind: 'seasons'; card: TitleCard; meta?: SeriesMeta }
  | { kind: 'episodes'; card: TitleCard; meta: SeriesMeta; season: number }
  | { kind: 'streams'; card: TitleCard; episode?: StremioEpisode; streams?: StreamOption[] };

type Props = {
  serverUrl: string;
  /** Play the picked stream on the TV. */
  onPlay: (stream: TvStream) => void;
};

export function MoviesBrowser({ serverUrl, onPlay }: Props) {
  const [kind, setKind] = useState<StremioType>('movie');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TitleCard[]>([]);
  const [stack, setStack] = useState<Screen[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const view = stack[stack.length - 1];
  /** Continue watching and the Mac's saving queue, refreshed while the start screen shows. */
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [jobs, setJobs] = useState<SaveJob[]>([]);
  const [notice, setNotice] = useState('');

  const refreshMac = async () => {
    try {
      const [h, d] = await Promise.all([
        fetchStremio<{ continue?: HistoryEntry[] }>(serverUrl, 'stremio/history.json'),
        fetchStremio<{ jobs?: SaveJob[] }>(serverUrl, 'stremio/downloads.json'),
      ]);
      setHistory(h.continue || []);
      setJobs(d.jobs || []);
    } catch { /* Keep what is shown. */ }
  };
  const busy = jobs.some(job => job.state === 'queued' || job.state === 'downloading' || job.state === 'converting');
  useEffect(() => {
    const first = setTimeout(() => void refreshMac(), 0);
    const timer = setInterval(() => void refreshMac(), busy ? 3000 : 15000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [serverUrl, busy, stack.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Continue watching: resume it, or after a finished episode, the next one. */
  const resume = async (entry: HistoryEntry) => {
    haptics.select();
    if (!(entry.finished && entry.type === 'series')) {
      onPlay({ id: entry.id, title: entry.title, label: entry.label, path: entry.path, poster: entry.poster, bingeGroup: entry.bingeGroup });
      return;
    }
    setNotice('Finding the next episode…');
    try {
      const next = await fetchStremio<{ episode?: StremioEpisode; stream?: StreamOption }>(serverUrl, nextPath(entry.id, entry.bingeGroup));
      if (!next.episode || !next.stream) { setNotice(next.episode ? 'No stream found for the next episode.' : 'That was the last episode.'); return; }
      setNotice('');
      onPlay({
        id: next.episode.id, title: entry.title, label: `${episodeCode(next.episode)} · ${next.episode.name}`,
        path: playPath(next.stream), poster: entry.poster, bingeGroup: next.stream.bingeGroup || entry.bingeGroup,
      });
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  /** Save a stream into the Mac library: it then plays offline, on the phone too. */
  const saveStream = async (stream: StreamOption) => {
    if (view?.kind !== 'streams') return;
    haptics.select();
    const { card, episode } = view;
    const item = episode
      ? { type: 'series', id: episode.id, showId: card.id, name: card.name, year: card.year, poster: card.poster,
          season: episode.season, episode: episode.episode, episodeName: episode.name }
      : { type: 'movie', id: card.id, name: card.name, year: card.year, poster: card.poster };
    try {
      await postStremio(serverUrl, 'stremio/save', { stream, item });
      setNotice(`Saving ${episode ? `${card.name} ${episodeCode(episode)}` : card.name} to the Mac library. It appears in Library when it's done.`);
      void refreshMac();
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  const saveSeason = async (card: TitleCard, season: number) => {
    haptics.select();
    try {
      const body = await postStremio<{ episodes: number }>(serverUrl, 'stremio/save-season', {
        showId: card.id, season, name: card.name, year: card.year, poster: card.poster,
      });
      setNotice(`Saving ${body.episodes} episodes of ${card.name} ${seasonName(season)} to the Mac library.`);
      setTimeout(() => void refreshMac(), 4000);
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  const jobAction = async (job: SaveJob, action: 'cancel' | 'retry') => {
    haptics.select();
    try { await postStremio(serverUrl, `stremio/downloads/${action}`, { id: job.id }); } catch { /* refreshed below */ }
    void refreshMac();
  };

  const search = async (nextKind = kind, nextQuery = query) => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const body = await fetchStremio<{ results?: TitleCard[] }>(serverUrl, searchPath(nextKind, nextQuery));
      if (id === request.current) setResults(body.results || []);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  // Popular titles when the browser first shows (and when the Mac address changes).
  useEffect(() => {
    const first = setTimeout(() => void search(), 0);
    return () => clearTimeout(first);
  }, [serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Opens a screen and loads what it needs (a series' episodes, or a title's streams). */
  const push = (next: Screen) => {
    haptics.select();
    setError('');
    setStack(items => [...items, next]);
    if (next.kind === 'episodes') return;
    const id = ++request.current;
    setLoading(true);
    const replace = (loaded: Screen) => setStack(items => (items[items.length - 1] === next ? [...items.slice(0, -1), loaded] : items));
    void (async () => {
      try {
        if (next.kind === 'seasons') {
          const meta = await fetchStremio<SeriesMeta>(serverUrl, metaPath('series', next.card.id));
          if (id === request.current) replace({ ...next, meta });
        } else {
          const body = await fetchStremio<{ streams?: StreamOption[] }>(serverUrl, streamsPath(next.card.type, next.episode?.id || next.card.id));
          if (id === request.current) replace({ ...next, streams: body.streams || [] });
        }
      } catch (e) {
        if (id === request.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === request.current) setLoading(false);
      }
    })();
  };
  const back = () => { haptics.select(); ++request.current; setLoading(false); setError(''); setStack(items => items.slice(0, -1)); };

  const play = (stream: StreamOption) => {
    if (view?.kind !== 'streams') return;
    haptics.select();
    const label = view.episode ? `${episodeCode(view.episode)} · ${view.episode.name}` : view.card.name;
    onPlay({ id: view.episode?.id || view.card.id, title: view.card.name, label, path: playPath(stream), poster: view.card.poster, bingeGroup: stream.bingeGroup });
  };

  const title = !view ? null
    : view.kind === 'seasons' ? view.card.name
      : view.kind === 'episodes' ? `${view.card.name} · ${seasonName(view.season)}`
        : view.episode ? `${view.card.name} · ${episodeCode(view.episode)}` : view.card.name;

  return (
    <View style={styles.root}>
      {view ? (
        <Pressable accessibilityRole="button" onPress={back} style={styles.backRow} hitSlop={8}>
          <SymbolView name="chevron.left" size={14} tintColor={colors.accent} />
          <Text style={styles.backText} numberOfLines={1}>{title}</Text>
        </Pressable>
      ) : (
        <>
          <View style={styles.searchRow}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => void search()}
              placeholder={kind === 'movie' ? 'Search movies' : 'Search series'}
              placeholderTextColor={colors.textTertiary}
              returnKeyType="search"
              autoCorrect={false}
              style={styles.input}
            />
            <Button title="Search" onPress={() => void search()} />
          </View>
          <View style={styles.segments}>
            {(['movie', 'series'] as const).map(item => (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected: kind === item }}
                onPress={() => { haptics.select(); setKind(item); void search(item); }}
                style={[styles.segment, kind === item && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, kind === item && styles.segmentTextActive]}>{item === 'movie' ? 'Movies' : 'Series'}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {!!error && <Text style={styles.error}>{error}</Text>}
      {!!notice && <Text style={type.subhead}>{notice}</Text>}

      {!view && !query.trim() && history.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text style={type.section}>Continue watching</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
            {history.slice(0, 12).map(entry => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityLabel={`Continue ${entry.title}, ${continueLabel(entry)}, on the TV`}
                onPress={() => void resume(entry)}
                style={({ pressed }) => [styles.continueCard, pressed && styles.pressed]}
              >
                {entry.poster ? <Image source={{ uri: entry.poster }} style={styles.poster} resizeMode="cover" /> : <View style={styles.poster} />}
                {!!entry.duration && !entry.finished && (
                  <View style={styles.continueTrack}><View style={[styles.continueFill, { width: `${Math.min(100, (entry.position / entry.duration) * 100)}%` }]} /></View>
                )}
                <Text style={styles.cardName} numberOfLines={1}>{entry.title}</Text>
                <Text style={type.caption} numberOfLines={1}>{continueLabel(entry)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {!view && jobs.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text style={type.section}>Saving to the Mac library</Text>
          {jobs.slice(0, 8).map(job => {
            const label = saveJobLabel(job);
            const active = job.state === 'queued' || job.state === 'downloading' || job.state === 'converting';
            return (
              <View key={job.id} style={styles.row}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={type.body} numberOfLines={1}>{label.name}</Text>
                  <Text style={[type.caption, job.state === 'failed' && { color: '#f87171' }]} numberOfLines={2}>{label.state}</Text>
                </View>
                {job.state === 'failed' && <Button title="Retry" variant="plain" onPress={() => void jobAction(job, 'retry')} />}
                {(active || job.state === 'failed') && <Button title={active ? 'Cancel' : 'Remove'} variant="plain" onPress={() => void jobAction(job, 'cancel')} />}
                {job.state === 'done' && <SymbolView name="checkmark.circle.fill" size={18} tintColor="#34d399" />}
              </View>
            );
          })}
        </View>
      )}
      {loading && <ActivityIndicator color={colors.accent} style={{ marginVertical: space.m }} />}

      {!view && !loading && (
        <View style={styles.grid}>
          {results.map(card => (
            <Pressable
              key={card.id}
              accessibilityRole="button"
              accessibilityLabel={`${card.name} ${card.year}`}
              onPress={() => push(card.type === 'series' ? { kind: 'seasons', card } : { kind: 'streams', card })}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              {card.poster ? <Image source={{ uri: card.poster }} style={styles.poster} resizeMode="cover" /> : <View style={styles.poster} />}
              <Text style={styles.cardName} numberOfLines={2}>{card.name}</Text>
              {!!card.year && <Text style={type.caption}>{card.year}</Text>}
            </Pressable>
          ))}
          {!results.length && !error && <Text style={type.subhead}>Nothing found. Try another name, or switch Movies / Series.</Text>}
        </View>
      )}

      {view?.kind === 'seasons' && view.meta && seasonsOf(view.meta.episodes).map(season => {
        const meta = view.meta!;
        return (
          <ListRow
            key={season}
            title={seasonName(season)}
            detail={`${meta.episodes.filter(ep => ep.season === season).length} episodes`}
            onPress={() => push({ kind: 'episodes', card: view.card, meta, season })}
          />
        );
      })}

      {view?.kind === 'episodes' && (
        <Button title={`Save ${seasonName(view.season)} for offline`} icon="arrow.down.circle" onPress={() => void saveSeason(view.card, view.season)} />
      )}
      {view?.kind === 'episodes' && view.meta.episodes.filter(ep => ep.season === view.season).map(ep => (
        <ListRow key={ep.id} title={`${episodeCode(ep)} · ${ep.name}`} onPress={() => push({ kind: 'streams', card: view.card, episode: ep })} />
      ))}

      {view?.kind === 'streams' && view.streams && (
        <>
          <Text style={type.subhead}>
            {view.streams.length ? 'Tap a stream to play it on the TV, or ↓ to save it to the Mac library for offline viewing. 1080p x264 with many seeders starts fastest.' : 'No torrents with seeders were found.'}
          </Text>
          {view.streams.map(stream => {
            const label = streamLabel(stream);
            return <ListRow key={`${stream.infoHash}/${stream.fileIdx}`} title={label.main} detail={label.info} icon="tv" warn={stream.risky} onPress={() => play(stream)} onSave={() => void saveStream(stream)} />;
          })}
        </>
      )}
    </View>
  );
}

function ListRow({ title, detail, onPress, icon, warn, onSave }: {
  title: string; detail?: string; onPress: () => void; icon?: 'tv'; warn?: boolean; onSave?: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, warn && { color: colors.textSecondary }]} numberOfLines={2}>{title}</Text>
        {!!detail && <Text style={type.caption} numberOfLines={3}>{detail}</Text>}
      </View>
      {onSave && (
        <Pressable accessibilityRole="button" accessibilityLabel="Save to the Mac library for offline viewing" onPress={onSave} hitSlop={10} style={styles.saveButton}>
          <SymbolView name="arrow.down.circle" size={20} tintColor={colors.textSecondary} />
        </Pressable>
      )}
      <SymbolView name={icon === 'tv' ? 'play.tv' : 'chevron.right'} size={icon === 'tv' ? 18 : 12} tintColor={icon === 'tv' ? colors.accent : colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.s },
  searchRow: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  input: {
    flex: 1, color: colors.text, backgroundColor: colors.surfaceRaised, borderRadius: radius.medium,
    paddingHorizontal: space.m, paddingVertical: 10, fontSize: 15,
  },
  segments: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, padding: 3, alignSelf: 'flex-start' },
  segment: { paddingHorizontal: space.l, paddingVertical: 6, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.accentMuted },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: colors.accent },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  card: { width: '31.5%', gap: 3 },
  poster: { width: '100%', aspectRatio: 2 / 3, borderRadius: radius.small, backgroundColor: colors.surfaceRaised },
  cardName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  backText: { ...type.headline, color: colors.accent, flexShrink: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.s, backgroundColor: colors.surface,
    borderRadius: radius.medium, paddingHorizontal: space.m, paddingVertical: 10,
  },
  pressed: { opacity: 0.6 },
  continueCard: { width: 112, gap: 3 },
  continueTrack: { height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden', marginTop: -6, marginHorizontal: 4 },
  continueFill: { height: 3, backgroundColor: colors.accent },
  saveButton: { paddingHorizontal: 4, paddingVertical: 2 },
  error: { color: '#f87171', fontSize: 13 },
});
