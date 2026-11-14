import { SymbolView } from 'expo-symbols';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { WebView as WebViewClass, type WebViewProps } from 'react-native-webview';

import { haptics } from '../lib/haptics';
import { ANIME365_HOME, AUTO_FALLBACK, planFromBrowser, resolveSeriesTeam, seriesFiles, seriesPageFor, type SeriesPlan } from '../lib/anime365';
import type { DownloadsState, SeriesDownloader } from '../lib/series-downloads';
import { colors, radius, space } from '../theme';

// react-native-webview's class typings don't match React 19's; this is the same component, typed.
type WebViewHandle = { goBack(): void; injectJavaScript(script: string): void };
const WebView = WebViewClass as unknown as React.ComponentType<WebViewProps & React.RefAttributes<WebViewHandle>>;

type Props = { downloader: SeriesDownloader; state: DownloadsState };

function size(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Browse Anime365, pick a series and its episodes, and download them into this device's library. */
export function DownloadView({ downloader, state }: Props) {
  const web = useRef<WebViewHandle>(null);
  const [address, setAddress] = useState(ANIME365_HOME);
  const [canGoBack, setCanGoBack] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const seriesPage = seriesPageFor(address);

  const folder = useMemo(() => {
    if (!plan) return '';
    try { return seriesFiles(plan, plan.episodes.map(episode => episode.page)).folder; } catch { return ''; }
  }, [plan]);
  const saved = (page: string) => {
    if (!plan || !folder) return false;
    const index = plan.episodes.findIndex(episode => episode.page === page);
    const video = plan.episodes[index]?.video?.url.match(/\/(\d+)\/?$/)?.[1];
    return !!video && downloader.has(folder, `Episode ${String(index + 1).padStart(3, '0')} - ${video}.mp4`);
  };

  const choose = (next: SeriesPlan) => {
    setPlan(next);
    setSelected(new Set(next.episodes.filter(episode => episode.video && !saved(episode.page)).map(episode => episode.page)));
  };

  async function readSeries() {
    if (!seriesPage || busy) return;
    haptics.select();
    setBusy(true);
    setStatus('Reading the series…');
    try {
      const next = await planFromBrowser(address, (checked, total) => setStatus(`Checking episodes (${checked} of ${total})`));
      choose(next);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not read this series.');
    } finally {
      setBusy(false);
    }
  }

  async function applyTeam(team: string) {
    if (!plan || busy) return;
    setBusy(true);
    setStatus('Checking other teams…');
    try {
      choose(await resolveSeriesTeam(plan, team, (checked, total) => setStatus(`Checking other teams (${checked} of ${total})`)));
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not check other teams.');
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (!plan || !selected.size) return;
    try {
      const added = downloader.add(plan, [...selected]);
      haptics.skipped();
      setStatus(added ? `Downloading ${selected.size} episode${selected.size === 1 ? '' : 's'}. They appear in Local Files as each one finishes.` : 'Those episodes are already here.');
      setPlan(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not start the download.');
    }
  }

  const missingTeams = !!plan?.episodes.some(episode => episode.variants?.length && !episode.video);
  const teams = useMemo(() => {
    const counts = new Map<string, number>();
    for (const episode of plan?.episodes ?? []) for (const variant of episode.variants ?? []) counts.set(variant.team, (counts.get(variant.team) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([team]) => team);
  }, [plan]);
  const available = plan?.episodes.filter(episode => episode.video) ?? [];

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Pressable disabled={!canGoBack} onPress={() => web.current?.goBack()} hitSlop={10} style={styles.iconButton}>
          <SymbolView name="chevron.left" size={18} tintColor={canGoBack ? colors.accent : colors.textTertiary} />
        </Pressable>
        <Pressable onPress={() => web.current?.injectJavaScript(`location.href=${JSON.stringify(ANIME365_HOME)};true;`)} hitSlop={10} style={styles.iconButton}>
          <SymbolView name="house" size={18} tintColor={colors.accent} />
        </Pressable>
        <Text style={styles.address} numberOfLines={1}>{address.replace(/^https:\/\//, '')}</Text>
        <Pressable disabled={!seriesPage || busy} onPress={() => { void readSeries(); }} style={[styles.primary, (!seriesPage || busy) && styles.disabled]}>
          {busy ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>Download series</Text>}
        </Pressable>
      </View>
      {!!status && <Text style={styles.status}>{status}</Text>}

      <View style={styles.body}>
        <WebView
          ref={web}
          source={{ uri: ANIME365_HOME }}
          style={[styles.web, plan && styles.hidden]}
          sharedCookiesEnabled
          allowsBackForwardNavigationGestures
          onNavigationStateChange={nav => { setAddress(nav.url); setCanGoBack(nav.canGoBack); }}
        />
        {plan && (
          <View style={styles.plan}>
            <View style={styles.planHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.planTitle} numberOfLines={2}>{plan.title}</Text>
                <Text style={styles.planMeta}>{plan.primaryTeam || plan.edition} · {available.length} of {plan.episodes.length} episodes available</Text>
              </View>
              <Pressable onPress={() => setPlan(null)} hitSlop={10} style={styles.iconButton}>
                <SymbolView name="xmark" size={18} tintColor={colors.textSecondary} />
              </Pressable>
            </View>
            {missingTeams && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Text style={styles.chipLabel}>Fill gaps with</Text>
                {[AUTO_FALLBACK, ...teams].map(team => (
                  <Pressable key={team} onPress={() => { void applyTeam(team); }} style={styles.chip}>
                    <Text style={styles.chipText}>{team === AUTO_FALLBACK ? 'Most common team' : team}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <ScrollView style={{ flex: 1 }}>
              {plan.episodes.map(episode => {
                const here = saved(episode.page);
                const on = selected.has(episode.page);
                return (
                  <View key={episode.page} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, !episode.video && styles.muted]} numberOfLines={1}>{episode.label}</Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {here ? 'Already on this device' : !episode.video ? 'Not available in this edition' : [episode.team, episode.video.height && `${episode.video.height}p`, episode.subtitle && 'subtitles'].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Switch
                      value={on}
                      disabled={!episode.video || here}
                      onValueChange={value => setSelected(prev => {
                        const next = new Set(prev);
                        if (value) next.add(episode.page); else next.delete(episode.page);
                        return next;
                      })}
                    />
                  </View>
                );
              })}
            </ScrollView>
            <Pressable disabled={!selected.size} onPress={start} style={[styles.primary, styles.startButton, !selected.size && styles.disabled]}>
              <Text style={styles.primaryText}>Download {selected.size} episode{selected.size === 1 ? '' : 's'}</Text>
            </Pressable>
          </View>
        )}
      </View>

      {state.total > 0 && (
        <View style={styles.queue}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {state.status === 'downloading' && state.current
                ? `${state.current.series} · ${state.current.name}`
                : state.status === 'paused' ? 'Paused'
                : state.status === 'waiting' ? `Waiting: ${state.detail}`
                : state.status === 'error' ? `Stopped: ${state.detail}`
                : 'Downloads finished'}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {state.done} of {state.total} files{state.failed ? ` · ${state.failed} failed` : ''}
              {state.status === 'downloading' && state.current && state.current.totalBytes > 0
                ? ` · ${size(state.current.bytes)} of ${size(state.current.totalBytes)}` : ''}
            </Text>
            {state.status === 'downloading' && state.current && state.current.totalBytes > 0 && (
              <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.min(100, (state.current.bytes / state.current.totalBytes) * 100)}%` }]} /></View>
            )}
          </View>
          {state.failed > 0 && (
            <Pressable onPress={() => downloader.retryFailed()} style={styles.chip}><Text style={styles.chipText}>Retry</Text></Pressable>
          )}
          {state.status === 'downloading' && (
            <Pressable onPress={() => downloader.pause()} style={styles.chip}><Text style={styles.chipText}>Pause</Text></Pressable>
          )}
          {state.status === 'paused' && (
            <Pressable onPress={() => downloader.resume()} style={styles.chip}><Text style={styles.chipText}>Resume</Text></Pressable>
          )}
          {(state.status === 'idle' || state.status === 'error') && (
            <Pressable onPress={() => downloader.clearFinished()} style={styles.chip}><Text style={styles.chipText}>Clear</Text></Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.l, paddingBottom: space.l, gap: space.s },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  iconButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  address: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  primary: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: space.l, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.background, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.4 },
  status: { color: colors.textSecondary, fontSize: 13 },
  body: { flex: 1, borderRadius: radius.medium, overflow: 'hidden', backgroundColor: colors.surface },
  web: { flex: 1, backgroundColor: colors.surface },
  hidden: { display: 'none' },
  plan: { flex: 1, padding: space.l, gap: space.m },
  planHeader: { flexDirection: 'row', gap: space.m, alignItems: 'flex-start' },
  planTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  planMeta: { color: colors.textSecondary, fontSize: 13, marginTop: space.xs },
  chips: { gap: space.s, alignItems: 'center' },
  chipLabel: { color: colors.textTertiary, fontSize: 13 },
  chip: { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: space.m, paddingVertical: space.s },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  muted: { color: colors.textTertiary },
  startButton: { minHeight: 48 },
  queue: { flexDirection: 'row', alignItems: 'center', gap: space.s, backgroundColor: colors.surface, borderRadius: radius.medium, padding: space.m },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, marginTop: space.s, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent },
});
