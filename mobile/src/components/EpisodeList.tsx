import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { clock } from '../lib/format';
import type { Episode } from '../lib/library';
import type { Progress } from '../lib/storage';
import { colors, radius, space } from '../theme';

type Props = {
  episodes: Episode[];
  current?: string;
  progress: Record<string, Progress>;
  onSelect: (episode: Episode) => void;
  header?: React.ReactElement;
};

export function EpisodeList({ episodes, current, progress, onSelect, header }: Props) {
  const list = useRef<FlatList<Episode>>(null);
  const currentIndex = episodes.findIndex(episode => episode.key === current);

  useEffect(() => {
    if (currentIndex > 0) list.current?.scrollToIndex({ index: currentIndex, viewPosition: 0.3, animated: false });
  }, [currentIndex]);

  return (
    <FlatList
      ref={list}
      data={episodes}
      keyExtractor={episode => episode.key}
      ListHeaderComponent={header}
      contentInsetAdjustmentBehavior="automatic"
      onScrollToIndexFailed={({ index }) => setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false }), 50)}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => {
        const saved = progress[item.key];
        const active = item.key === current;
        const fraction = saved?.finished ? 1 : saved && saved.duration ? Math.min(1, saved.position / saved.duration) : 0;
        const status = saved?.finished ? 'Watched'
          : saved && saved.position >= 1 ? `${clock(saved.position)} watched`
          : item.subtitle ? 'Subtitles available' : 'No subtitles';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(item)}
            style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.rowPressed]}
          >
            <View style={styles.text}>
              <Text style={[styles.label, active && { color: colors.accent }]} numberOfLines={1}>{item.label}</Text>
              <Text style={styles.status} numberOfLines={1}>{status}</Text>
              {fraction > 0 && (
                <View style={styles.progress}><View style={[styles.progressFill, { width: `${fraction * 100}%` }]} /></View>
              )}
            </View>
            {saved?.finished ? <SymbolView name="checkmark.circle.fill" size={20} tintColor={colors.textTertiary} />
              : active ? <SymbolView name="play.circle.fill" size={22} tintColor={colors.accent} /> : null}
          </Pressable>
        );
      }}
    />
  );
}


const styles = StyleSheet.create({
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, gap: space.m, borderRadius: radius.medium, marginHorizontal: space.s },
  rowActive: { backgroundColor: colors.accentMuted },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  text: { flex: 1, gap: 2 },
  label: { color: colors.text, fontSize: 17, fontWeight: '600' },
  status: { color: colors.textSecondary, fontSize: 13 },
  progress: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', marginTop: 6, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: colors.accent },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: space.l * 2 },
});
