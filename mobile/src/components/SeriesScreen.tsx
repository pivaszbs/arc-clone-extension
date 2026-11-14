import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Image, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';

import { episodeDownloads, useEpisodeDownloads } from '../lib/episode-downloads';
import { clock } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { Episode, Series } from '../lib/library';
import type { Progress } from '../lib/storage';
import { colors, radius, space } from '../theme';
import { continueEpisode, seriesProgress } from './SeriesGallery';
import { SwipeCard, swipeColors } from './SwipeCard';
import { rectOf, type Rect } from './ZoomFrom';

type Props = {
  series: Series;
  progress: Record<string, Progress>;
  width: number;
  autoSkip: boolean;
  onAutoSkip: (value: boolean) => void;
  /** `swiped`: the edge swipe already slid the screen away. */
  onBack: (swiped?: boolean) => void;
  /** `from` is the tapped card or button, so the player can grow out of it. */
  onPlay: (episode: Episode, from: Rect | null) => void;
  onToggleWatched: (episode: Episode) => void;
  /** True for series from the Mac: episodes can be downloaded to this device. */
  fromMac: boolean;
  /** Shown above the episodes, e.g. the TV remote while the TV plays this series. */
  extra?: React.ReactNode;
};

const device = Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';

function confirmRemove(series: Series, episode: Episode, fromMac: boolean) {
  Alert.alert(`Remove ${episode.label} from this ${device}?`, fromMac ? 'You can download it again from the Mac.' : 'The file is deleted from this device.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => episodeDownloads.remove(series.folder, episode.video) },
  ]);
}

/** A progress fill. */
function Bar({ fraction }: { fraction: number }) {
  return <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }]} /></View>;
}

function DownloadIcon({ series, episode, fromMac }: { series: Series; episode: Episode; fromMac: boolean }) {
  const downloads = useEpisodeDownloads();
  const state = downloads.state(series.folder, episode.video);
  if (downloads.isOnDevice(series.folder, episode.video)) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${episode.label} from this ${device}`} hitSlop={12} onPress={() => confirmRemove(series, episode, fromMac)}>
        <SymbolView name={device === 'iPad' ? 'ipad' : 'iphone'} size={20} tintColor="#34d399" />
      </Pressable>
    );
  }
  if (!fromMac) return null;
  if (state?.status === 'downloading') {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Stop downloading" hitSlop={12} onPress={() => downloads.cancel(series.folder)} style={styles.percent}>
        <Text style={styles.percentText}>{Math.round(state.fraction * 100)}%</Text>
      </Pressable>
    );
  }
  if (state?.status === 'queued') return <ActivityIndicator size="small" color={colors.textTertiary} />;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Download ${episode.label} to this ${device}`} hitSlop={12} onPress={() => { haptics.select(); downloads.download(series, [episode]); }}>
      <SymbolView
        name={state?.status === 'failed' ? 'exclamationmark.arrow.circlepath' : 'arrow.down.circle'}
        size={22}
        tintColor={state?.status === 'failed' ? colors.accent : colors.textSecondary}
      />
    </Pressable>
  );
}

/**
 * One series, like the TV app: cover, a Continue button and the episodes as a grid. Landscape on a
 * wide screen keeps the cover and buttons in a fixed column beside the episodes.
 * Swipe an episode right to mark it watched, left to download or remove it; swipe in from the left
 * edge to go back.
 */
export function SeriesScreen({ series, progress, width, autoSkip, onAutoSkip, onBack, onPlay, onToggleWatched, fromMac, extra }: Props) {
  const { height } = useWindowDimensions();
  const downloads = useEpisodeDownloads();
  const next = continueEpisode(series, progress);
  const nextSaved = next ? progress[next.key] : undefined;
  const { watched } = seriesProgress(series, progress);
  const missing = series.episodes.filter(item => !downloads.isOnDevice(series.folder, item.video));
  const active = series.episodes.filter(item => {
    const state = downloads.state(series.folder, item.video);
    return state && state.status !== 'failed';
  });
  const running = series.episodes.map(item => downloads.state(series.folder, item.video)).find(state => state?.status === 'downloading');

  const twoPane = width >= 900 && width > height;
  const sideWidth = twoPane ? Math.min(380, Math.round(width * 0.32)) : 0;
  const gridWidth = width - sideWidth;
  const columns = twoPane ? (gridWidth >= 900 ? 3 : 2) : width >= 1000 ? 4 : width >= 700 ? 3 : width >= 480 ? 2 : 1;
  const cardWidth = (gridWidth - space.l * 2 - space.m * (columns - 1)) / columns;
  const coverWidth = twoPane ? Math.min(sideWidth - space.l * 2, Math.round(height * 0.38 * 0.75)) : width >= 700 ? 200 : 110;

  // Entering is App's ZoomFrom (the screen grows out of the tapped cover).
  // Swipe in from the left edge to go back. React Native's Animated on the native driver.
  const [dragX] = useState(() => new Animated.Value(0));
  const edge = usePanGesture({
    runOnJS: true,
    hitSlop: { left: 0, width: 28 },
    activeOffsetX: 12,
    failOffsetY: [-14, 14],
    onUpdate: event => {
      dragX.setValue(Math.max(0, event.translationX));
    },
    onDeactivate: event => {
      if (event.translationX > 110 || (event.velocityX > 700 && event.translationX > 30)) {
        Animated.timing(dragX, { toValue: width, duration: 220, useNativeDriver: true }).start();
        haptics.tap();
        onBack(true);
      } else {
        Animated.spring(dragX, { toValue: 0, velocity: event.velocityX / 1000, bounciness: 4, useNativeDriver: true }).start();
      }
    },
  });
  const screenStyle = {
    opacity: dragX.interpolate({ inputRange: [0, width], outputRange: [1, 0.6], extrapolate: 'clamp' }),
    transform: [{ translateX: dragX }],
  };

  const playLabel = nextSaved && !nextSaved.finished && nextSaved.position >= 1
    ? `Continue ${next!.label} · ${clock(nextSaved.position)}`
    : watched ? `Play ${next?.label}` : 'Play from the start';

  const downloadControl = fromMac && (active.length ? (
    <View style={styles.downloadRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.downloadText}>
          Downloading to this {device} · {active.length} left{running?.status === 'downloading' ? ` · ${Math.round(running.fraction * 100)}%` : ''}
        </Text>
        <Bar fraction={running?.status === 'downloading' ? running.fraction : 0} />
      </View>
      <Pressable onPress={() => { haptics.select(); downloads.cancel(series.folder); }} style={styles.secondary}>
        <Text style={styles.secondaryText}>Stop</Text>
      </Pressable>
    </View>
  ) : missing.length ? (
    <Pressable onPress={() => { haptics.select(); downloads.download(series, missing); }} style={({ pressed }) => [styles.secondary, styles.downloadAll, pressed && styles.pressed]}>
      <SymbolView name="arrow.down.circle.fill" size={18} tintColor={colors.accent} />
      <Text style={styles.secondaryText}>
        {missing.length === series.episodes.length ? `Download all ${missing.length} episodes` : `Download the other ${missing.length}`}
      </Text>
    </Pressable>
  ) : (
    <Text style={styles.downloadText}>All episodes are on this {device}</Text>
  ));

  const details = (
    <View style={[styles.heroText, twoPane && styles.heroTextSide]}>
      <Text style={[styles.title, twoPane && styles.titleSide]}>{series.title}</Text>
      {!!series.credit && <Text style={styles.credit} numberOfLines={1}>{series.credit}</Text>}
      <Text style={styles.count}>{series.episodes.length} episodes · {watched} watched</Text>
      {next && (
        <Pressable onPress={event => { haptics.tap(); void rectOf(event.currentTarget).then(from => onPlay(next, from)); }} style={({ pressed }) => [styles.play, twoPane && styles.playSide, pressed && styles.pressed]}>
          <SymbolView name="play.fill" size={16} tintColor={colors.background} />
          <Text style={styles.playText} numberOfLines={1}>{playLabel}</Text>
        </Pressable>
      )}
      {downloadControl}
      <View style={styles.setting}>
        <Text style={styles.settingText}>Auto-skip opening, ending and recap</Text>
        <Switch value={autoSkip} onValueChange={value => { haptics.select(); onAutoSkip(value); }} trackColor={{ true: colors.accent }} />
      </View>
      <Text style={styles.hint}>Swipe an episode right to mark it watched, left to {fromMac ? 'download or remove it' : 'remove it'}.</Text>
    </View>
  );

  const cover = series.poster ? (
    <Image source={{ uri: series.poster }} style={[styles.cover, { width: coverWidth }]} />
  ) : null;

  const backButton = (
    <Pressable onPress={() => { haptics.select(); onBack(); }} hitSlop={10} style={styles.back}>
      <SymbolView name="chevron.left" size={16} tintColor={colors.accent} />
      <Text style={styles.backText}>All titles</Text>
    </Pressable>
  );

  const header = (
    <View style={styles.header}>
      {!twoPane && (
        <>
          {backButton}
          <View style={styles.hero}>
            {cover}
            {details}
          </View>
        </>
      )}
      {extra}
      <Text style={styles.section}>Episodes</Text>
    </View>
  );

  const grid = (
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
        const here = downloads.isOnDevice(series.folder, item.video);
        const fraction = saved?.finished ? 1 : saved?.duration ? Math.min(1, saved.position / saved.duration) : 0;
        const status = saved?.finished ? 'Watched'
          : saved && saved.position >= 1 ? `Resume at ${clock(saved.position)}`
          : item.subtitle ? 'Subtitles' : 'No subtitles';
        return (
          <SwipeCard
            style={{ width: cardWidth }}
            accessibilityLabel={`${item.label}, ${status}`}
            onPress={target => { haptics.tap(); void rectOf(target).then(from => onPlay(item, from)); }}
            right={{
              label: saved?.finished ? 'Unwatched' : 'Watched',
              icon: saved?.finished ? 'arrow.uturn.backward.circle' : 'checkmark.circle.fill',
              color: swipeColors.watched,
              onCommit: () => onToggleWatched(item),
            }}
            left={here
              ? { label: 'Remove', icon: 'trash', color: swipeColors.remove, onCommit: () => confirmRemove(series, item, fromMac) }
              : fromMac ? { label: 'Download', icon: 'arrow.down.circle.fill', color: swipeColors.download, onCommit: () => downloads.download(series, [item]) } : undefined}
          >
            <View style={[styles.card, isNext && styles.cardNext]}>
              <View style={styles.cardTop}>
                <Text style={[styles.cardTitle, isNext && { color: colors.accent }]} numberOfLines={1}>{item.label}</Text>
                <DownloadIcon series={series} episode={item} fromMac={fromMac} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={saved?.finished ? `Mark ${item.label} unwatched` : `Mark ${item.label} watched`}
                  hitSlop={12}
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
              <Bar fraction={fraction} />
            </View>
          </SwipeCard>
        );
      }}
    />
  );

  return (
    <GestureDetector gesture={edge}>
      <Animated.View style={[styles.root, screenStyle]}>
        {twoPane ? (
          <View style={styles.split}>
            <ScrollView style={{ width: sideWidth }} contentContainerStyle={styles.side}>
              {backButton}
              {cover}
              {details}
            </ScrollView>
            <View style={{ width: gridWidth }}>{grid}</View>
          </View>
        ) : grid}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  side: { paddingHorizontal: space.l, paddingBottom: space.xl, gap: space.l },
  content: { paddingHorizontal: space.l, paddingBottom: space.xl, gap: space.m },
  row: { gap: space.m },
  header: { gap: space.l, paddingBottom: space.s },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: space.xs },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  hero: { flexDirection: 'row', gap: space.xl, alignItems: 'flex-start' },
  cover: { aspectRatio: 3 / 4, borderRadius: radius.medium, backgroundColor: colors.surfaceRaised },
  heroText: { flex: 1, gap: space.s },
  heroTextSide: { flex: 0 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  titleSide: { fontSize: 24 },
  credit: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  count: { color: colors.textTertiary, fontSize: 14 },
  play: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s, alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 22, paddingVertical: 12, marginTop: space.s },
  playSide: { alignSelf: 'stretch' },
  playText: { color: colors.background, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  setting: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginTop: space.s, maxWidth: 420 },
  settingText: { color: colors.textSecondary, fontSize: 14, flex: 1 },
  hint: { color: colors.textTertiary, fontSize: 12, marginTop: space.xs },
  section: { color: colors.text, fontSize: 20, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.medium, padding: space.l, gap: space.s },
  cardNext: { borderWidth: 1, borderColor: colors.accent },
  pressed: { opacity: 0.75 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  cardTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  cardStatus: { color: colors.textSecondary, fontSize: 13 },
  bar: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accent },
  downloadRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, maxWidth: 520 },
  downloadText: { color: colors.textSecondary, fontSize: 14, marginBottom: space.xs },
  downloadAll: { flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start' },
  secondary: { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: space.l, paddingVertical: 10 },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  percent: { minWidth: 40, alignItems: 'center' },
  percentText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
});
