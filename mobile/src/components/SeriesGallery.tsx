import { useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Series } from '../lib/library';
import type { Progress } from '../lib/storage';
import { colors, radius, space } from '../theme';

type Props = {
  series: Series[];
  progress: Record<string, Progress>;
  width: number;
  onOpen: (series: Series) => void;
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
export function SeriesGallery({ series, progress, width, onOpen, header }: Props) {
  const columns = Math.max(2, Math.min(6, Math.floor(width / 190)));
  return (
    <FlatList
      key={columns}
      data={series}
      numColumns={columns}
      keyExtractor={item => item.folder || '_root'}
      ListHeaderComponent={header}
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
});
