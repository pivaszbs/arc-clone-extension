import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { clock } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { Episode, Series } from '../lib/library';
import type { Progress } from '../lib/storage';
import { colors, radius, space } from '../theme';

type Props = {
  series: Series[];
  progress: Record<string, Progress>;
  width: number;
  onOpen: (series: Series) => void;
  /** One tap on the Continue card plays this episode straight away. */
  onPlay: (series: Series, episode: Episode) => void;
  header?: React.ReactElement;
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

/** The series watched most recently that still has something left to watch. */
function lastWatched(series: Series[], progress: Record<string, Progress>) {
  let best: { series: Series; episode: Episode; at: number } | null = null;
  for (const item of series) {
    const { lastWatchedAt } = seriesProgress(item, progress);
    if (!lastWatchedAt || (best && lastWatchedAt <= best.at)) continue;
    const episode = continueEpisode(item, progress);
    if (!episode || progress[episode.key]?.finished) continue;
    best = { series: item, episode, at: lastWatchedAt };
  }
  return best;
}

/** The big card at the top: the last series you watched, played with one tap. */
function ContinueCard({ series, episode, progress, width, onPlay }: {
  series: Series; episode: Episode; progress: Record<string, Progress>; width: number; onPlay: () => void;
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
      onPress={() => { haptics.tap(); onPlay(); }}
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

function Poster({ series }: { series: Series }) {
  const [failed, setFailed] = useState(false);
  if (series.poster && !failed) {
    return <Image source={{ uri: series.poster }} style={styles.poster} resizeMode="cover" onError={() => setFailed(true)} />;
  }
  return (
    <View style={[styles.poster, styles.placeholder]}>
      <Text style={styles.placeholderText} numberOfLines={4}>{series.title}</Text>
    </View>
  );
}

/** The library as a wall of covers, like the TV app. */
export function SeriesGallery({ series, progress, width, onOpen, onPlay, header }: Props) {
  const columns = Math.max(2, Math.min(6, Math.floor(width / 190)));
  const recent = lastWatched(series, progress);
  const listHeader = (
    <View>
      {header}
      {recent && (
        <View style={styles.heroWrap}>
          <ContinueCard series={recent.series} episode={recent.episode} progress={progress} width={width - space.l * 2} onPlay={() => onPlay(recent.series, recent.episode)} />
          <Text style={styles.sectionTitle}>All series</Text>
        </View>
      )}
    </View>
  );
  return (
    <FlatList
      key={columns}
      data={series}
      numColumns={columns}
      keyExtractor={item => item.folder || '_root'}
      ListHeaderComponent={listHeader}
      // The header brings its own side padding; cancel the list's so both line up with the covers.
      ListHeaderComponentStyle={styles.header}
      contentContainerStyle={styles.content}
      columnWrapperStyle={styles.row}
      renderItem={({ item }) => {
        const { latest, watched } = seriesProgress(item, progress);
        const total = item.episodes.length;
        const where = latest >= 0 ? ` · ${item.episodes[latest].label}` : '';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() => onOpen(item)}
            style={({ pressed }) => [styles.card, { width: (width - space.l * 2 - space.m * (columns - 1)) / columns }, pressed && styles.pressed]}
          >
            <Poster series={item} />
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
});
