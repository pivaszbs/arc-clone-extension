import { SymbolView } from 'expo-symbols';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView as WebViewClass, type WebViewProps } from 'react-native-webview';

import { haptics } from '../lib/haptics';
import { listMacDownloads, requestMacDownload, seriesLinkFor, type MacDownload } from '../lib/mac-downloads';
import { colors, radius, space } from '../theme';

// react-native-webview's class typings don't match React 19's; this is the same component, typed.
type WebViewHandle = { goBack(): void; injectJavaScript(script: string): void };
const WebView = WebViewClass as unknown as React.ComponentType<WebViewProps & React.RefAttributes<WebViewHandle>>;

const HOME = 'https://smotret-anime.com/';
const POLL_MS = 5000;

type Props = {
  serverUrl: string;
  /** Called when the Mac finishes more episodes, so the library shows them. */
  onMacProgress: () => void;
};

const stateLabel: Record<MacDownload['state'], string> = {
  pending: 'Waiting',
  planning: 'Reading series',
  downloading: 'Downloading',
  done: 'Done',
  failed: 'Failed',
};

/**
 * Browse Anime365 and send a series to the Mac. Chrome there downloads it into the library;
 * its episodes then appear under Mac Server, with Download buttons.
 */
export function DownloadView({ serverUrl, onMacProgress }: Props) {
  const web = useRef<WebViewHandle>(null);
  const [address, setAddress] = useState(HOME);
  const [pageTitle, setPageTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [requests, setRequests] = useState<MacDownload[]>([]);
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  const finished = useRef<number | null>(null);
  const link = seriesLinkFor(address);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await listMacDownloads(serverUrl);
        if (stopped) return;
        setRequests(next);
        const done = next.reduce((sum, item) => sum + (item.done ?? 0) + (item.state === 'done' ? 1 : 0), 0);
        if (finished.current !== null && done > finished.current) onMacProgress();
        finished.current = done;
      } catch (error) {
        if (!stopped) setStatus(error instanceof Error && /answered/.test(error.message) ? error.message : 'The Mac is not answering. Is npm run mac:up running?');
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [serverUrl, onMacProgress]);

  async function send() {
    if (!link || sending) return;
    haptics.select();
    setSending(true);
    try {
      const title = pageTitle.replace(/\s*[-—|]\s*Anime ?365.*$/i, '').trim();
      const request = await requestMacDownload(serverUrl, link, title);
      setRequests(prev => [...prev.filter(item => item.id !== request.id), request]);
      setStatus('Sent to the Mac. Chrome there downloads it; the episodes appear under Mac Server as they finish.');
      haptics.skipped();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not reach the Mac.');
    } finally {
      setSending(false);
    }
  }

  const recent = [...requests].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 8);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Pressable disabled={!canGoBack} onPress={() => web.current?.goBack()} hitSlop={10} style={styles.iconButton}>
          <SymbolView name="chevron.left" size={18} tintColor={canGoBack ? colors.accent : colors.textTertiary} />
        </Pressable>
        <Pressable onPress={() => web.current?.injectJavaScript(`location.href=${JSON.stringify(HOME)};true;`)} hitSlop={10} style={styles.iconButton}>
          <SymbolView name="house" size={18} tintColor={colors.accent} />
        </Pressable>
        <Text style={styles.address} numberOfLines={1}>{address.replace(/^https:\/\//, '')}</Text>
        <Pressable disabled={!link || sending} onPress={() => { void send(); }} style={[styles.primary, (!link || sending) && styles.disabled]}>
          {sending ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>Download on Mac</Text>}
        </Pressable>
      </View>
      {!!status && <Text style={styles.status}>{status}</Text>}

      <View style={styles.body}>
        <WebView
          ref={web}
          source={{ uri: HOME }}
          style={styles.web}
          allowsBackForwardNavigationGestures
          onNavigationStateChange={nav => { setAddress(nav.url); setPageTitle(nav.title ?? ''); setCanGoBack(nav.canGoBack); }}
        />
      </View>

      {recent.length > 0 && (
        <ScrollView style={styles.queue} contentContainerStyle={{ gap: space.s }}>
          {recent.map(item => (
            <View key={item.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title || item.url.replace(/^https:\/\/[^/]+\/catalog\//, '')}</Text>
                <Text style={[styles.rowMeta, item.state === 'failed' && styles.failed]} numberOfLines={2}>
                  {stateLabel[item.state] ?? item.state}{item.detail ? ` · ${item.detail}` : ''}
                </Text>
                {item.state === 'downloading' && !!item.total && (
                  <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.min(100, ((item.done ?? 0) / item.total) * 100)}%` }]} /></View>
                )}
              </View>
              {item.from ? <Text style={styles.from}>{item.from}</Text> : null}
            </View>
          ))}
        </ScrollView>
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
  queue: { maxHeight: 220, flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.medium, padding: space.m },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  failed: { color: colors.accent },
  from: { color: colors.textTertiary, fontSize: 12 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, marginTop: space.s, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent },
});
