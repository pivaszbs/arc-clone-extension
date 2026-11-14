import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useEpisodeDownloads } from '../lib/episode-downloads';
import { clock } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { Episode, Series } from '../lib/library';
import type { Progress } from '../lib/storage';
import { colors, radius, space } from '../theme';
import { seriesProgress } from './SeriesGallery';

type Props = {
  series: Series;
  progress: Record<string, Progress>;
  width: number;
  autoSkip: boolean;
  onAutoSkip: (value: boolean) => void;
  onBack: () => void;
  onPlay: (episode: Episode) => void;
  onToggleWatched: (episode: Episode) => void;
  /** True for series from the Mac: episodes can be downloaded to this device. */
  fromMac: boolean;
  /** Shown above the episodes, e.g. the TV remote while the TV plays this series. */
  extra?: React.ReactNode;
};

/** The episode to continue with: the one in progress, or the next after the last finished one. */
export function continueEpisode(series: Series, progress: Record<string, Progress>) {
  const { latest } = seriesProgress(series, progress);
  if (latest < 0) return series.episodes[0];
  const last = series.episodes[latest];
  return progress[last.key]?.finished ? series.episodes[latest + 1] ?? last : last;
}

/** One series: cover, a Continue button and the episodes as a grid, like the TV app. */
const device = Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';

function DownloadButton({ series, episode, fromMac }: { series: Series; episode: Episode; fromMac: boolean }) {
  const downloads = useEpisodeDownloads();
  const state = downloads.state(series.folder, episode.video);
  const here = downloads.isOnDevice(series.folder, episode.video);
  if (here) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${episode.label} from this ${device}`}
        hitSlop={10}
        onPress={() => Alert.alert(`Remove ${episode.label} from this ${device}?`, fromMac ? 'You can download it again from the Mac.' : 'The file is deleted from this device.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => downloads.remove(series.folder, episode.video) },
        ])}
      >
        <SymbolView name={device === 'iPad' ? 'ipad' : 'iphone'} size={20} tintColor="#34d399" />
      </Pressable>
    );
  }
  if (!fromMac) return null;
  if (state?.status === 'downloading') {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Stop downloading" hitSlop={10} onPress={() => downloads.cancel(series.folder)} style={styles.percent}>
        <Text style={styles.percentText}>{Math.round(state.fraction * 100)}%</Text>
      </Pressable>
    );
  }
  if (state?.status === 'queued') return <ActivityIndicator size="small" color={colors.textTertiary} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Download ${episode.label} to this ${device}`}
      hitSlop={10}
      onPress={() => { haptics.select(); downloads.download(series, [episode]); }}
    >
      <SymbolView name={state?.status === 'failed' ? 'exclamationmark.arrow.circlepath' : 'arrow.down.circle'} size={22} tintColor={state?.status === 'failed' ? colors.accent : colors.textSecondary} />
    </Pressable>
  );
}

export function SeriesScreen({ series, progress, width, autoSkip, onAutoSkip, onBack, onPlay, onToggleWatched, fromMac, extra }: Props) {
  const downloads = useEpisodeDownloads();
  const missing = series.episodes.filter(item => !downloads.isOnDevice(series.folder, item.video));
  const active = series.episodes.filter(item => {
    const state = downloads.state(series.folder, item.video);
    return state && state.status !== 'failed';
  });
  const running = series.episodes.map(item => downloads.state(series.folder, item.video)).find(state => state?.status === 'downloading');
  const next = continueEpisode(series, progress);
  const nextSaved = next ? progress[next.key] : undefined;
  const { watched } = seriesProgress(series, progress);
  const columns = width >= 1000 ? 4 : width >= 700 ? 3 : width >= 480 ? 2 : 1;
  const cardWidth = (width - space.l * 2 - space.m * (columns - 1)) / columns;
  const wide = width >= 700;

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => { haptics.select(); onBack(); }} hitSlop={10} style={styles.back}>
        <SymbolView name="chevron.left" size={16} tintColor={colors.accent} />
        <Text style={styles.backText}>All titles</Text>
      </Pressable>
      <View style={[styles.hero, !wide && styles.heroNarrow]}>
        {series.poster ? <Image source={{ uri: series.poster }} style={[styles.cover, !wide && styles.coverNarrow]} /> : null}
        <View style={styles.heroText}>
          <Text style={styles.title}>{series.title}</Text>
          {!!series.credit && <Text style={styles.credit} numberOfLines={1}>{series.credit}</Text>}
          <Text style={styles.count}>{series.episodes.length} episodes · {watched} watched</Text>
          {next && (
            <Pressable onPress={() => { haptics.tap(); onPlay(next); }} style={({ pressed }) => [styles.play, pressed && styles.pressed]}>
              <SymbolView name="play.fill" size={16} tintColor={colors.background} />
              <Text style={styles.playText}>
                {nextSaved && !nextSaved.finished && nextSaved.position >= 1
                  ? `Continue ${next.label} · ${clock(nextSaved.position)}`
                  : watched ? `Play ${next.label}` : 'Play from the start'}
              </Text>
            </Pressable>
          )}
          {fromMac && (active.length ? (
            <View style={styles.downloadRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.downloadText}>
                  Downloading to this {device} · {active.length} left{running?.status === 'downloading' ? ` · ${Math.round(running.fraction * 100)}%` : ''}
                </Text>
                <View style={styles.bar}><View style={[styles.barFill, { width: `${(running?.status === 'downloading' ? running.fraction : 0) * 100}%` }]} /></View>
              </View>
              <Pressable onPress={() => { haptics.select(); downloads.cancel(series.folder); }} style={styles.secondary}>
                <Text style={styles.secondaryText}>Stop</Text>
              </Pressable>
            </View>
          ) : missing.length ? (
            <Pressable onPress={() => { haptics.select(); downloads.download(series, missing); }} style={({ pressed }) => [styles.secondary, styles.downloadAll, pressed && styles.pressed]}>
              <SymbolView name="arrow.down.circle.fill" size={18} tintColor={colors.accent} />
              <Text style={styles.secondaryText}>
                {missing.length === series.episodes.length ? `Download all ${missing.length} episodes to this ${device}` : `Download the other ${missing.length} episodes to this ${device}`}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.downloadText}>All episodes are on this {device}</Text>
          ))}
          <View style={styles.setting}>
            <Text style={styles.settingText}>Auto-skip opening, ending and recap</Text>
            <Switch value={autoSkip} onValueChange={value => { haptics.select(); onAutoSkip(value); }} trackColor={{ true: colors.accent }} />
          </View>
        </View>
      </View>
      {extra}
      <Text style={styles.section}>Episodes</Text>
    </View>
  );

  return (
    <FlatList
      key={columns}
      data={series.episodes}
      numColumns={columns}
      keyExtractor={item => item.key}
      ListHeaderComponent={header}
      contentContainerStyle={styles.content}
      columnWrapperStyle={columns > 1 ? styles.row : undefined}
      renderItem={({ item }) => {
        const saved = progress[item.key];
        const isNext = item.key === next?.key;
        const fraction = saved?.finished ? 1 : saved?.duration ? Math.min(1, saved.position / saved.duration) : 0;
        const status = saved?.finished ? 'Watched'
          : saved && saved.position >= 1 ? `Resume at ${clock(saved.position)}`
          : item.subtitle ? 'Subtitles' : 'No subtitles';
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => { haptics.tap(); onPlay(item); }}
            onLongPress={() => onToggleWatched(item)}
            style={({ pressed }) => [styles.card, { width: cardWidth }, isNext && styles.cardNext, pressed && styles.pressed]}
          >
            <View style={styles.cardTop}>
              <Text style={[styles.cardTitle, isNext && { color: colors.accent }]} numberOfLines={1}>{item.label}</Text>
              <DownloadButton series={series} episode={item} fromMac={fromMac} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={saved?.finished ? `Mark ${item.label} unwatched` : `Mark ${item.label} watched`}
                hitSlop={10}
                onPress={() => onToggleWatched(item)}
              >
                <SymbolView
                  name={saved?.finished ? 'checkmark.circle.fill' : 'checkmark.circle'}
                  size={22}
                  tintColor={saved?.finished ? '#34d399' : colors.textTertiary}
                />
              </Pressable>
            </View>
            <Text style={styles.cardStatus} numberOfLines={1}>{isNext && !saved?.finished ? `Up next · ${status}` : status}</Text>
            <View style={styles.bar}><View style={[styles.barFill, { width: `${fraction * 100}%` }]} /></View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.l, paddingBottom: space.xl, gap: space.m },
  row: { gap: space.m },
  header: { gap: space.l, paddingBottom: space.s },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: space.xs },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  hero: { flexDirection: 'row', gap: space.xl, alignItems: 'flex-start' },
  heroNarrow: { gap: space.l },
  cover: { width: 200, aspectRatio: 3 / 4, borderRadius: radius.medium, backgroundColor: colors.surfaceRaised },
  coverNarrow: { width: 110 },
  heroText: { flex: 1, gap: space.s },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  credit: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  count: { color: colors.textTertiary, fontSize: 14 },
  play: { flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 22, paddingVertical: 12, marginTop: space.s },
  playText: { color: colors.background, fontSize: 16, fontWeight: '700' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginTop: space.s, maxWidth: 420 },
  settingText: { color: colors.textSecondary, fontSize: 14, flex: 1 },
  section: { color: colors.text, fontSize: 20, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.medium, padding: space.l, gap: space.s },
  cardNext: { borderWidth: 1, borderColor: colors.accent },
  pressed: { opacity: 0.75 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  downloadRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, maxWidth: 520 },
  downloadText: { color: colors.textSecondary, fontSize: 14, marginBottom: space.xs },
  downloadAll: { flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start' },
  secondary: { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: space.l, paddingVertical: 10 },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  percent: { minWidth: 40, alignItems: 'center' },
  percentText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  cardTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  cardStatus: { color: colors.textSecondary, fontSize: 13 },
  bar: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  barFill: { height: 3, backgroundColor: colors.accent },
});
