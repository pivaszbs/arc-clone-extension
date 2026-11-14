import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { clock } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { TvControlCommand, TvPlaybackState } from '../lib/tv-sync';
import { colors, radius, space } from '../theme';

type Props = {
  tvState: TvPlaybackState;
  tvAutoplay?: boolean;
  onCommand: (command: TvControlCommand) => void;
  onPlayOnPhone: () => void;
};

/** Compact remote-control card shown on the phone when playback is active on the TV. */
export function TvRemotePanel({ tvState, tvAutoplay, onCommand, onPlayOnPhone }: Props) {
  const position = tvState.position ?? 0;
  const duration = tvState.duration ?? 0;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const paused = Boolean(tvState.paused);
  const subtitlesOn = tvState.subtitles !== false;
  const autoplayOn = tvState.autoplay ?? tvAutoplay ?? true;

  const send = (command: TvControlCommand) => {
    haptics.select();
    onCommand(command);
  };

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.badge}>
          <View style={styles.liveDot} />
          <Text style={styles.badgeText}>Playing on TV</Text>
        </View>
        <View style={styles.topActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Turn off TV playback"
            onPress={() => send({ action: 'stop' })}
            style={({ pressed }) => [styles.stopPill, pressed && styles.controlPressed]}
          >
            <SymbolView name="power" size={12} tintColor="#f87171" />
            <Text style={styles.stopPillText}>Turn off TV</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => { haptics.select(); onPlayOnPhone(); }}
            style={({ pressed }) => [styles.phoneButton, pressed && styles.controlPressed]}
          >
            <SymbolView name="iphone" size={12} tintColor={colors.textSecondary} />
            <Text style={styles.phoneButtonText}>Play on phone</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.meta}>
        <Text style={styles.seriesTitle} numberOfLines={1}>
          {tvState.seriesLabel || tvState.seriesName || 'Anime Study TV'}
        </Text>
        <Text style={styles.episodeTitle} numberOfLines={1}>
          {tvState.episodeLabel || tvState.episode || 'Loading…'}
        </Text>
      </View>

      <View style={styles.progressSection}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${fraction * 100}%` }]} />
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{clock(position)}</Text>
          <Text style={styles.statusText}>{paused ? 'Paused' : 'Playing'}</Text>
          <Text style={styles.timeText}>{duration > 0 ? clock(duration) : '--:--'}</Text>
        </View>
      </View>

      <View style={styles.controlsRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous episode on TV"
          onPress={() => send({ action: 'prev' })}
          style={({ pressed }) => [styles.controlBtn, pressed && styles.controlPressed]}
        >
          <SymbolView name="backward.end.fill" size={16} tintColor={colors.text} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Rewind 10 seconds on TV"
          onPress={() => send({ action: 'seekBy', delta: -10 })}
          style={({ pressed }) => [styles.controlBtn, pressed && styles.controlPressed]}
        >
          <SymbolView name="gobackward.10" size={18} tintColor={colors.text} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={paused ? 'Play on TV' : 'Pause TV'}
          onPress={() => send({ action: paused ? 'play' : 'pause' })}
          style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnPressed]}
        >
          <SymbolView name={paused ? 'play.fill' : 'pause.fill'} size={20} tintColor={colors.background} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Forward 10 seconds on TV"
          onPress={() => send({ action: 'seekBy', delta: 10 })}
          style={({ pressed }) => [styles.controlBtn, pressed && styles.controlPressed]}
        >
          <SymbolView name="goforward.10" size={18} tintColor={colors.text} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next episode on TV"
          onPress={() => send({ action: 'next' })}
          style={({ pressed }) => [styles.controlBtn, pressed && styles.controlPressed]}
        >
          <SymbolView name="forward.end.fill" size={16} tintColor={colors.text} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`TV subtitles ${subtitlesOn ? 'on' : 'off'}`}
          onPress={() => send({ action: 'subtitles' })}
          style={({ pressed }) => [
            styles.togglePill,
            subtitlesOn && styles.togglePillActive,
            pressed && styles.controlPressed,
          ]}
        >
          <Text style={[styles.togglePillText, subtitlesOn && styles.togglePillTextActive]}>CC</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`TV autoplay ${autoplayOn ? 'on' : 'off'}`}
          onPress={() => send({ action: 'autoplay' })}
          style={({ pressed }) => [
            styles.togglePill,
            autoplayOn && styles.togglePillActive,
            pressed && styles.controlPressed,
          ]}
        >
          <Text style={[styles.togglePillText, autoplayOn && styles.togglePillTextActive]}>Auto</Text>
        </Pressable>
      </View>

      {tvState.skipAvailable && (
        <Pressable
          accessibilityRole="button"
          onPress={() => send({ action: 'skip' })}
          style={({ pressed }) => [styles.skipBtn, pressed && styles.playBtnPressed]}
        >
          <SymbolView name="forward.fill" size={13} tintColor={colors.background} />
          <Text style={styles.skipBtnText}>Skip OP/ED</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.large,
    padding: space.m,
    gap: space.s,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,130,72,0.3)',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xs,
    flexWrap: 'wrap',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accentMuted,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#34d399',
  },
  badgeText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stopPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(248,113,113,0.14)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  stopPillText: {
    color: '#f87171',
    fontSize: 11,
    fontWeight: '700',
  },
  phoneButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  phoneButtonText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  meta: {
    gap: 1,
  },
  seriesTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  episodeTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  progressSection: {
    gap: 4,
  },
  progressTrack: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  progressFill: {
    height: 3,
    backgroundColor: colors.accent,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  statusText: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingTop: 2,
  },
  controlBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlPressed: {
    opacity: 0.7,
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnPressed: {
    opacity: 0.85,
  },
  togglePill: {
    height: 32,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  togglePillActive: {
    backgroundColor: colors.accentMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,130,72,0.45)',
  },
  togglePillText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  togglePillTextActive: {
    color: colors.accent,
  },
  skipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  skipBtnText: {
    color: colors.background,
    fontSize: 12,
    fontWeight: '700',
  },
});
