import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { haptics } from '../lib/haptics';
import * as remote from '../lib/remote';
import { colors, radius, space } from '../theme';

type Props = { visible: boolean; onClose: () => void; onLibraryChanged: () => void };
type Job = { series: remote.RemoteSeries; episode: remote.RemoteEpisode };
const jobKey = (job: Job) => `${job.series.folder}/${job.episode.name}`;

function ago(ms?: number) {
  if (!ms) return 'never';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(ms).toLocaleDateString();
}

function statusLine(status: remote.SyncStatus) {
  const waiting = status.unsent ? ` · ${status.unsent} change${status.unsent === 1 ? '' : 's'} waiting` : '';
  switch (status.state) {
    case 'unpaired': return 'Not connected. Everything on this iPhone still works.';
    case 'syncing': return 'Syncing…';
    case 'offline': return `Mac not reachable, playing from this iPhone${waiting}`;
    default: return `Synced ${ago(status.lastSync)}${waiting}`;
  }
}

export function MacLibrary({ visible, onClose, onLibraryChanged }: Props) {
  const [status, setStatus] = useState(remote.syncStatus());
  const [address, setAddress] = useState(remote.serverUrl() ?? '');
  const [connecting, setConnecting] = useState(false);
  const [series, setSeries] = useState<remote.RemoteSeries[]>(remote.cachedCatalog());
  const [open, setOpen] = useState<string | null>(null);
  const [queue, setQueue] = useState<Job[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [, setRevision] = useState(0);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  // Held in a ref: the parent passes a new function on every render, and effects keyed on it
  // would re-run (and re-sync) each time the sync status re-renders the parent.
  const libraryChanged = useRef(onLibraryChanged);
  libraryChanged.current = onLibraryChanged;

  useEffect(() => remote.onStatus(setStatus), []);

  const refresh = useCallback(async () => {
    if (!remote.serverUrl()) return;
    try { setSeries(await remote.fetchCatalog()); } catch { /* The cached list stays. */ }
    const changed = await remote.sync(true);
    if (changed.length) libraryChanged.current();
  }, []);

  // Once each time the sheet opens.
  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);

  // One download at a time keeps the Wi-Fi and the phone cool.
  useEffect(() => {
    if (running.current || !queue.length) return;
    running.current = true;
    const job = queue[0];
    const controller = new AbortController();
    abort.current = controller;
    let shown = 0;
    void remote.download(job.series, job.episode, ({ key, written, total }) => {
      if (Date.now() - shown < 500) return;
      shown = Date.now();
      setProgress(current => ({ ...current, [key]: total ? written / total : 0 }));
    }, controller.signal)
      .then(() => { haptics.select(); libraryChanged.current(); })
      .catch(error => {
        if (!controller.signal.aborted) Alert.alert('Download stopped', `${job.episode.name}\n${String(error?.message ?? error)}`);
      })
      .finally(() => {
        running.current = false;
        abort.current = null;
        setProgress(current => { const next = { ...current }; delete next[jobKey(job)]; return next; });
        setQueue(current => current.filter(item => jobKey(item) !== jobKey(job)));
      });
  }, [queue]);

  const connect = async () => {
    setConnecting(true);
    try {
      await remote.pair(address);
      setSeries(remote.cachedCatalog());
      haptics.select();
    } catch (error) {
      Alert.alert('Could not reach the Mac', `${String((error as Error)?.message ?? error)}\n\nCheck that the Mac and this iPhone are on the same Wi-Fi and the TV server is running.`);
    } finally {
      setConnecting(false);
    }
  };

  const enqueue = (jobs: Job[]) => {
    const waiting = new Set(queue.map(jobKey));
    const fresh = jobs.filter(job => !waiting.has(jobKey(job)) && !remote.isDownloaded(job.series, job.episode));
    if (fresh.length) setQueue(current => [...current, ...fresh]);
  };

  const cancelAll = () => {
    setQueue(current => current.slice(0, 1));
    abort.current?.abort();
  };

  const remove = (job: Job) => {
    Alert.alert('Remove from this iPhone?', job.episode.name, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { remote.removeDownload(job.series, job.episode); setRevision(n => n + 1); libraryChanged.current(); } },
    ]);
  };

  const paired = status.state !== 'unpaired';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.top}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Mac library</Text>
            <Text style={styles.status}>{statusLine(status)}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10}><Text style={styles.done}>Done</Text></Pressable>
        </View>

        {!paired ? (
          <View style={styles.pair}>
            <Text style={styles.help}>
              Enter the address the TV server shows on the Mac, like http://192.168.1.10:46158/…/. Episodes you
              download stay on this iPhone, and progress and skip timings sync whenever the Mac is reachable.
            </Text>
            <TextInput
              value={address}
              onChangeText={setAddress}
              placeholder="http://192.168.1.10:46158/token/"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={connect}
              style={styles.input}
            />
            <Pressable onPress={connect} disabled={connecting || !address.trim()} style={[styles.primary, (connecting || !address.trim()) && { opacity: 0.5 }]}>
              {connecting ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>Connect</Text>}
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={series}
            keyExtractor={item => item.id || item.folder}
            contentContainerStyle={{ paddingBottom: space.xl }}
            ListHeaderComponent={queue.length ? (
              <View style={styles.queue}>
                <Text style={styles.queueText}>Downloading {queue.length} episode{queue.length === 1 ? '' : 's'}</Text>
                <Pressable onPress={cancelAll} hitSlop={8}><Text style={styles.link}>Stop</Text></Pressable>
              </View>
            ) : undefined}
            ListEmptyComponent={<Text style={styles.help}>The Mac hasn't shared any series yet. Pull them into its downloads folder and come back.</Text>}
            renderItem={({ item }) => {
              const jobs = item.episodes.map(episode => ({ series: item, episode }));
              const local = jobs.filter(job => remote.isDownloaded(job.series, job.episode)).length;
              const expanded = open === item.folder;
              return (
                <View style={styles.series}>
                  <Pressable onPress={() => setOpen(expanded ? null : item.folder)} style={styles.seriesRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.seriesTitle} numberOfLines={2}>{item.title}</Text>
                      <Text style={styles.meta}>{local} of {item.episodes.length} on this iPhone</Text>
                    </View>
                    {local < item.episodes.length && (
                      <Pressable onPress={() => enqueue(jobs)} hitSlop={8} style={styles.small}>
                        <Text style={styles.smallText}>Download all</Text>
                      </Pressable>
                    )}
                    <SymbolView name={expanded ? 'chevron.up' : 'chevron.down'} size={14} tintColor={colors.textTertiary} />
                  </Pressable>
                  {expanded && jobs.map(job => {
                    const key = jobKey(job);
                    const here = remote.isDownloaded(job.series, job.episode);
                    const queued = queue.some(entry => jobKey(entry) === key);
                    const share = progress[key];
                    return (
                      <View key={key} style={styles.episode}>
                        <Text style={styles.episodeName} numberOfLines={1}>{job.episode.name}</Text>
                        {here ? (
                          <Pressable onPress={() => remove(job)} hitSlop={8}><SymbolView name="checkmark.circle.fill" size={20} tintColor={colors.accent} /></Pressable>
                        ) : queued ? (
                          <Text style={styles.meta}>{share !== undefined ? `${Math.round(share * 100)}%` : 'Waiting'}</Text>
                        ) : (
                          <Pressable onPress={() => enqueue([job])} hitSlop={8}><SymbolView name="arrow.down.circle" size={20} tintColor={colors.text} /></Pressable>
                        )}
                      </View>
                    );
                  })}
                </View>
              );
            }}
            ListFooterComponent={(
              <Pressable onPress={() => { remote.unpair(); setSeries([]); }} style={styles.disconnect}>
                <Text style={styles.link}>Disconnect from this Mac</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space.l, paddingTop: space.l },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m, marginBottom: space.l },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  status: { color: colors.textSecondary, fontSize: 14, marginTop: 4 },
  done: { color: colors.accent, fontSize: 17, fontWeight: '600' },
  pair: { gap: space.m },
  help: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  input: { backgroundColor: colors.surface, color: colors.text, borderRadius: radius.medium, paddingHorizontal: space.l, paddingVertical: space.m, fontSize: 16 },
  primary: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: colors.background, fontSize: 16, fontWeight: '700' },
  queue: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.accentMuted, borderRadius: radius.medium, padding: space.m, marginBottom: space.m },
  queueText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  series: { backgroundColor: colors.surface, borderRadius: radius.medium, marginBottom: space.s, overflow: 'hidden' },
  seriesRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.l },
  seriesTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.textTertiary, fontSize: 13, marginTop: 2 },
  small: { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  smallText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  episode: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  episodeName: { color: colors.text, fontSize: 14, flex: 1 },
  disconnect: { alignItems: 'center', paddingVertical: space.xl },
});
