import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { groupSeasons, nextSeasonOf, seasonLabel, type TitleGroup, type TitleInfo } from '../../../shared/gallery/seasons';

import { clock } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { Episode, Series } from '../lib/library';
import type { Progress } from '../lib/storage';
import { rectOf, type Rect } from './ZoomFrom';
import { colors, radius, space } from '../theme';

type Props = {
  series: Series[];
  progress: Record<string, Progress>;
  width: number;
  /** `from` is where the tapped card is, so the next screen can grow out of it. */
  onOpen: (series: Series, from: Rect | null) => void;
  /** One tap on the Continue card plays this episode straight away. */
  onPlay: (series: Series, episode: Episode, from: Rect | null) => void;
  header?: React.ReactElement;
  /** Pull down to reload the library. */
  refreshing?: boolean;
  onRefresh?: () => void;
};

/** Where you are in a series: the episode last watched, and how much of the series is finished. */
export function seriesProgress(series: Series, progress: Record<string, Progress>) {
  let latest = -1;
  let at = 0;
  let watched = 0;
  series.episodes.forEach((episode, index) => {
    const saved = progress[episode.key];
    if (saved?.finished) watched++;
    if (saved && saved.watchedAt > at) { at = saved.watchedAt; latest = index; }
  });
  return { latest, watched, lastWatchedAt: at };
}

/** The episode to continue with: the one in progress, or the next after the last finished one. */
export function continueEpisode(series: Series, progress: Record<string, Progress>) {
  const { latest } = seriesProgress(series, progress);
  if (latest < 0) return series.episodes[0];
  const last = series.episodes[latest];
  return progress[last.key]?.finished ? series.episodes[latest + 1] ?? last : last;
}

/** What a series is for season grouping: the Mac's catalog lookup when there is one, else its name. */
export function seriesInfo(series: Series): TitleInfo {
  return {
    title: series.catalog?.title || series.title,
    credit: series.credit,
    franchise: series.catalog?.franchise,
    aired: series.catalog?.aired,
  };
}

/** Every series under its title: seasons and translations together, in season order. */
export function seriesGroups(series: Series[]) {
  return groupSeasons(series, seriesInfo);
}

/**
 * The series watched most recently that still has something left to watch; once a season is
 * finished, the next season of the same title (same translation when it is there).
 */
function lastWatched(groups: TitleGroup<Series>[], progress: Record<string, Progress>) {
  let best: { series: Series; episode: Episode; at: number } | null = null;
  for (const group of groups) {
    let recent: Series | undefined;
    let at = 0;
    for (const item of group.entries) {
      const { lastWatchedAt } = seriesProgress(item, progress);
      if (lastWatchedAt > at) { recent = item; at = lastWatchedAt; }
    }
    if (!recent || (best && at <= best.at)) continue;
    const episode = continueEpisode(recent, progress);
    if (episode && !progress[episode.key]?.finished) {
      best = { series: recent, episode, at };
      continue;
    }
    const following = nextSeasonOf(group.entries, recent, seriesInfo);
    const first = following?.episodes.find(item => !progress[item.key]?.finished);
    if (following && first) best = { series: following, episode: first, at };
  }
  return best;
}

/** The big card at the top: the last series you watched, played with one tap. */
function ContinueCard({ series, episode, progress, width, onPlay }: {
  series: Series; episode: Episode; progress: Record<string, Progress>; width: number; onPlay: (from: Rect | null) => void;
}) {
  const saved = progress[episode.key];
  const resume = saved && !saved.finished && saved.position >= 1;
  const fraction = resume && saved.duration ? Math.min(1, saved.position / saved.duration) : 0;
  const wide = width >= 600;
  const posterWidth = wide ? Math.min(220, width * 0.24) : Math.min(130, width * 0.32);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Continue ${series.title}, ${episode.label}`}
      onPress={event => { haptics.tap(); void rectOf(event.currentTarget).then(onPlay); }}
      style={({ pressed }) => [styles.hero, pressed && styles.heroPressed]}
    >
      {series.poster ? <Image source={{ uri: series.poster }} style={StyleSheet.absoluteFill} blurRadius={40} resizeMode="cover" /> : null}
      <View style={[StyleSheet.absoluteFill, styles.heroShade]} />
      {series.poster ? <Image source={{ uri: series.poster }} style={[styles.heroPoster, { width: posterWidth }]} resizeMode="cover" /> : null}
      <View style={styles.heroText}>
        <Text style={styles.heroKicker}>Continue watching</Text>
        <Text style={[styles.heroTitle, !wide && styles.heroTitleNarrow]} numberOfLines={wide ? 3 : 2}>{series.title}</Text>
        <Text style={styles.heroEpisode} numberOfLines={1}>
          {episode.label}{resume ? ` · ${clock(saved.position)}${saved.duration ? ` of ${clock(saved.duration)}` : ''}` : ''}
        </Text>
        {fraction > 0 && <View style={styles.heroBar}><View style={[styles.barFill, { width: `${fraction * 100}%` }]} /></View>}
        <View style={styles.heroButton}>
          <SymbolView name="play.fill" size={18} tintColor={colors.background} />
          <Text style={styles.heroButtonText}>{resume ? 'Resume' : 'Play'}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function Poster({ uri, title }: { uri?: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (uri && !failed) {
    return <Image source={{ uri }} style={styles.poster} resizeMode="cover" onError={() => setFailed(true)} />;
  }
  return (
    <View style={[styles.poster, styles.placeholder]}>
      <Text style={styles.placeholderText} numberOfLines={4}>{title}</Text>
    </View>
  );
}

type Card =
  | { kind: 'series'; key: string; series: Series; title: string }
  | { kind: 'group'; key: string; group: TitleGroup<Series> };

/** The library as a wall of covers, like the TV app; a title with several seasons opens a level deeper. */
export function SeriesGallery({ series, progress, width, onOpen, onPlay, header, refreshing = false, onRefresh }: Props) {
  const columns = Math.max(2, Math.min(6, Math.floor(width / 190)));
  const groups = useMemo(() => seriesGroups(series), [series]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = groups.find(group => group.key === openKey && group.entries.length > 1);
  const recent = open ? null : lastWatched(groups, progress);
  const cards: Card[] = open
    ? open.entries.map(item => ({ kind: 'series', key: item.folder || '_root', series: item, title: seasonLabel(seriesInfo(item), open.seasons > 1, open.title) }))
    : groups.map(group => group.entries.length === 1
      ? { kind: 'series', key: group.entries[0].folder || '_root', series: group.entries[0], title: group.title }
      : { kind: 'group', key: `group:${group.key}`, group });
  const cardWidth = (width - space.l * 2 - space.m * (columns - 1)) / columns;
  const listHeader = (
    <View>
      {header}
      {open ? (
        <View style={styles.heroWrap}>
          <Pressable accessibilityRole="button" onPress={() => { haptics.tap(); setOpenKey(null); }} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <SymbolView name="chevron.left" size={15} tintColor={colors.accent} />
            <Text style={styles.backText}>All series</Text>
          </Pressable>
          <Text style={styles.groupTitle} numberOfLines={2}>{open.title}</Text>
        </View>
      ) : recent && (
        <View style={styles.heroWrap}>
          <ContinueCard series={recent.series} episode={recent.episode} progress={progress} width={width - space.l * 2} onPlay={from => onPlay(recent.series, recent.episode, from)} />
          <Text style={styles.sectionTitle}>All series</Text>
        </View>
      )}
    </View>
  );
  return (
    <FlatList
      key={`${columns}:${open?.key ?? ''}`}
      data={cards}
      numColumns={columns}
      keyExtractor={item => item.key}
      ListHeaderComponent={listHeader}
      // The header brings its own side padding; cancel the list's so both line up with the covers.
      ListHeaderComponentStyle={styles.header}
      contentContainerStyle={styles.content}
      columnWrapperStyle={styles.row}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} /> : undefined}
      renderItem={({ item }) => {
        if (item.kind === 'group') {
          const { group } = item;
          const total = group.entries.reduce((sum, entry) => sum + entry.episodes.length, 0);
          const watched = group.entries.reduce((sum, entry) => sum + seriesProgress(entry, progress).watched, 0);
          const poster = group.entries.find(entry => entry.poster)?.poster;
          const kinds = group.seasons > 1 ? `${group.seasons} seasons` : `${group.entries.length} translations`;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${group.title}, ${kinds}`}
              onPress={() => { haptics.select(); setOpenKey(group.key); }}
              style={({ pressed }) => [styles.card, { width: cardWidth }, pressed && styles.pressed]}
            >
              <Poster uri={poster} title={group.title} />
              <View style={styles.badge}><Text style={styles.badgeText}>{kinds}</Text></View>
              {watched > 0 && (
                <View style={styles.bar}><View style={[styles.barFill, { width: `${(watched / total) * 100}%` }]} /></View>
              )}
              <View style={styles.meta}>
                <Text style={styles.title} numberOfLines={2}>{group.title}</Text>
                <Text style={styles.info} numberOfLines={1}>{total} episode{total === 1 ? '' : 's'}</Text>
              </View>
            </Pressable>
          );
        }
        const { latest, watched } = seriesProgress(item.series, progress);
        const total = item.series.episodes.length;
        const where = latest >= 0 ? ` · ${item.series.episodes[latest].label}` : '';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={event => { void rectOf(event.currentTarget).then(from => onOpen(item.series, from)); }}
            style={({ pressed }) => [styles.card, { width: cardWidth }, pressed && styles.pressed]}
          >
            <Poster uri={item.series.poster} title={item.title} />
            {watched > 0 && (
              <View style={styles.bar}><View style={[styles.barFill, { width: `${(watched / total) * 100}%` }]} /></View>
            )}
            <View style={styles.meta}>
              <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.info} numberOfLines={1}>{total} episode{total === 1 ? '' : 's'}{where}</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.l, paddingBottom: space.xl, gap: space.m },
  row: { gap: space.m },
  header: { marginHorizontal: -space.l },
  card: { backgroundColor: colors.surface, borderRadius: radius.medium, overflow: 'hidden' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  poster: { width: '100%', aspectRatio: 3 / 4, backgroundColor: colors.surfaceRaised },
  placeholder: { alignItems: 'center', justifyContent: 'center', padding: space.m },
  placeholderText: { color: colors.textSecondary, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  bar: { height: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  barFill: { height: 3, backgroundColor: colors.accent },
  meta: { padding: space.m, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 19 },
  info: { color: colors.textSecondary, fontSize: 12 },
  heroWrap: { paddingHorizontal: space.l, gap: space.l, paddingBottom: space.xs },
  hero: { flexDirection: 'row', gap: space.xl, padding: space.l, borderRadius: radius.large, overflow: 'hidden', backgroundColor: colors.surfaceRaised },
  heroPressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  heroShade: { backgroundColor: 'rgba(14,14,16,0.55)' },
  heroPoster: { aspectRatio: 3 / 4, borderRadius: radius.medium },
  heroText: { flex: 1, justifyContent: 'center', gap: space.s },
  heroKicker: { color: colors.accent, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  heroTitle: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.3 },
  heroTitleNarrow: { fontSize: 20 },
  heroEpisode: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  heroBar: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden', maxWidth: 420 },
  heroButton: { flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 24, paddingVertical: 12, marginTop: space.s },
  heroButtonText: { color: colors.background, fontSize: 17, fontWeight: '700' },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: space.xs },
  backText: { color: colors.accent, fontSize: 17, fontWeight: '600' },
  groupTitle: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 },
  badge: { position: 'absolute', top: space.s, right: space.s, backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '700' },
});
