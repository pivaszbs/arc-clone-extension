import { useEventListener } from 'expo';
import { SymbolView } from 'expo-symbols';
import { isPictureInPictureSupported, useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { TimeRange } from 'react-native-anime-core';

import { clock, cueAt } from '../lib/format';
import { haptics } from '../lib/haptics';
import type { Episode } from '../lib/library';
import { progressFor, saveProgress } from '../lib/storage';
import { skipLabels, useEpisodeStudy, type SkipPart } from '../lib/useEpisodeStudy';
import { colors, radius, space } from '../theme';
import { Glass, GlassPill, IconButton } from './Glass';

type Props = {
  episode: Episode;
  neighbours: Episode[];
  fullscreen: boolean;
  /** Start playing as soon as the episode is ready (episodes opened from the series screen). */
  autoPlay?: boolean;
  autoSkip: boolean;
  subtitlesOn: boolean;
  onToggleFullscreen: (value?: boolean) => void;
  onToggleSubtitles: () => void;
  onStep?: (direction: -1 | 1, autoplay: boolean) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onProgress?: () => void;
  /** PiP started or stopped; `stillPlaying` tells a restore (playing) from closing the window (paused). */
  onPictureInPictureChange?: (active: boolean, stillPlaying: boolean) => void;
};

const pipSupported = (() => { try { return isPictureInPictureSupported(); } catch { return false; } })();

const DOUBLE_TAP_MS = 280;

/** False for a player that was already released (closing the episode), instead of throwing. */
function isPlaying(player: { playing: boolean }) {
  try { return player.playing; } catch { return false; }
}

/**
 * Run something on the video player, or fall back if the native player is already released.
 * A released player throws on every call and would otherwise close the app.
 */
function safe<T>(action: () => T, fallback: T): T {
  try { return action(); } catch { return fallback; }
}
const SKIP_SECONDS = 10;
const HIDE_AFTER_MS = 3000;
const skipOrder: SkipPart[] = ['recap', 'op', 'ed'];

export function Player(props: Props) {
  const { episode, fullscreen, autoSkip, subtitlesOn } = props;
  const player = useVideoPlayer(null, instance => {
    instance.timeUpdateEventInterval = 0.25;
    instance.showNowPlayingNotification = true;
  });
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [controls, setControls] = useState(true);
  const [ripple, setRipple] = useState<{ side: 'left' | 'right'; seconds: number } | null>(null);
  const [undo, setUndo] = useState<{ part: SkipPart; from: number } | null>(null);
  const [width, setWidth] = useState(1);
  const study = useEpisodeStudy(episode, props.neighbours, duration);

  const dismissed = useRef(new Set<SkipPart>());
  const resumeAt = useRef(0);
  const lastSaved = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef<{ at: number; side: 'left' | 'center' | 'right' } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ----- Loading and progress -----

  useEffect(() => {
    const saved = progressFor(episode.key);
    resumeAt.current = saved && !saved.finished ? saved.position : 0;
    dismissed.current.clear();
    setReady(false);
    setStarted(false);
    setTime(resumeAt.current);
    setDuration(saved?.duration ?? 0);
    setUndo(null);
    void player.replaceAsync({ uri: episode.videoUri, metadata: { title: episode.label } });
  }, [episode, player]);

  const save = useCallback((finished = false) => {
    let position: number;
    let playerDuration: number;
    try {
      position = player.currentTime;
      playerDuration = player.duration;
    } catch { return; /* Already released (the episode was closed). */ }
    if (!ready || !Number.isFinite(position)) return;
    const total = playerDuration || duration;
    saveProgress(episode.key, { position, duration: total, watchedAt: Date.now(), finished: finished || (total > 0 && position >= total - 5) });
    lastSaved.current = Date.now();
    props.onProgress?.();
  }, [player, ready, duration, episode.key, props]);

  useEffect(() => () => save(), [save]);

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || ready) return;
    setReady(true);
    safe(() => {
      setDuration(player.duration);
      if (resumeAt.current > 1) player.currentTime = resumeAt.current;
      if (props.autoPlay) player.play();
    }, undefined);
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    setPlaying(isPlaying);
    if (isPlaying) setStarted(true);
    else save();
  });
  useEventListener(player, 'playToEnd', () => {
    save(true);
    if (props.hasNext) props.onStep?.(1, true);
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setTime(currentTime);
    if (Date.now() - lastSaved.current > 5000 && isPlaying(player)) save();
  });

  // ----- Controls visibility -----

  // Hide the controls 3 s after the last touch while the episode plays. Both the reported playing
  // state and the player itself count, so one missed event can't keep the controls up for good.
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const poke = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (playingRef.current || isPlaying(player)) setControls(false);
    }, HIDE_AFTER_MS);
  }, [player]);
  const controlsOpacity = useSharedValue(1);
  useEffect(() => {
    controlsOpacity.set(withTiming(controls ? 1 : 0, { duration: controls ? 150 : 250, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
  }, [controls, controlsOpacity]);
  const controlsStyle = useAnimatedStyle(() => ({ opacity: controlsOpacity.get() }));

  // Timers must not outlive the player: reading a released player throws and closes the app.
  useEffect(() => () => {
    clearTimeout(hideTimer.current);
    clearTimeout(tapTimer.current);
  }, []);

  useEffect(() => {
    if (playing) poke();
    else { clearTimeout(hideTimer.current); setControls(true); }
  }, [playing, poke]);

  // ----- Playback actions -----

  const seekTo = useCallback((seconds: number) => {
    const total = safe(() => player.duration, 0) || duration;
    const target = Math.max(0, total ? Math.min(total - 0.25, seconds) : seconds);
    safe(() => { player.currentTime = target; }, undefined);
    setTime(target);
  }, [player, duration]);

  const togglePlay = useCallback(() => {
    safe(() => { if (player.playing) player.pause(); else player.play(); }, undefined);
    haptics.tap();
    poke();
  }, [player, poke]);

  const seekBy = useCallback((seconds: number, side: 'left' | 'right') => {
    const total = safe(() => player.duration, 0) || duration;
    const at = safe(() => player.currentTime, 0);
    if ((seconds < 0 && at <= 0.5) || (seconds > 0 && total && at >= total - 1)) haptics.edge();
    else haptics.seek();
    seekTo(at + seconds);
    setRipple(previous => ({ side, seconds: previous?.side === side ? previous.seconds + seconds : seconds }));
    poke();
  }, [player, duration, seekTo, poke]);

  useEffect(() => {
    if (!ripple) return;
    const timer = setTimeout(() => setRipple(null), 650);
    return () => clearTimeout(timer);
  }, [ripple]);

  // Tap to play/pause, double-tap a side to skip 10 s (keep tapping to skip more).
  const onSurfacePress = useCallback((event: GestureResponderEvent) => {
    const x = event.nativeEvent.locationX;
    const side = x < width / 3 ? 'left' : x > (width * 2) / 3 ? 'right' : 'center';
    const now = Date.now();
    const previous = lastTap.current;
    lastTap.current = { at: now, side };
    if (previous && now - previous.at < DOUBLE_TAP_MS && previous.side === side) {
      clearTimeout(tapTimer.current);
      if (side === 'center') props.onToggleFullscreen();
      else seekBy(side === 'left' ? -SKIP_SECONDS : SKIP_SECONDS, side);
      return;
    }
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      try {
        if (!started) { player.play(); haptics.tap(); return; }
        if (!controls && player.playing) { poke(); return; }
        togglePlay();
      } catch { /* The player was closed in the meantime. */ }
    }, DOUBLE_TAP_MS);
  }, [width, props, seekBy, togglePlay, started, controls, player, poke]);

  const playFullscreen = useCallback(() => {
    haptics.tap();
    props.onToggleFullscreen(true);
    safe(() => player.play(), undefined);
  }, [player, props]);

  // ----- Opening / ending / recap -----

  const activeSkip = useMemo(() => {
    for (const part of skipOrder) {
      const range: TimeRange | undefined = study.skips[part];
      if (range && time >= range.start && time < range.end - 1) return { part, range };
    }
    return null;
  }, [study.skips, time]);

  const skip = useCallback((part: SkipPart, range: TimeRange, automatic: boolean) => {
    dismissed.current.add(part);
    const total = safe(() => player.duration, 0) || duration;
    // An ending that runs to the end of the file goes straight to the next episode.
    if (part === 'ed' && total && range.end >= total - 3 && props.hasNext) {
      save(true);
      props.onStep?.(1, true);
      return;
    }
    setUndo({ part, from: safe(() => player.currentTime, range.start) });
    seekTo(range.end);
    haptics.skipped();
    if (!automatic) poke();
  }, [player, duration, props, save, seekTo, poke]);

  useEffect(() => {
    if (!activeSkip || !autoSkip || !playing || dismissed.current.has(activeSkip.part)) return;
    skip(activeSkip.part, activeSkip.range, true);
  }, [activeSkip, autoSkip, playing, skip]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  // ----- Subtitles -----

  const cueIndex = subtitlesOn ? cueAt(study.cues, time) : -1;
  const cue = cueIndex >= 0 ? study.cues[cueIndex] : undefined;

  const total = duration || safe(() => player.duration, 0) || 0;
  const showBigPlay = !started && !fullscreen && ready;

  // Swipe down to leave fullscreen: the video follows the finger, shrinks and rounds its corners,
  // then either closes (far enough or flicked) or springs back.
  const { height: screenHeight } = useWindowDimensions();
  const videoView = useRef<VideoView>(null);
  // Split View / Slide Over: a narrow window keeps only the essential controls.
  const narrow = width < 560;
  const reduced = useReducedMotion();
  const dragY = useSharedValue(0);
  const dismiss = useCallback(() => {
    haptics.tap();
    props.onToggleFullscreen(false);
    // With PiP on, the player stays mounted (hidden); put it back in place for when it returns.
    setTimeout(() => dragY.set(0), 300);
  }, [props, dragY]);
  const swipeDown = usePanGesture({
    enabled: fullscreen,
    activeOffsetY: 18,
    failOffsetX: [-24, 24],
    onUpdate: event => {
      'worklet';
      dragY.set(Math.max(0, event.translationY));
    },
    onDeactivate: event => {
      'worklet';
      if (event.translationY > 140 || (event.velocityY > 900 && event.translationY > 40)) {
        dragY.set(withTiming(screenHeight, { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
        scheduleOnRN(dismiss);
      } else {
        dragY.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityY }));
      }
    },
  });
  const dragStyle = useAnimatedStyle(() => {
    const y = dragY.get();
    return {
      borderRadius: interpolate(y, [0, 200], [0, 24], 'clamp'),
      opacity: reduced ? interpolate(y, [0, 300], [1, 0.4], 'clamp') : 1,
      transform: reduced ? [] : [{ translateY: y }, { scale: interpolate(y, [0, 400], [1, 0.82], 'clamp') }],
    };
  });

  return (
    <GestureDetector gesture={swipeDown}>
    <Animated.View style={[styles.frame, fullscreen ? styles.fullscreen : styles.inline, dragStyle]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <VideoView
        ref={videoView}
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture
        // Going home while an episode plays keeps it on screen in a floating window.
        startsPictureInPictureAutomatically
        onPictureInPictureStart={() => props.onPictureInPictureChange?.(true, true)}
        onPictureInPictureStop={() => props.onPictureInPictureChange?.(false, isPlaying(player))}
      />
      <Pressable style={StyleSheet.absoluteFill} onPress={onSurfacePress} accessibilityLabel="Video. Tap to play or pause, double-tap a side to skip 10 seconds." />

      {!ready && <ActivityIndicator style={styles.center} color={colors.text} size="large" />}

      {ripple && (
        <View pointerEvents="none" style={[styles.ripple, ripple.side === 'left' ? styles.rippleLeft : styles.rippleRight]}>
          <SymbolView name={ripple.side === 'left' ? 'gobackward' : 'goforward'} size={30} tintColor={colors.text} />
          <Text style={styles.rippleText}>{ripple.seconds > 0 ? '+' : '−'}{Math.abs(ripple.seconds)} s</Text>
        </View>
      )}

      {cue && (
        <View pointerEvents="none" style={[styles.subtitleWrap, { bottom: controls ? (fullscreen ? 118 : 96) : 28 }]}>
          <Text style={[styles.subtitle, fullscreen && styles.subtitleLarge]}>{cue.text}</Text>
        </View>
      )}

      {showBigPlay && (
        <Pressable accessibilityRole="button" accessibilityLabel="Play episode in fullscreen" onPress={playFullscreen} style={styles.center}>
          {({ pressed }) => (
            <Glass round={48} style={[styles.bigPlay, pressed && { transform: [{ scale: 0.94 }] }]}>
              <SymbolView name="play.fill" size={38} tintColor={colors.text} />
            </Glass>
          )}
        </Pressable>
      )}

      <View pointerEvents="box-none" style={[styles.skipArea, { bottom: controls ? (fullscreen ? 104 : 84) : 20 }]}>
        {undo ? (
          <GlassPill label={`Undo ${skipLabels[undo.part].replace('Skip ', 'skip ')}`} onPress={() => { haptics.select(); seekTo(undo.from); setUndo(null); }} />
        ) : activeSkip && !(autoSkip && playing && !dismissed.current.has(activeSkip.part)) ? (
          <GlassPill accent label={skipLabels[activeSkip.part]} onPress={() => skip(activeSkip.part, activeSkip.range, false)} />
        ) : null}
      </View>

      {started && (
        <Animated.View pointerEvents={controls ? 'box-none' : 'none'} style={[styles.barArea, fullscreen && styles.barAreaFullscreen, controlsStyle]}>
          <Glass style={styles.bar}>
            <Scrubber time={time} total={total} skips={study.skips} onSeek={(t) => { seekTo(t); poke(); }} />
            <View style={styles.row}>
              {!narrow && <IconButton name="backward.end.fill" label="Previous episode" size={18} disabled={!props.hasPrevious} onPress={() => { haptics.select(); props.onStep?.(-1, playing); }} />}
              <IconButton name="gobackward.10" label="Back 10 seconds" onPress={() => seekBy(-SKIP_SECONDS, 'left')} />
              <IconButton name={playing ? 'pause.fill' : 'play.fill'} label={playing ? 'Pause' : 'Play'} size={26} onPress={togglePlay} />
              <IconButton name="goforward.10" label="Forward 10 seconds" onPress={() => seekBy(SKIP_SECONDS, 'right')} />
              {!narrow && <IconButton name="forward.end.fill" label="Next episode" size={18} disabled={!props.hasNext} onPress={() => { haptics.select(); props.onStep?.(1, playing); }} />}
              <Text style={styles.time} numberOfLines={1}>{narrow ? clock(time) : `${clock(time)} / ${clock(total)}`}</Text>
              {pipSupported && (
                <IconButton
                  name="pip.enter"
                  label="Picture in Picture"
                  onPress={() => { haptics.select(); void videoView.current?.startPictureInPicture().catch(() => {}); poke(); }}
                />
              )}
              <IconButton
                name={subtitlesOn ? 'captions.bubble.fill' : 'captions.bubble'}
                label={subtitlesOn ? 'Hide subtitles' : 'Show subtitles'}
                tint={subtitlesOn && study.cues.length ? colors.accent : colors.text}
                disabled={!study.cues.length}
                onPress={() => { haptics.select(); props.onToggleSubtitles(); poke(); }}
              />
              <IconButton
                name={fullscreen ? 'arrow.down.right.and.arrow.up.left' : 'arrow.up.left.and.arrow.down.right'}
                label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onPress={() => { haptics.select(); props.onToggleFullscreen(!fullscreen); poke(); }}
              />
            </View>
          </Glass>
        </Animated.View>
      )}
    </Animated.View>
    </GestureDetector>
  );
}

function Scrubber({ time, total, skips, onSeek }: {
  time: number; total: number; skips: Partial<Record<SkipPart, TimeRange>>; onSeek: (time: number) => void;
}) {
  const [width, setWidth] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const fraction = total ? Math.min(1, Math.max(0, shown / total)) : 0;
  const at = (x: number) => (total ? Math.min(1, Math.max(0, x / width)) * total : 0);
  return (
    <View
      style={styles.scrubber}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => setDrag(at(e.nativeEvent.locationX))}
      onResponderMove={(e) => setDrag(at(e.nativeEvent.locationX))}
      onResponderRelease={(e) => { onSeek(at(e.nativeEvent.locationX)); setDrag(null); haptics.select(); }}
      onResponderTerminate={() => setDrag(null)}
      accessibilityRole="adjustable"
      accessibilityLabel="Playback position"
      accessibilityValue={{ text: `${clock(shown)} of ${clock(total)}` }}
    >
      <View style={styles.track}>
        {total > 0 && skipOrder.map(part => {
          const range = skips[part];
          if (!range) return null;
          return <View key={part} style={[styles.skipMark, { left: `${(range.start / total) * 100}%`, width: `${((range.end - range.start) / total) * 100}%` }]} />;
        })}
        <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
      </View>
      <View style={[styles.thumb, { left: `${fraction * 100}%` }, drag !== null && styles.thumbActive]} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#000', overflow: 'hidden' },
  inline: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.medium },
  fullscreen: { flex: 1 },
  center: { position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -48 },
  bigPlay: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center', paddingLeft: 6 },
  ripple: { position: 'absolute', top: 0, bottom: 0, width: '34%', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', gap: 4 },
  rippleLeft: { left: 0, borderTopRightRadius: 400, borderBottomRightRadius: 400 },
  rippleRight: { right: 0, borderTopLeftRadius: 400, borderBottomLeftRadius: 400 },
  rippleText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  subtitleWrap: { position: 'absolute', left: space.l, right: space.l, alignItems: 'center' },
  subtitle: {
    color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center', lineHeight: 28,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 },
    backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 10, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  subtitleLarge: { fontSize: 28, lineHeight: 38 },
  skipArea: { position: 'absolute', right: space.l, alignItems: 'flex-end' },
  barArea: { position: 'absolute', left: space.s, right: space.s, bottom: space.s },
  barAreaFullscreen: { left: space.l, right: space.l, bottom: space.xl },
  bar: { paddingHorizontal: space.s, paddingTop: space.s },
  row: { flexDirection: 'row', alignItems: 'center' },
  time: { flex: 1, color: colors.textSecondary, fontVariant: ['tabular-nums'], fontSize: 13, textAlign: 'right', marginRight: space.s },
  scrubber: { height: 24, justifyContent: 'center', marginHorizontal: space.s },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accent },
  skipMark: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.35)' },
  thumb: { position: 'absolute', width: 14, height: 14, marginLeft: -7, borderRadius: 7, backgroundColor: colors.text },
  thumbActive: { transform: [{ scale: 1.35 }], backgroundColor: colors.accent },
});
