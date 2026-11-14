import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  ago, clock, episodeLabel, fetchServerStatus, headline, nodeLine, nodeTone, routeLabel, seriesLabel,
  type ServerStatus,
} from '../../../shared/sync/server-status';
import { haptics } from '../lib/haptics';
import type { Series } from '../lib/library';
import type { PipelineEvent, ScanProgressInfo, TvHttpStatus, TvWsState, WorkerStatusPayload } from '../lib/tv-sync';
import { DEFAULT_TV_SERVER_URL } from '../lib/tv-sync';
import type { PhoneWorkerState } from '../lib/worker-node';
import { colors, radius, space, status as statusColors, type } from '../theme';
import { Button, ProgressBar, Row, Section, Stat, StatusDot } from './ui';

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
  serverUrl: string;
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

const REFRESH_MS = 5000;
const EVENTS_SHOWN = 6;

function phoneWorkerLine(worker: PhoneWorkerState) {
  if (!worker.running) return 'Off. Turn on to detect openings and endings on this device.';
  if (worker.currentEpisode) return `${episodeLabel(worker.currentEpisode)} · ${worker.progress}%`;
  if (worker.waitReason && worker.waitReason !== 'nothing to do') return `Waiting · ${worker.waitReason}`;
  return 'On · nothing to do right now';
}

/** The Server tab: what the Mac, its workers and every synced device are doing. */
export function PipelinesView(props: Props) {
  const {
    serverUrl, serverDraft, onChangeServerDraft, onApplyServerUrl, onFetchCatalog, wsState, httpStatus, serverError,
    tvAutoplay, onToggleTvAutoplay, localScan, onRescanLocal, importState, onImportFolder, onImportFiles,
    coverageSeries, pipelineEvents, onClearEvents, workerStatus, phoneWorker, onTogglePhoneWorker,
    onRefreshWorkerStatus, onRetryQuarantined,
  } = props;
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [reachable, setReachable] = useState(httpStatus.state !== 'error');
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [allEvents, setAllEvents] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);

  // Refreshes only while this tab is open; the component unmounts when you leave it.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await fetchServerStatus(serverUrl);
        if (stopped) return;
        setServer(next);
        setReachable(true);
      } catch {
        if (!stopped) setReachable(false);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [serverUrl]);

  const refresh = async () => {
    setRefreshing(true);
    onFetchCatalog();
    onRefreshWorkerStatus();
    try {
      setServer(await fetchServerStatus(serverUrl));
      setReachable(true);
    } catch {
      setReachable(false);
    }
    setRefreshing(false);
  };

  const top = headline(server, reachable);
  const live = wsState === 'connected';
  const route = routeLabel(serverUrl, server);
  const host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // Older servers have no status.json: fall back to what the app already knows.
  const nodes = server?.workers.nodes ?? workerStatus?.nodes ?? [];
  const jobs = (server?.workers.jobs ?? workerStatus?.jobs ?? []).filter(job => job.status !== 'completed' && job.status !== 'failed');
  const counts = server?.workers.counts ?? workerStatus?.counts;
  const quarantined = server?.workers.quarantinedEpisodes ?? workerStatus?.quarantinedEpisodes ?? [];
  const localReady = coverageSeries.reduce((sum, s) => sum + s.episodes.filter(ep => !!(ep.frames.op || ep.frames.ed || ep.frames.recap)).length, 0);
  const localTotal = coverageSeries.reduce((sum, s) => sum + s.episodes.length, 0);
  const ready = server?.library.withTimings ?? localReady;
  const total = server?.library.episodes ?? localTotal;
  const perSeries = server?.library.perSeries
    ?? coverageSeries.map(s => ({ folder: s.folder, title: s.title, episodes: s.episodes.length, withTimings: s.episodes.filter(ep => !!(ep.frames.op || ep.frames.ed || ep.frames.recap)).length }));
  const events = allEvents ? pipelineEvents : pipelineEvents.slice(0, EVENTS_SHOWN);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={colors.textSecondary} />}
    >
      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <StatusDot tone={top.tone} size={10} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.title}>{top.title}</Text>
            <Text style={type.subhead}>{top.detail}</Text>
          </View>
        </View>
        <View style={styles.stats}>
          <Stat value={total ? `${ready}/${total}` : '–'} label="Episodes ready" />
          <Stat value={counts ? String(counts.pending + counts.inProgress) : '–'} label="In queue" tone={quarantined.length ? 'danger' : undefined} />
          <Stat value={server ? String(server.devices.length) : '–'} label="Devices synced" />
        </View>
        {total > 0 && <ProgressBar value={ready / total} tone={ready === total ? 'ok' : 'accent'} />}
      </View>

      {quarantined.length > 0 && (
        <Section
          title="Needs attention"
          action={quarantined.length > 1 ? <Button variant="plain" title="Retry all" onPress={() => onRetryQuarantined({ all: true })} /> : undefined}
        >
          {quarantined.map((item, index) => (
            <Row
              key={`${item.seriesName}/${item.episode}`}
              first={index === 0}
              tone="danger"
              title={`${seriesLabel(item.seriesName)} · ${episodeLabel(item.episode)}`}
              detail={`Failed ${item.attempts} time${item.attempts === 1 ? '' : 's'}${item.error ? ` · ${item.error}` : ''}`}
              right={<Button variant="danger" title="Retry" onPress={() => onRetryQuarantined({ seriesName: item.seriesName, episode: item.episode })} />}
            />
          ))}
        </Section>
      )}

      <Section title="Now">
        <Row
          first
          icon="tv"
          tone={server?.tv.active ? 'ok' : 'idle'}
          title={server?.tv.active ? `${server.tv.seriesLabel ?? 'TV'} · ${server.tv.episodeLabel ?? ''}` : 'TV is idle'}
          detail={server?.tv.active
            ? `${server.tv.paused ? 'Paused' : 'Playing'} at ${clock(server.tv.position)}${server.tv.duration ? ` of ${clock(server.tv.duration)}` : ''}`
            : server ? null : 'Shown when the Mac server is updated'}
        />
        {jobs.map(job => (
          <Row
            key={job.jobId}
            icon="waveform"
            tone="ok"
            title={`${seriesLabel(job.seriesName)} · ${episodeLabel(job.episode)}`}
            detail={`${(job as { kind?: string }).kind === 'probe' ? 'Reading file' : 'Finding opening and ending'}${job.nodeName ? ` on ${job.nodeName}` : ''}`}
            right={<Text style={styles.percent}>{Math.round(job.progress ?? 0)}%</Text>}
          >
            <ProgressBar value={(job.progress ?? 0) / 100} tone="ok" />
          </Row>
        ))}
        {(server?.workers.next.length ?? 0) > 0 && jobs.length === 0 && (
          <Row
            icon="clock"
            title={`Next: ${seriesLabel(server!.workers.next[0].seriesName)} · ${episodeLabel(server!.workers.next[0].episode)}`}
            detail={counts ? `${counts.pending} waiting${server!.workers.tvBusy ? ' · paused while the TV plays' : ''}` : null}
          />
        )}
      </Section>

      <Section title="Workers">
        {nodes.map((node, index) => (
          <Row
            key={node.nodeId}
            first={index === 0}
            tone={nodeTone(node)}
            title={node.nodeName}
            detail={nodeLine(node)}
            right={<Text style={type.caption}>{node.platform === 'ios' ? 'iPhone' : node.platform === 'mac' ? 'Mac' : node.platform ?? ''}</Text>}
          />
        ))}
        {nodes.length === 0 && (
          <Row first tone="idle" title="No workers connected" detail="Run npm run mac:up on the Mac, or use this device below." />
        )}
        <Row
          icon="iphone"
          tone={phoneWorker.running ? 'ok' : undefined}
          title="Use this device as a worker"
          detail={phoneWorkerLine(phoneWorker)}
          right={(
            <Switch
              value={phoneWorker.running}
              onValueChange={() => { haptics.select(); onTogglePhoneWorker(); }}
              trackColor={{ true: colors.accent }}
            />
          )}
        >
          {phoneWorker.running && !!phoneWorker.currentEpisode && <ProgressBar value={phoneWorker.progress / 100} tone="ok" />}
          {!!phoneWorker.lastError && <Text style={styles.error}>{phoneWorker.lastError}</Text>}
        </Row>
      </Section>

      {server && (
        <Section title="Devices">
          {server.devices.map((device, index) => (
            <Row
              key={device.node}
              first={index === 0}
              icon={device.kind === 'iPhone' ? 'iphone' : device.kind === 'Chrome' ? 'macwindow' : device.kind === 'TV' ? 'tv' : 'desktopcomputer'}
              title={device.kind}
              detail={`Synced ${ago(device.secondsAgo)}`}
              right={<StatusDot tone={device.secondsAgo < 900 ? 'ok' : 'idle'} />}
            />
          ))}
          {server.devices.length === 0 && <Row first tone="idle" title="No device has synced yet" detail="Progress and skip timings sync when a device opens the app." />}
        </Section>
      )}

      {perSeries.length > 0 && (
        <Section title="Library">
          {perSeries.map((item, index) => {
            const local = coverageSeries.find(s => s.folder === item.folder || s.title === item.title);
            const open = !!expanded[item.folder];
            const done = item.withTimings === item.episodes;
            return (
              <Row
                key={item.folder}
                first={index === 0}
                title={seriesLabel(item.title)}
                detail={done ? `All ${item.episodes} episodes ready` : `${item.withTimings} of ${item.episodes} episodes ready`}
                onPress={local ? () => setExpanded(prev => ({ ...prev, [item.folder]: !open })) : undefined}
                right={<Text style={[styles.percent, done && { color: statusColors.ok }]}>{item.episodes ? Math.round((item.withTimings / item.episodes) * 100) : 0}%</Text>}
              >
                {!done && <ProgressBar value={item.episodes ? item.withTimings / item.episodes : 0} />}
                {open && local && (
                  <View style={styles.episodes}>
                    {local.episodes.map(ep => {
                      const parts = [ep.frames.recap ? 'Recap' : '', ep.frames.op ? 'Opening' : '', ep.frames.ed ? 'Ending' : ''].filter(Boolean);
                      return (
                        <View key={ep.key} style={styles.episode}>
                          <Text style={type.subhead} numberOfLines={1}>{ep.label}</Text>
                          <Text style={[type.caption, parts.length > 0 && { color: statusColors.ok }]}>{parts.length ? parts.join(' · ') : 'Not found yet'}</Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </Row>
            );
          })}
        </Section>
      )}

      <Section title="This device">
        <Row
          first
          icon="internaldrive"
          title={`${localScan.seriesCount} series · ${localScan.episodeCount} episodes saved here`}
          detail={localScan.error ? localScan.error : importState.status !== 'idle' ? (importState.detail || importState.status) : localScan.lastScannedAt ? `Checked at ${localScan.lastScannedAt}` : null}
          tone={localScan.error ? 'danger' : undefined}
        >
          <View style={styles.buttons}>
            <Button title="Rescan" icon="arrow.clockwise" onPress={onRescanLocal} loading={localScan.status === 'scanning'} />
            <Button title="Import folder" onPress={onImportFolder} disabled={importState.status === 'importing'} />
            <Button title="Import files" onPress={onImportFiles} disabled={importState.status === 'importing'} />
          </View>
        </Row>
        <Row
          icon="play.tv"
          title="TV plays the next episode automatically"
          right={<Switch value={tvAutoplay} onValueChange={value => { haptics.select(); onToggleTvAutoplay(value); }} trackColor={{ true: colors.accent }} />}
        />
      </Section>

      <Section title="Connection">
        <Row
          first
          tone={reachable ? 'ok' : 'danger'}
          title={reachable ? `${route} · ${host}` : `Can't reach ${host}`}
          detail={reachable
            ? `${live ? 'Live updates on' : 'Live updates reconnecting'}${server?.tailscale.running ? ' · Tailscale available' : ''}`
            : serverError ?? httpStatus.error ?? 'Check that the Mac is awake and on the same network or Tailscale.'}
          right={<Button variant="plain" title={editingAddress ? 'Done' : 'Change'} onPress={() => setEditingAddress(value => !value)} />}
        >
          {editingAddress && (
            <View style={{ gap: space.s }}>
              <TextInput
                value={serverDraft}
                onChangeText={onChangeServerDraft}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                placeholder={DEFAULT_TV_SERVER_URL}
                placeholderTextColor={colors.textTertiary}
                style={styles.input}
                onSubmitEditing={() => { onApplyServerUrl(serverDraft); setEditingAddress(false); }}
              />
              <View style={styles.buttons}>
                <Button variant="primary" title="Save and reconnect" onPress={() => { onApplyServerUrl(serverDraft); setEditingAddress(false); }} />
                <Button title="Use default" onPress={() => { onApplyServerUrl(DEFAULT_TV_SERVER_URL); setEditingAddress(false); }} />
              </View>
            </View>
          )}
        </Row>
        {(server?.addresses.length ?? 0) > 1 && (
          <Row
            icon="point.3.connected.trianglepath.dotted"
            title="The Mac also answers on"
            detail={server!.addresses.map(url => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(item => item !== host).join('\n')}
          />
        )}
      </Section>

      <Section
        title="Activity"
        action={pipelineEvents.length > 0 ? <Button variant="plain" title="Clear" onPress={onClearEvents} /> : undefined}
      >
        {events.map((event, index) => (
          <View key={event.id} style={[styles.event, index > 0 && styles.eventDivider]}>
            <Text style={styles.eventTime}>{event.time}</Text>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={styles.eventKind}>{event.kind}</Text>
              <Text style={type.subhead} numberOfLines={3}>{event.detail}</Text>
            </View>
          </View>
        ))}
        {pipelineEvents.length === 0 && <Row first tone="idle" title="Nothing yet" detail="Scans, syncs and connection changes appear here." />}
        {pipelineEvents.length > EVENTS_SHOWN && (
          <Row title={allEvents ? 'Show fewer' : `Show all ${pipelineEvents.length}`} onPress={() => setAllEvents(value => !value)} />
        )}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.xl * 2, gap: space.xl },
  summary: { backgroundColor: colors.surface, borderRadius: radius.large, borderCurve: 'continuous', padding: space.l, gap: space.l },
  summaryTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m, paddingTop: 2 },
  stats: { flexDirection: 'row', gap: space.m },
  percent: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  error: { color: statusColors.danger, fontSize: 13 },
  episodes: { gap: space.s, paddingTop: space.xs },
  episode: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  input: { backgroundColor: colors.surfaceRaised, color: colors.text, borderRadius: radius.small, paddingHorizontal: space.m, paddingVertical: 10, fontSize: 14 },
  event: { flexDirection: 'row', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.s + 2 },
  eventDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  eventTime: { color: colors.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'], width: 58, paddingTop: 1 },
  eventKind: { color: colors.accent, fontSize: 12, fontWeight: '700' },
});
