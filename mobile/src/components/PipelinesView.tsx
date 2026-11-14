import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { haptics } from '../lib/haptics';
import type { Series } from '../lib/library';
import type { PipelineEvent, ScanProgressInfo, TvHttpStatus, TvWsState, WorkerStatusPayload } from '../lib/tv-sync';
import { DEFAULT_TV_SERVER_URL } from '../lib/tv-sync';
import type { PhoneWorkerState } from '../lib/worker-node';
import { colors, radius, space } from '../theme';

export type LocalScanState = {
  status: 'idle' | 'scanning' | 'ready' | 'error';
  seriesCount: number;
  episodeCount: number;
  lastScannedAt?: string;
  error?: string;
};

export type ImportPipelineState = {
  status: 'idle' | 'importing' | 'done' | 'error';
  detail?: string;
};

type Props = {
  serverDraft: string;
  onChangeServerDraft: (value: string) => void;
  onApplyServerUrl: (url: string) => void;
  onFetchCatalog: () => void;
  wsState: TvWsState;
  httpStatus: TvHttpStatus;
  serverError: string | null;
  tvAutoplay: boolean;
  onToggleTvAutoplay: (nextAutoplay: boolean) => void;
  scanProgress: ScanProgressInfo;
  localScan: LocalScanState;
  onRescanLocal: () => void;
  importState: ImportPipelineState;
  onImportFolder: () => void;
  onImportFiles: () => void;
  coverageSeries: Series[];
  pipelineEvents: PipelineEvent[];
  onClearEvents: () => void;
  workerStatus: WorkerStatusPayload | null;
  phoneWorker: PhoneWorkerState;
  onTogglePhoneWorker: () => void;
  onRefreshWorkerStatus: () => void;
  onRetryQuarantined: (target: { seriesName: string; episode: string } | { all: true }) => void;
};

export function PipelinesView({
  serverDraft,
  onChangeServerDraft,
  onApplyServerUrl,
  onFetchCatalog,
  wsState,
  httpStatus,
  serverError,
  tvAutoplay,
  onToggleTvAutoplay,
  scanProgress,
  localScan,
  onRescanLocal,
  importState,
  onImportFolder,
  onImportFiles,
  coverageSeries,
  pipelineEvents,
  onClearEvents,
  workerStatus,
  phoneWorker,
  onTogglePhoneWorker,
  onRefreshWorkerStatus,
  onRetryQuarantined,
}: Props) {
  const [expandedSeries, setExpandedSeries] = useState<Record<string, boolean>>({});

  const wsBadgeColor =
    wsState === 'connected' ? '#34d399' : wsState === 'connecting' ? colors.accent : '#f87171';
  const httpBadgeColor =
    httpStatus.state === 'ok' ? '#34d399' : httpStatus.state === 'checking' ? colors.accent : httpStatus.state === 'error' ? '#f87171' : colors.textTertiary;
  const httpLabel =
    httpStatus.state === 'ok'
      ? `HTTP ${httpStatus.statusCode ?? 200}`
      : httpStatus.state === 'checking'
        ? 'HTTP checking'
        : httpStatus.state === 'error'
          ? (httpStatus.error || 'HTTP error')
          : 'HTTP idle';

  const totalEpisodes = coverageSeries.reduce((sum, s) => sum + s.episodes.length, 0);
  const readyEpisodes = coverageSeries.reduce(
    (sum, s) => sum + s.episodes.filter(ep => !!(ep.frames.op || ep.frames.ed || ep.frames.recap)).length,
    0,
  );
  const scanFraction = scanProgress && scanProgress.total > 0 ? Math.min(1, scanProgress.done / scanProgress.total) : 0;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>Mac TV Companion</Text>
          <View style={styles.pillsRow}>
            <View style={styles.pill}>
              <View style={[styles.dot, { backgroundColor: wsBadgeColor }]} />
              <Text style={styles.pillText}>WS: {wsState}</Text>
            </View>
            <View style={styles.pill}>
              <View style={[styles.dot, { backgroundColor: httpBadgeColor }]} />
              <Text style={styles.pillText} numberOfLines={1}>{httpLabel}</Text>
            </View>
          </View>
        </View>
        <TextInput
          value={serverDraft}
          onChangeText={onChangeServerDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_TV_SERVER_URL}
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          onSubmitEditing={() => onApplyServerUrl(serverDraft)}
        />
        <View style={styles.buttonRow}>
          <Pressable onPress={() => { haptics.select(); onApplyServerUrl(serverDraft); }} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Save & Reconnect</Text>
          </Pressable>
          <Pressable onPress={() => { haptics.select(); onApplyServerUrl(DEFAULT_TV_SERVER_URL); }} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Reset Default</Text>
          </Pressable>
          <Pressable onPress={() => { haptics.select(); onFetchCatalog(); }} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Fetch Catalog</Text>
          </Pressable>
        </View>
        {!!serverError && <Text style={styles.errorText}>{serverError}</Text>}
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>TV Playback</Text>
          <Text style={styles.meta}>{tvAutoplay ? 'Autoplay On' : 'Autoplay Stopped'}</Text>
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.switchText}>Stop TV autoplay</Text>
          <Switch
            value={!tvAutoplay}
            onValueChange={stop => {
              haptics.select();
              onToggleTvAutoplay(!stop);
            }}
            trackColor={{ true: colors.accent }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>Worker Nodes & Queue</Text>
          <View style={styles.pillsRow}>
            {workerStatus && (
              <Text style={styles.meta}>
                {workerStatus.counts.completed} / {workerStatus.counts.total} done
              </Text>
            )}
            <Pressable onPress={() => { haptics.select(); onRefreshWorkerStatus(); }} hitSlop={8}>
              <Text style={styles.clearText}>Refresh</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, marginRight: space.m }}>
            <Text style={styles.switchText}>Phone Worker Node</Text>
            <Text style={styles.workerSub}>
              {phoneWorker.running
                ? phoneWorker.currentEpisode
                  ? `Scanning ${phoneWorker.currentEpisode} (${phoneWorker.progress}%)`
                  : phoneWorker.waitReason && phoneWorker.waitReason !== 'nothing to do'
                    ? `Waiting · ${phoneWorker.waitReason}`
                    : 'Polling coordinator for jobs…'
                : 'Off · Tap to process OP/ED jobs on this device'}
            </Text>
          </View>
          <Switch
            value={phoneWorker.running}
            onValueChange={() => {
              haptics.select();
              onTogglePhoneWorker();
            }}
            trackColor={{ true: colors.accent }}
          />
        </View>
        {!!phoneWorker.lastError && <Text style={styles.errorText}>{phoneWorker.lastError}</Text>}
        {workerStatus && (
          <>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${
                      workerStatus.counts.total > 0
                        ? Math.min(100, (workerStatus.counts.completed / workerStatus.counts.total) * 100)
                        : 0
                    }%`,
                  },
                ]}
              />
            </View>
            <View style={styles.kvRow}>
              <Text style={styles.kvKey}>Queue</Text>
              <Text style={styles.kvVal}>
                {workerStatus.counts.pending} pending · {workerStatus.counts.inProgress} active · {workerStatus.counts.completed} done
                {(workerStatus.counts.retrying ?? 0) > 0 ? ` · ${workerStatus.counts.retrying} retrying` : ''}
                {(workerStatus.counts.quarantined ?? workerStatus.counts.failed) > 0
                  ? ` · ${workerStatus.counts.quarantined ?? workerStatus.counts.failed} need attention`
                  : ''}
              </Text>
            </View>
            {(workerStatus.quarantinedEpisodes?.length ?? 0) > 0 && (
              <View style={styles.quarantineBox}>
                <View style={styles.quarantineHeader}>
                  <Text style={styles.quarantineTitle}>
                    Needs attention ({workerStatus.quarantinedEpisodes!.length})
                  </Text>
                  {workerStatus.quarantinedEpisodes!.length > 1 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Retry all quarantined episodes"
                      onPress={() => onRetryQuarantined({ all: true })}
                      hitSlop={8}
                      style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.6 }]}
                    >
                      <Text style={styles.retryButtonText}>Retry all</Text>
                    </Pressable>
                  )}
                </View>
                {workerStatus.quarantinedEpisodes!.map(item => (
                  <View key={`${item.seriesName}/${item.episode}`} style={styles.quarantineRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workerName} numberOfLines={1}>{item.episode}</Text>
                      <Text style={styles.workerSub} numberOfLines={2}>
                        {item.seriesName} · failed {item.attempts}×{item.error ? ` · ${item.error}` : ''}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Retry ${item.episode}`}
                      onPress={() => onRetryQuarantined({ seriesName: item.seriesName, episode: item.episode })}
                      hitSlop={8}
                      style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.6 }]}
                    >
                      <Text style={styles.retryButtonText}>Retry</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
            {workerStatus.nodes.length === 0 ? (
              <Text style={styles.body}>No worker nodes connected yet.</Text>
            ) : (
              workerStatus.nodes.map(node => {
                const nodeColor =
                  node.status === 'working' ? '#34d399' : node.status === 'idle' ? colors.accent : '#f87171';
                return (
                  <View key={node.nodeId} style={styles.workerRow}>
                    <View style={[styles.dot, { backgroundColor: nodeColor }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workerName} numberOfLines={1}>
                        {node.nodeName} ({node.platform})
                      </Text>
                      <Text style={styles.workerSub} numberOfLines={1}>
                        {node.status === 'working' && node.currentEpisode
                          ? `${node.currentEpisode} · ${node.progress}%`
                          : node.status}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>Frame Scan Pipeline</Text>
          <Text style={styles.meta}>
            {scanProgress ? `${scanProgress.done} / ${scanProgress.total}` : 'Idle'}
          </Text>
        </View>
        {scanProgress ? (
          <>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${scanFraction * 100}%` }]} />
            </View>
            <Text style={styles.body}>
              Checking {scanProgress.seriesName || 'Series'} ({scanProgress.done} of {scanProgress.total})
            </Text>
          </>
        ) : (
          <Text style={styles.body}>No active frame scan reported by Mac server.</Text>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>Local Scan & Import</Text>
          <Text style={styles.meta}>{localScan.status}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvKey}>Local Library</Text>
          <Text style={styles.kvVal}>
            {localScan.seriesCount} {localScan.seriesCount === 1 ? 'series' : 'series'} · {localScan.episodeCount} episodes
            {localScan.lastScannedAt ? ` (${localScan.lastScannedAt})` : ''}
          </Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvKey}>Skip Detection</Text>
          <Text style={styles.kvVal}>
            {readyEpisodes} / {totalEpisodes} episodes with OP/ED/Recap timings
          </Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvKey}>Import Pipeline</Text>
          <Text style={styles.kvVal}>
            {importState.status === 'idle' ? 'Ready' : importState.detail || importState.status}
          </Text>
        </View>
        {!!localScan.error && <Text style={styles.errorText}>{localScan.error}</Text>}
        <View style={styles.buttonRow}>
          <Pressable onPress={() => { haptics.select(); onRescanLocal(); }} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Rescan Local</Text>
          </Pressable>
          <Pressable onPress={() => { haptics.select(); onImportFolder(); }} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Import Folder…</Text>
          </Pressable>
          <Pressable onPress={() => { haptics.select(); onImportFiles(); }} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Import Files…</Text>
          </Pressable>
        </View>
      </View>

      {coverageSeries.length > 0 && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.label}>Series Coverage</Text>
            <Text style={styles.meta}>
              {coverageSeries.length} {coverageSeries.length === 1 ? 'series' : 'series'}
            </Text>
          </View>
          {coverageSeries.map(series => {
            const key = series.folder || '_root';
            const readyCount = series.episodes.filter(ep => !!(ep.frames.op || ep.frames.ed || ep.frames.recap)).length;
            const expanded = !!expandedSeries[key];
            return (
              <View key={key} style={styles.coverageItem}>
                <Pressable
                  onPress={() => {
                    haptics.select();
                    setExpandedSeries(prev => ({ ...prev, [key]: !expanded }));
                  }}
                  style={styles.coverageHeader}
                >
                  <Text style={styles.coverageCaret}>{expanded ? '▾' : '▸'}</Text>
                  <Text style={styles.coverageTitle} numberOfLines={1}>{series.title}</Text>
                  <Text style={styles.coverageCount}>{readyCount} / {series.episodes.length}</Text>
                </Pressable>
                {expanded && (
                  <View style={styles.coverageEpisodes}>
                    {series.episodes.map(ep => {
                      const parts = [
                        ep.frames.recap ? 'Recap' : '',
                        ep.frames.op ? 'OP' : '',
                        ep.frames.ed ? 'ED' : '',
                      ].filter(Boolean);
                      return (
                        <View key={ep.key} style={styles.coverageEpRow}>
                          <Text style={styles.coverageEpName} numberOfLines={1}>{ep.label}</Text>
                          <Text style={[styles.coverageEpBadge, parts.length ? styles.coverageEpDone : styles.coverageEpPending]}>
                            {parts.length ? parts.join(' · ') : 'No timings'}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.label}>Live Event Feed</Text>
          <View style={styles.pillsRow}>
            <Text style={styles.meta}>{pipelineEvents.length} events</Text>
            {pipelineEvents.length > 0 && (
              <Pressable onPress={() => { haptics.select(); onClearEvents(); }} hitSlop={8}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            )}
          </View>
        </View>
        {pipelineEvents.length === 0 ? (
          <Text style={styles.body}>Waiting for WebSocket or scan events…</Text>
        ) : (
          pipelineEvents.map(ev => (
            <View key={ev.id} style={styles.eventRow}>
              <Text style={styles.eventTime}>{ev.time}</Text>
              <Text style={styles.eventKind}>{ev.kind}</Text>
              <Text style={styles.eventDetail} numberOfLines={2}>{ev.detail}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  quarantineBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
    backgroundColor: 'rgba(248,113,113,0.08)',
    gap: 8,
  },
  quarantineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quarantineTitle: { color: '#f87171', fontSize: 13, fontWeight: '600' },
  quarantineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.5)',
  },
  retryButtonText: { color: '#f87171', fontSize: 13, fontWeight: '600' },
  scroll: { flex: 1 },
  content: { padding: space.l, gap: space.m, paddingBottom: space.xl },
  card: { backgroundColor: colors.surface, borderRadius: radius.medium, padding: space.l, gap: space.s },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  label: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  pillsRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 160 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { color: colors.text, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  input: { backgroundColor: colors.surfaceRaised, color: colors.text, borderRadius: radius.small, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  primaryBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  primaryBtnText: { color: colors.background, fontSize: 13, fontWeight: '700' },
  secondaryBtn: { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  secondaryBtnText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  body: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  errorText: { color: '#f87171', fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surfaceRaised, borderRadius: radius.small, paddingHorizontal: space.m, paddingVertical: space.xs },
  switchText: { color: colors.text, fontSize: 14, flex: 1, marginRight: space.m },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: colors.accent },
  kvRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.m },
  kvKey: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  kvVal: { color: colors.text, fontSize: 13, flex: 1, textAlign: 'right' },
  coverageItem: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator, paddingTop: space.s, gap: space.xs },
  coverageHeader: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: 2 },
  coverageCaret: { color: colors.textSecondary, fontSize: 13, width: 14 },
  coverageTitle: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  coverageCount: { color: colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] },
  coverageEpisodes: { paddingLeft: 22, gap: 4, paddingTop: 4 },
  coverageEpRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s, paddingVertical: 2 },
  coverageEpName: { color: colors.textSecondary, fontSize: 13, flex: 1 },
  coverageEpBadge: { fontSize: 12, fontWeight: '600' },
  coverageEpDone: { color: '#34d399' },
  coverageEpPending: { color: colors.textTertiary },
  clearText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  eventTime: { color: colors.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },
  eventKind: { color: colors.accent, fontSize: 12, fontWeight: '700', minWidth: 74 },
  eventDetail: { color: colors.textSecondary, fontSize: 12, flex: 1 },
  workerRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  workerName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  workerSub: { color: colors.textSecondary, fontSize: 12 },
});
