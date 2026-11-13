import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, AppState, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { EpisodeList } from './src/components/EpisodeList';
import { MacLibrary } from './src/components/MacLibrary';
import { Player } from './src/components/Player';
import { haptics } from './src/lib/haptics';
import { importFiles, importFolder, readLibrary, type Episode, type Series } from './src/lib/library';
import * as remote from './src/lib/remote';
import { allProgress, saveSettings, settings as savedSettings } from './src/lib/storage';
import { colors, radius, space } from './src/theme';

function latestEpisode(series: Series) {
  const progress = allProgress();
  let best: Episode | undefined;
  let at = 0;
  for (const episode of series.episodes) {
    const saved = progress[episode.key];
    if (saved && saved.watchedAt > at) { at = saved.watchedAt; best = episode; }
  }
  if (!best) return series.episodes[0];
  // A finished episode continues with the next one.
  const index = series.episodes.indexOf(best);
  return progress[best.key]?.finished && series.episodes[index + 1] ? series.episodes[index + 1] : best;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Study />
    </SafeAreaProvider>
  );
}

function Study() {
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const [library, setLibrary] = useState<Series[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [episodeKey, setEpisodeKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState(savedSettings);
  const [macOpen, setMacOpen] = useState(false);
  const [sync, setSync] = useState(remote.syncStatus());
  const [, setRevision] = useState(0);
  const refreshProgress = useCallback(() => setRevision(value => value + 1), []);

  const scan = useCallback(() => {
    try { setLibrary(readLibrary()); } catch (error) { console.warn('Could not read the library', error); }
  }, []);

  // Sync with the Mac in the background of the app's own work. Everything shown comes from this
  // iPhone; synced progress and skip timings are folded in when they arrive.
  const syncNow = useCallback(async () => {
    const changed = await remote.sync();
    if (changed.length) { scan(); refreshProgress(); }
  }, [scan, refreshProgress]);

  useEffect(() => {
    scan();
    void syncNow();
    // Files dropped in through the Files app or Finder show up when the app comes back.
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') { scan(); void syncNow(); }
    });
    const unsubscribe = remote.onStatus(setSync);
    return () => { subscription.remove(); unsubscribe(); };
  }, [scan, syncNow]);

  const series = library.find(item => item.folder === folder) ?? library[0];
  const episode = series?.episodes.find(item => item.key === episodeKey) ?? (series ? latestEpisode(series) : undefined);
  const index = series && episode ? series.episodes.indexOf(episode) : -1;
  const neighbours = useMemo(
    () => (series && index >= 0 ? series.episodes.slice(Math.max(0, index - 2), index + 3) : []),
    [series, index],
  );

  // iPhones turn to landscape for fullscreen; iPads keep whatever the user holds.
  useEffect(() => {
    if (Platform.OS !== 'ios' || Platform.isPad) return;
    void ScreenOrientation.lockAsync(fullscreen ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, [fullscreen]);

  const updateSettings = (next: Partial<typeof settings>) => {
    saveSettings(next);
    setSettings(current => ({ ...current, ...next }));
  };

  const pickSource = () => {
    const run = async (task: () => Promise<string | null>) => {
      try {
        const name = await task();
        scan();
        if (name) { setFolder(name); setEpisodeKey(null); }
      } catch (error) {
        if (!/cancel/i.test(String(error))) Alert.alert('Could not import', String(error));
      }
    };
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Import downloads folder…', 'Import episode files…', 'Cancel'], cancelButtonIndex: 2, title: 'Add episodes' },
      choice => {
        if (choice === 0) void run(importFolder);
        if (choice === 1) void run(importFiles);
      },
    );
  };

  const selectEpisode = (next: Episode) => {
    haptics.select();
    setEpisodeKey(next.key);
  };

  const step = (direction: -1 | 1) => {
    const next = series?.episodes[index + direction];
    if (next) setEpisodeKey(next.key);
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Anime Study</Text>
          <Text style={styles.title} numberOfLines={2}>{series?.title ?? 'Offline Study'}</Text>
          {!!series?.credit && (
            <View style={styles.credit}><Text style={styles.creditText} numberOfLines={1}>{series.credit}</Text></View>
          )}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Mac library" onPress={() => setMacOpen(true)} hitSlop={10} style={styles.addButton}>
          <SymbolView
            name={sync.state === 'offline' ? 'desktopcomputer.trianglebadge.exclamationmark' : 'desktopcomputer'}
            size={18}
            tintColor={sync.state === 'unpaired' ? colors.textSecondary : colors.accent}
          />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Add episodes" onPress={pickSource} hitSlop={10} style={styles.addButton}>
          <SymbolView name="plus" size={20} tintColor={colors.accent} />
        </Pressable>
      </View>
      {library.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {library.map(item => {
            const active = item.folder === series?.folder;
            return (
              <Pressable
                key={item.folder || '_root'}
                onPress={() => { haptics.select(); setFolder(item.folder); setEpisodeKey(null); }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && { color: colors.background }]} numberOfLines={1}>{item.title}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Auto-skip opening, ending and recap</Text>
        <Switch
          value={settings.autoSkip}
          onValueChange={value => { haptics.select(); updateSettings({ autoSkip: value }); }}
          trackColor={{ true: colors.accent }}
        />
      </View>
    </View>
  );

  const player = episode && (
    <Player
      episode={episode}
      neighbours={neighbours}
      fullscreen={fullscreen}
      autoSkip={settings.autoSkip}
      subtitlesOn={settings.subtitles}
      onToggleFullscreen={value => setFullscreen(current => value ?? !current)}
      onToggleSubtitles={() => updateSettings({ subtitles: !settings.subtitles })}
      onStep={direction => step(direction)}
      hasPrevious={index > 0}
      hasNext={!!series && index < series.episodes.length - 1}
      onProgress={refreshProgress}
    />
  );

  const empty = (
    <View style={styles.empty}>
      <SymbolView name="film.stack" size={48} tintColor={colors.textTertiary} />
      <Text style={styles.emptyTitle}>No episodes yet</Text>
      <Text style={styles.emptyText}>
        Download series from the Mac to watch them anywhere, or copy a downloads folder into Files › On My {Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone'} › Anime Study.
        Episodes pair with .ass or .srt subtitles that share their name.
      </Text>
      <Pressable onPress={() => setMacOpen(true)} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Get episodes from Mac</Text></Pressable>
      <Pressable onPress={pickSource} hitSlop={8}><Text style={styles.emptyLink}>Import from Files</Text></Pressable>
    </View>
  );

  const list = series && (
    <EpisodeList episodes={series.episodes} current={episode?.key} progress={allProgress()} onSelect={selectEpisode} header={wide ? header : undefined} />
  );

  // Hidden sections keep their place in the tree so the video player is never remounted.
  const hide = fullscreen ? styles.hidden : undefined;

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={fullscreen} />
      <SafeAreaView style={styles.root} edges={fullscreen ? [] : ['top', 'left', 'right']}>
        {!series ? (
          <View style={{ flex: 1 }}>{header}{empty}</View>
        ) : wide ? (
          <View style={styles.split}>
            <View style={[styles.sidebar, { width: Math.min(380, width * 0.36) }, hide]}>{list}</View>
            <View style={[styles.main, fullscreen && styles.mainFullscreen]}>
              {player}
              <View style={hide}>
                <Text style={styles.nowPlaying} numberOfLines={1}>{episode?.label}</Text>
                <Text style={styles.fileName} numberOfLines={1}>{episode?.video}</Text>
              </View>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <View style={hide}>{header}</View>
            <View style={fullscreen ? styles.phoneFullscreen : styles.phonePlayer}>{player}</View>
            <View style={[{ flex: 1 }, hide]}>{list}</View>
          </View>
        )}
      </SafeAreaView>
      <MacLibrary visible={macOpen} onClose={() => { setMacOpen(false); scan(); }} onLibraryChanged={() => { scan(); refreshProgress(); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  hidden: { display: 'none' },
  split: { flex: 1, flexDirection: 'row' },
  sidebar: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator },
  main: { flex: 1, padding: space.xl, gap: space.m },
  mainFullscreen: { padding: 0 },
  phonePlayer: { paddingHorizontal: space.m, paddingBottom: space.m },
  phoneFullscreen: { flex: 1 },
  header: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.m, gap: space.m },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m },
  kicker: { color: colors.accent, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 2 },
  credit: { alignSelf: 'flex-start', marginTop: space.s, backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  creditText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  addButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentMuted, alignItems: 'center', justifyContent: 'center' },
  chips: { gap: space.s },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, maxWidth: 240 },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radius.medium, paddingHorizontal: space.l, paddingVertical: space.s },
  settingText: { color: colors.text, fontSize: 15, flex: 1, marginRight: space.m },
  nowPlaying: { color: colors.text, fontSize: 22, fontWeight: '700' },
  fileName: { color: colors.textTertiary, fontSize: 13, marginTop: 2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.m },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptyText: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 21, maxWidth: 420 },
  emptyButton: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 22, paddingVertical: 12, marginTop: space.s },
  emptyButtonText: { color: colors.background, fontSize: 16, fontWeight: '700' },
  emptyLink: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
