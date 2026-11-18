// The TV's volume as one slider: drag or tap anywhere on the track to set the exact level. While the
// finger moves, levels go out at most every 120 ms, and the last one always goes out on release.
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';

import { haptics } from '../lib/haptics';
import { colors, radius, space } from '../theme';

type Props = {
  /** The TV's level (0-100), or undefined when it isn't known yet. */
  volume?: number;
  muted?: boolean;
  disabled?: boolean;
  onChange: (volume: number) => void;
  onToggleMute: () => void;
};

const SEND_EVERY_MS = 120;

export function VolumeSlider({ volume, muted, disabled, onChange, onToggleMute }: Props) {
  const [width, setWidth] = useState(0);
  /** The level under the finger, shown instead of the TV's while dragging. */
  const [dragging, setDragging] = useState<number | null>(null);
  /** The last level sent, held briefly so the next poll's older reading doesn't jump the thumb back. */
  const [pending, setPending] = useState<number | null>(null);
  const lastSent = useRef({ at: 0, level: -1 });
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (pendingTimer.current) clearTimeout(pendingTimer.current); }, []);

  const levelAt = (x: number) => (width > 0 ? Math.round(Math.max(0, Math.min(1, x / width)) * 100) : 0);

  const send = (level: number, force: boolean) => {
    const now = Date.now();
    if (level === lastSent.current.level) return;
    if (!force && now - lastSent.current.at < SEND_EVERY_MS) return;
    lastSent.current = { at: now, level };
    if (level % 10 === 0) haptics.select();
    onChange(level);
  };

  const release = (level: number) => {
    send(level, true);
    setDragging(null);
    setPending(level);
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => setPending(null), 5000);
  };

  const pan = usePanGesture({
    runOnJS: true,
    enabled: !disabled && width > 0,
    // Sideways sets the volume; a mostly vertical drag stays a scroll.
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onActivate: event => { const level = levelAt(event.x); setDragging(level); send(level, false); },
    onUpdate: event => { const level = levelAt(event.x); setDragging(level); send(level, false); },
    onDeactivate: event => release(levelAt(event.x)),
  });

  const shown = dragging ?? pending ?? volume;
  const fraction = shown === undefined ? 0 : shown / 100;
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
        disabled={disabled}
        onPress={() => { haptics.select(); onToggleMute(); }}
        hitSlop={8}
        style={({ pressed }) => [styles.mute, pressed && styles.pressed]}
      >
        <SymbolView name={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'} size={18} tintColor={muted ? colors.textSecondary : colors.text} />
      </Pressable>

      <GestureDetector gesture={pan}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="TV volume"
          accessibilityValue={{ min: 0, max: 100, now: shown ?? 0 }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={event => {
            const step = event.nativeEvent.actionName === 'increment' ? 5 : -5;
            release(Math.max(0, Math.min(100, (shown ?? 0) + step)));
          }}
          disabled={disabled}
          onPress={event => release(levelAt(event.nativeEvent.locationX))}
          onLayout={onLayout}
          style={styles.hit}
        >
          <View style={styles.track} pointerEvents="none">
            <View style={[styles.fill, { width: `${fraction * 100}%` }, muted && styles.fillMuted]} />
          </View>
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: Math.max(0, fraction * width - THUMB / 2) }, dragging !== null && styles.thumbActive]}
          />
        </Pressable>
      </GestureDetector>

      <Text style={styles.value}>{shown === undefined ? '–' : shown}</Text>
    </View>
  );
}

const THUMB = 26;
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.m,
    backgroundColor: colors.surface, borderRadius: radius.medium, paddingHorizontal: space.m, paddingVertical: space.s,
  },
  disabled: { opacity: 0.4 },
  mute: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  hit: { flex: 1, height: 44, justifyContent: 'center' },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 8, backgroundColor: colors.accent },
  fillMuted: { backgroundColor: colors.textTertiary },
  thumb: {
    position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2, top: (44 - THUMB) / 2,
    backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  thumbActive: { transform: [{ scale: 1.15 }] },
  value: { width: 30, textAlign: 'right', color: colors.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.6 },
});
