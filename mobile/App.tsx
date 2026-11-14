import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { DownloadView } from './src/components/DownloadView';
import { PipelinesView, type ImportPipelineState, type LocalScanState } from './src/components/PipelinesView';
import { Player } from './src/components/Player';
import { SeriesGallery } from './src/components/SeriesGallery';
import { SeriesScreen } from './src/components/SeriesScreen';
import { TvRemotePanel } from './src/components/TvRemotePanel';
import { AutoSync, installCrashLog, type AutoSyncState } from './src/lib/auto-sync';
import { haptics } from './src/lib/haptics';
import { importFiles, importFolder, readLibrary, type Episode, type Series } from './src/lib/library';
import { fetchRemoteCatalog } from './src/lib/server';
import { findReachableAddress } from './src/lib/server-address';
import { localEpisodeKeys, onRemoteChange, scheduleSync, setSyncer, syncWith } from './src/lib/replica';
import { allProgress, applyReplicatedProgress, mergeProgress, progressFor, saveProgress, saveSettings, settings as savedSettings, type Progress } from './src/lib/storage';
import {
  DEFAULT_TV_SERVER_URL,
  normalizeTvServerUrl,
  TvSyncClient,
  type PipelineEvent,
  type ScanProgressInfo,
  type TvHttpStatus,
  type TvPlaybackState,
  type TvWsState,
  type WorkerStatusPayload,
} from './src/lib/tv-sync';
import { PhoneWorkerNode, type PhoneWorkerState } from './src/lib/worker-node';
import { colors, radius, space } from './src/theme';

// Write the cause of any crash to Documents/.anime-study/auto-sync-errors.log.
installCrashLog();

type AppMode = 'watch' | 'download' | 'pipelines';
type LibrarySource = 'server' | 'local';

function autoSyncLine(state: AutoSyncState) {
  const kept = state.kept ? `${state.kept} episode${state.kept === 1 ? '' : 's'} kept from the Mac` : 'Keeps your next episodes from the Mac';
  switch (state.status) {
    case 'checking': return `Auto sync · checking the Mac…`;
    case 'downloading': return `Auto sync · saving ${state.detail ?? ''}`;
    case 'waiting': return `Auto sync paused · ${state.detail ?? ''} · ${kept}`;
    case 'error': return `Auto sync · ${state.detail ?? 'error'}`;
    default: return `Auto sync · ${state.detail ? `${state.detail} · ` : ''}${kept}`;
  }
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
  const initialServerUrl = normalizeTvServerUrl(savedSettings().tvServerUrl || DEFAULT_TV_SERVER_URL);
  const [mode, setMode] = useState<AppMode>('watch');
  const [source, setSource] = useState<LibrarySource>('server');
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [serverDraft, setServerDraft] = useState(initialServerUrl);
  const [wsState, setWsState] = useState<TvWsState>('disconnected');
  const [httpStatus, setHttpStatus] = useState<TvHttpStatus>({ state: 'idle' });
  const [tvAutoplay, setTvAutoplay] = useState(true);
  const [tvState, setTvState] = useState<TvPlaybackState | null>(null);
  const [playOnPhoneOverride, setPlayOnPhoneOverride] = useState(false);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgressInfo>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusPayload | null>(null);
  const [phoneWorker, setPhoneWorker] = useState<PhoneWorkerState>({ running: false, progress: 0 });
  const [serverError, setServerError] = useState<string | null>(null);
  const [localScan, setLocalScan] = useState<LocalScanState>({ status: 'idle', seriesCount: 0, episodeCount: 0 });
  const [importState, setImportState] = useState<ImportPipelineState>({ status: 'idle' });
  const [library, setLibrary] = useState<Series[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [episodeKey, setEpisodeKey] = useState<string | null>(null);
  const [settings, setSettings] = useState(savedSettings);
  const [, setRevision] = useState(0);
  const refreshProgress = useCallback(() => setRevision(value => value + 1), []);
  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const libraryRef = useRef<Series[]>([]);
  libraryRef.current = library;
  const tvSyncRef = useRef<TvSyncClient | null>(null);
  const phoneWorkerRef = useRef<PhoneWorkerNode | null>(null);
  const autoSyncRef = useRef<AutoSync | null>(null);
  const kickAutoSync = useCallback(() => autoSyncRef.current?.kick(), []);
  const [autoSync, setAutoSync] = useState<AutoSyncState>({ status: 'idle', kept: 0, queued: 0 });
  const prevTvActiveRef = useRef(false);
  const lastPhoneSyncRef = useRef(0);

  const findLibraryEpisode = useCallback((seriesIdx: unknown, seriesName: unknown, episodeName: unknown) => {
    if (typeof episodeName !== 'string') return null;
    const list = libraryRef.current;
    const targetSeries =
      (typeof seriesIdx === 'number' ? list[seriesIdx] : undefined) ??
      (typeof seriesName === 'string' ? list.find(s => s.folder === seriesName || s.title === seriesName) : undefined);
    if (!targetSeries) return null;
    const targetEp = targetSeries.episodes.find(e => e.video === episodeName);
    if (!targetEp) return null;
    return { targetSeries, targetSeriesIdx: list.indexOf(targetSeries), targetEp };
  }, []);

  const handleTvState = useCallback((next: TvPlaybackState) => {
    setTvState(next);
    if (typeof next.autoplay === 'boolean') setTvAutoplay(next.autoplay);
    if (next.active !== prevTvActiveRef.current) {
      prevTvActiveRef.current = next.active;
      setPlayOnPhoneOverride(false);
    }
    if (next.active && next.episode && typeof next.position === 'number') {
      const match = findLibraryEpisode(next.series, next.seriesName, next.episode);
      if (match) {
        const existing = progressFor(match.targetEp.key);
        const dur = typeof next.duration === 'number' && next.duration > 0 ? next.duration : (existing?.duration ?? 0);
        const finished = Boolean(existing?.finished) || (dur > 0 && next.position >= dur - 5);
        if (!existing || Math.abs(existing.position - next.position) >= 1 || existing.duration !== dur || existing.finished !== finished) {
          saveProgress(match.targetEp.key, {
            position: finished ? 0 : next.position,
            duration: dur,
            watchedAt: Date.now(),
            finished,
          });
          refreshProgress();
        }
      }
    }
  }, [findLibraryEpisode, refreshProgress]);

  const scanLocal = useCallback((updateLibrary = true) => {
    setLocalScan(prev => ({ ...prev, status: 'scanning', error: undefined }));
    try {
      const localSeries = readLibrary();
      const episodeCount = localSeries.reduce((sum, s) => sum + s.episodes.length, 0);
      const lastScannedAt = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setLocalScan({
        status: 'ready',
        seriesCount: localSeries.length,
        episodeCount,
        lastScannedAt,
      });
      if (updateLibrary) {
        setLibrary(localSeries);
        setServerError(null);
      }
      tvSyncRef.current?.log('Local Scan', `${localSeries.length} series, ${episodeCount} episodes`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLocalScan(prev => ({ ...prev, status: 'error', error: msg }));
      console.warn('Could not read the library', error);
    }
  }, []);

  const loadRemote = useCallback(async (targetUrl?: string) => {
    const url = normalizeTvServerUrl(targetUrl ?? serverUrlRef.current);
    setHttpStatus({ state: 'checking' });
    try {
      const { series: remote, progress: remoteProgress, autoplay, tvState: remoteTvState, statusCode } = await fetchRemoteCatalog(url);
      setHttpStatus({ state: 'ok', statusCode });
      setTvAutoplay(autoplay);
      mergeProgress(remoteProgress);
      refreshProgress();
      if (remoteTvState) handleTvState(remoteTvState);
      if (sourceRef.current === 'server') {
        setLibrary(remote);
      }
      setServerError(null);
      tvSyncRef.current?.log('Catalog', `Loaded ${remote.length} series (HTTP ${statusCode})`);
    } catch (error) {
      // The Mac may just be on another address (Tailscale vs home network): switch if one answers.
      const alternative = await findReachableAddress(url).catch(() => null);
      if (alternative && alternative !== url) {
        setServerDraft(alternative);
        setServerUrl(alternative);
        serverUrlRef.current = alternative;
        saveSettings({ tvServerUrl: alternative });
        tvSyncRef.current?.log('Server', `Switched to ${alternative}`);
        tvSyncRef.current?.connect();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      setHttpStatus({ state: 'error', error: msg });
      if (sourceRef.current === 'server') {
        setServerError(msg);
      }
      tvSyncRef.current?.log('Error', `Catalog fetch failed: ${msg}`);
    }
  }, []);

  const scan = useCallback(() => {
    scheduleSync(0);
    autoSyncRef.current?.kick();
    if (sourceRef.current === 'server') {
      void loadRemote();
    } else {
      scanLocal(true);
    }
  }, [loadRemote, scanLocal]);

  // Master-master state with the Mac (src/lib/replica.ts): progress and OP/ED timings merge both ways.
  useEffect(() => {
    setSyncer(async () => {
      const result = await syncWith(normalizeTvServerUrl(serverUrlRef.current));
      if (result.sent || result.received) {
        tvSyncRef.current?.log('Replica', `Synced with Mac · sent ${result.sent} · received ${result.received}`);
      }
    });
    const unsubscribe = onRemoteChange((key, value) => {
      const parts = key.split('/');
      if (parts[0] !== 'ep' || parts.length < 4) return;
      const field = parts[parts.length - 1];
      const localKey = parts.slice(1, -1).join('/');
      if (field === 'progress' && value && typeof value === 'object') {
        let changed = false;
        for (const key of localEpisodeKeys(localKey)) {
          changed = applyReplicatedProgress(key, value as Partial<Progress>) || changed;
        }
        if (changed) refreshProgress();
      } else if (field === 'themes' && sourceRef.current !== 'server') {
        scanLocal(true);
      }
    });
    scheduleSync(0);
    return () => {
      unsubscribe();
      setSyncer(null);
    };
  }, [refreshProgress, scanLocal]);

  useEffect(() => {
    const client = new TvSyncClient(
      state => {
        setWsState(state);
        if (state === 'connected') scheduleSync(0);
      },
      setPipelineEvents,
      () => serverUrlRef.current,
      msg => {
        if (typeof msg.autoplay === 'boolean') {
          setTvAutoplay(msg.autoplay);
        }
        if (typeof msg.episode === 'string' && msg.progress && typeof msg.progress === 'object') {
          const p = msg.progress as Record<string, unknown>;
          if (typeof p.position === 'number' && typeof p.watchedAt === 'number' && typeof p.finished === 'boolean') {
            const match = findLibraryEpisode(msg.series, msg.seriesName, msg.episode);
            if (match) {
              const existing = progressFor(match.targetEp.key);
              const dur = typeof p.duration === 'number' && p.duration > 0 ? p.duration : (existing?.duration ?? 0);
              saveProgress(match.targetEp.key, {
                position: p.position,
                duration: dur,
                watchedAt: p.watchedAt,
                finished: p.finished,
              });
              refreshProgress();
            }
          }
        } else if (sourceRef.current === 'server' && typeof msg.autoplay !== 'boolean') {
          void loadRemote();
        }
      },
      setScanProgress,
      setHttpStatus,
      handleTvState,
      setWorkerStatus,
    );
    tvSyncRef.current = client;
    const worker = new PhoneWorkerNode(
      () => serverUrlRef.current,
      setPhoneWorker,
      (kind, detail) => client.log(kind, detail),
    );
    phoneWorkerRef.current = worker;
    const mirror = new AutoSync(
      () => serverUrlRef.current,
      setAutoSync,
      // New copies show up in Local Files right away; the counts update either way.
      () => scanLocal(sourceRef.current === 'local'),
      (kind, detail) => client.log(kind, detail),
    );
    autoSyncRef.current = mirror;
    client.connect();
    scanLocal(false);
    mirror.kick();
    return () => {
      mirror.stop();
      autoSyncRef.current = null;
      worker.stop();
      phoneWorkerRef.current = null;
      client.destroy();
      tvSyncRef.current = null;
    };
  }, [handleTvState, loadRemote, scanLocal]);

  useEffect(() => {
    scan();
    // Files dropped in through the Files app or Finder show up when the app comes back.
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') scan();
    });
    return () => subscription.remove();
  }, [scan, source, serverUrl]);

  const tvControlling = Boolean(tvState?.active) && source === 'server' && !playOnPhoneOverride;

  // Like the TV app: a wall of covers, then one series, then the episode on the whole screen.
  const series = library.find(item => item.folder === folder);
  const episode = series?.episodes.find(item => item.key === episodeKey);
  const fullscreen = !!episode && !tvControlling;
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

  const runImport = useCallback(async (task: () => Promise<string | null>, kindLabel: string) => {
    setImportState({ status: 'importing', detail: `Importing ${kindLabel}…` });
    tvSyncRef.current?.log('Import', `Starting ${kindLabel} import`);
    try {
      const name = await task();
      if (!name) {
        setImportState({ status: 'idle' });
        return;
      }
      setImportState({ status: 'done', detail: `Imported ${name}` });
      tvSyncRef.current?.log('Import', `Imported ${name}`);
      scanLocal(sourceRef.current === 'local');
      if (sourceRef.current === 'local') {
        setFolder(name);
        setEpisodeKey(null);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(msg)) {
        setImportState({ status: 'idle' });
        return;
      }
      setImportState({ status: 'error', detail: msg });
      tvSyncRef.current?.log('Error', `Import failed: ${msg}`);
      Alert.alert('Could not import', msg);
    }
  }, [scanLocal]);

  const pickSource = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Import downloads folder…', 'Import episode files…', 'Cancel'], cancelButtonIndex: 2, title: 'Add episodes' },
      choice => {
        if (choice === 0) void runImport(importFolder, 'folder');
        if (choice === 1) void runImport(importFiles, 'files');
      },
    );
  };

  const selectEpisode = (next: Episode) => {
    haptics.select();
    if (tvControlling && series) {
      tvSyncRef.current?.sendTvControl({ action: 'playEpisode', seriesName: series.folder, episode: next.video });
      return;
    }
    setEpisodeKey(next.key);
    if (source === 'server' && series) {
      void tvSyncRef.current?.pushSync({ playingFolder: series.folder, playingEpisode: next.video });
    }
  };

  const step = (direction: -1 | 1) => {
    const next = series?.episodes[index + direction];
    if (next) selectEpisode(next);
  };

  const toggleEpisodeWatched = useCallback((targetEp: Episode, targetSeries?: Series) => {
    haptics.select();
    const existing = progressFor(targetEp.key);
    const nextFinished = !existing?.finished;
    const nextProgress: Progress = {
      position: 0,
      duration: existing?.duration ?? 0,
      watchedAt: Date.now(),
      finished: nextFinished,
    };
    saveProgress(targetEp.key, nextProgress);
    refreshProgress();
    if (sourceRef.current === 'server') {
      const activeSeries = targetSeries ?? series;
      const seriesIdx = activeSeries ? libraryRef.current.indexOf(activeSeries) : -1;
      void tvSyncRef.current?.pushSync({
        type: 'sync',
        ...(seriesIdx >= 0 ? { series: seriesIdx } : {}),
        ...(activeSeries ? { seriesName: activeSeries.folder } : {}),
        episode: targetEp.video,
        progress: nextProgress,
      });
    }
  }, [refreshProgress, series]);

  const handlePhoneProgress = useCallback(() => {
    refreshProgress();
    if (sourceRef.current !== 'server' || !series || !episode) return;
    const saved = progressFor(episode.key);
    if (!saved) return;
    const now = Date.now();
    if (!saved.finished && now - lastPhoneSyncRef.current < 5000) return;
    lastPhoneSyncRef.current = now;
    const seriesIdx = libraryRef.current.indexOf(series);
    void tvSyncRef.current?.pushSync({
      type: 'sync',
      ...(seriesIdx >= 0 ? { series: seriesIdx } : {}),
      seriesName: series.folder,
      episode: episode.video,
      progress: saved,
    });
  }, [episode, refreshProgress, series]);

  const applyServerUrl = (nextRaw: string) => {
    const normalized = normalizeTvServerUrl(nextRaw);
    setServerDraft(normalized);
    setServerUrl(normalized);
    serverUrlRef.current = normalized;
    saveSettings({ tvServerUrl: normalized });
    tvSyncRef.current?.log('Server', `Switching to ${normalized}`);
    tvSyncRef.current?.connect();
    if (source === 'server') {
      void loadRemote(normalized);
    }
  };

  const wsBadgeColor =
    wsState === 'connected' ? '#34d399' : wsState === 'connecting' ? colors.accent : '#f87171';

  const header = (
    <View style={[styles.header, tvControlling && styles.headerCompact]}>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>Anime Study</Text>
            <View style={[styles.wsDot, { backgroundColor: wsBadgeColor }]} />
            <Text style={styles.wsText}>{wsState}</Text>
          </View>
          {!tvControlling && (
            <>
              <Text style={styles.title} numberOfLines={2}>
                {mode === 'pipelines' ? 'Pipelines' : mode === 'download' ? 'Download' : 'Library'}
              </Text>
            </>
          )}
        </View>
        <View style={styles.headerActions}>
          <View style={styles.modeSwitch}>
            {(['watch', 'download', 'pipelines'] as const).map(item => {
              const active = mode === item;
              return (
                <Pressable
                  key={item}
                  onPress={() => { haptics.select(); setMode(item); }}
                  style={[styles.modePill, active && styles.modePillActive]}
                >
                  <Text style={[styles.modePillText, active && styles.modePillTextActive]}>
                    {item === 'watch' ? 'Watch' : item === 'download' ? 'Download' : 'Pipelines'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {mode === 'watch' && source === 'local' && (
            <Pressable accessibilityRole="button" accessibilityLabel="Add episodes" onPress={pickSource} hitSlop={10} style={styles.addButton}>
              <SymbolView name="plus" size={20} tintColor={colors.accent} />
            </Pressable>
          )}
        </View>
      </View>
      {mode === 'watch' && !series && (
        <>
          {!tvControlling && (
            <View style={styles.sourceRow}>
              {(['server', 'local'] as const).map(item => {
                const active = source === item;
                return (
                  <Pressable
                    key={item}
                    onPress={() => {
                      haptics.select();
                      setSource(item);
                      setFolder(null);
                      setEpisodeKey(null);
                    }}
                    style={[styles.sourceChip, active && styles.sourceChipActive]}
                  >
                    <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>
                      {item === 'server' ? 'Mac Server' : 'Local Files'}
                    </Text>
                  </Pressable>
                );
              })}
              {source === 'server' && (
                <Pressable onPress={() => { haptics.select(); void loadRemote(); }} style={styles.refreshChip}>
                  <Text style={styles.refreshChipText}>Refresh</Text>
                </Pressable>
              )}
            </View>
          )}
          {!tvControlling && source === 'local' && (
            <Text style={styles.autoSync} numberOfLines={2}>{autoSyncLine(autoSync)}</Text>
          )}
        </>
      )}
    </View>
  );

  const player = tvControlling && tvState ? (
    <TvRemotePanel
      tvState={tvState}
      tvAutoplay={tvAutoplay}
      onCommand={command => tvSyncRef.current?.sendTvControl(command)}
      onPlayOnPhone={() => setPlayOnPhoneOverride(true)}
    />
  ) : null;

  const fullscreenPlayer = episode && (
    <View style={{ flex: 1 }}>
      <Player
        episode={episode}
        neighbours={neighbours}
        fullscreen
        autoPlay
        autoSkip={settings.autoSkip}
        subtitlesOn={settings.subtitles}
        // The exit button goes back to the series; a double tap in the middle does nothing here.
        onToggleFullscreen={value => { if (value === false) setEpisodeKey(null); }}
        onToggleSubtitles={() => updateSettings({ subtitles: !settings.subtitles })}
        onStep={direction => step(direction)}
        hasPrevious={index > 0}
        hasNext={!!series && index < series.episodes.length - 1}
        onProgress={handlePhoneProgress}
      />
    </View>
  );

  const empty = source === 'server' ? (
    <View style={styles.empty}>
      <SymbolView name="wifi.slash" size={48} tintColor={colors.textTertiary} />
      <Text style={styles.emptyTitle}>No Mac server catalog</Text>
      <Text style={styles.emptyText}>
        {serverError
          ? `Could not reach ${serverUrl}\n(${serverError})`
          : `Waiting for catalog from ${serverUrl}.`}
      </Text>
      <View style={styles.emptyActions}>
        <Pressable onPress={() => { haptics.select(); void loadRemote(); }} style={styles.emptyButton}>
          <Text style={styles.emptyButtonText}>Retry</Text>
        </Pressable>
        <Pressable
          onPress={() => { haptics.select(); setSource('local'); }}
          style={[styles.emptyButton, styles.emptySecondaryButton]}
        >
          <Text style={styles.emptySecondaryButtonText}>Use Local Files</Text>
        </Pressable>
      </View>
    </View>
  ) : (
    <View style={styles.empty}>
      <SymbolView name="film.stack" size={48} tintColor={colors.textTertiary} />
      <Text style={styles.emptyTitle}>No episodes yet</Text>
      <Text style={styles.emptyText}>
        Import a downloads folder, or copy one into Files › On My {Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone'} › Anime Study.
        Episodes pair with .ass or .srt subtitles that share their name.
      </Text>
      <Pressable onPress={pickSource} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Add episodes</Text></Pressable>
    </View>
  );

  const pipelinesScreen = (
    <PipelinesView
      serverDraft={serverDraft}
      onChangeServerDraft={setServerDraft}
      onApplyServerUrl={applyServerUrl}
      onFetchCatalog={() => { void loadRemote(); }}
      wsState={wsState}
      httpStatus={httpStatus}
      serverError={serverError}
      tvAutoplay={tvAutoplay}
      onToggleTvAutoplay={nextAutoplay => {
        setTvAutoplay(nextAutoplay);
        void tvSyncRef.current?.pushSync({ autoplay: nextAutoplay });
      }}
      scanProgress={scanProgress}
      localScan={localScan}
      onRescanLocal={() => scanLocal(source === 'local')}
      importState={importState}
      onImportFolder={() => { void runImport(importFolder, 'folder'); }}
      onImportFiles={() => { void runImport(importFiles, 'files'); }}
      coverageSeries={library}
      pipelineEvents={pipelineEvents}
      onClearEvents={() => tvSyncRef.current?.clearEvents()}
      workerStatus={workerStatus}
      phoneWorker={phoneWorker}
      onTogglePhoneWorker={() => {
        const worker = phoneWorkerRef.current;
        if (!worker) return;
        if (worker.isRunning()) worker.stop();
        else worker.start();
      }}
      onRefreshWorkerStatus={() => { void tvSyncRef.current?.fetchWorkerStatus(); }}
      onRetryQuarantined={target => { void tvSyncRef.current?.retryWorkerEpisodes(target); }}
    />
  );

  const seriesScreen = series && (
    <SeriesScreen
      series={series}
      progress={allProgress()}
      width={width}
      autoSkip={settings.autoSkip}
      onAutoSkip={value => updateSettings({ autoSkip: value })}
      onBack={() => { setFolder(null); setEpisodeKey(null); }}
      onPlay={selectEpisode}
      onToggleWatched={ep => toggleEpisodeWatched(ep, series)}
      extra={player}
    />
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={fullscreen} />
      <SafeAreaView style={styles.root} edges={fullscreen ? [] : ['top', 'left', 'right']}>
        {mode === 'pipelines' ? (
          <View style={{ flex: 1 }}>
            {header}
            {pipelinesScreen}
          </View>
        ) : mode === 'download' ? (
          <View style={{ flex: 1 }}>
            {header}
            <DownloadView serverUrl={serverUrl} onMacProgress={kickAutoSync} />
          </View>
        ) : fullscreenPlayer ? (
          fullscreenPlayer
        ) : seriesScreen ? (
          <View style={{ flex: 1 }}>{header}{seriesScreen}</View>
        ) : library.length ? (
          <View style={{ flex: 1 }}>
            <SeriesGallery
              series={library}
              progress={allProgress()}
              width={width}
              header={header}
              onOpen={item => { haptics.select(); setFolder(item.folder); setEpisodeKey(null); }}
            />
          </View>
        ) : (
          <View style={{ flex: 1 }}>{header}{empty}</View>
        )}
      </SafeAreaView>
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
  headerCompact: { paddingBottom: space.s, gap: space.s },
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
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.s, marginTop: space.s },
  emptySecondaryButton: { backgroundColor: colors.surfaceRaised },
  emptySecondaryButtonText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wsDot: { width: 8, height: 8, borderRadius: 4 },
  wsText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  modeSwitch: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, padding: 3 },
  modePill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  modePillActive: { backgroundColor: colors.accent },
  modePillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  modePillTextActive: { color: colors.background },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  autoSync: { color: colors.textSecondary, fontSize: 13 },
  sourceChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised },
  sourceChipActive: { backgroundColor: colors.accentMuted },
  sourceChipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  sourceChipTextActive: { color: colors.accent },
  refreshChip: { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surface },
  refreshChipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  tvBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.accentMuted, borderRadius: radius.medium, paddingHorizontal: space.m, paddingVertical: space.s },
  tvBannerDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#34d399' },
  tvBannerText: { color: colors.accent, fontSize: 13, fontWeight: '600', flex: 1 },
});
