import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type React from 'react';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';

import { haptics } from '../lib/haptics';
import { colors, radius } from '../theme';

export type SwipeAction = { label: string; icon: SymbolViewProps['name']; color: string; onCommit: () => void };

type Props = {
  style?: StyleProp<ViewStyle>;
  /** Gets the pressed card, so a transition can start from it (see ZoomFrom.rectOf). */
  onPress: (target: unknown) => void;
  accessibilityLabel?: string;
  /** Revealed by swiping right. */
  right?: SwipeAction;
  /** Revealed by swiping left. */
  left?: SwipeAction;
  children: React.ReactNode;
};

const THRESHOLD = 88;
const FLICK_VELOCITY = 800;

/**
 * A card that presses like a button and swipes like a Mail row: past the threshold (or flicked)
 * it commits that side's action, then springs home with the finger's velocity.
 * React Native's Animated on the native driver (Reanimated's animations didn't reach the screen here).
 */
export function SwipeCard({ style, onPress, accessibilityLabel, right, left, children }: Props) {
  const [x] = useState(() => new Animated.Value(0));
  const [scale] = useState(() => new Animated.Value(1));
  const armed = useRef(0);

  const pan = usePanGesture({
    runOnJS: true,
    // Horizontal only: a vertical move hands the touch to the list's scroll.
    activeOffsetX: [-14, 14],
    failOffsetY: [-10, 10],
    onUpdate: event => {
      const raw = event.translationX;
      // Rubber band toward a side with no action.
      const t = (raw > 0 && !right) || (raw < 0 && !left) ? raw / 4 : raw;
      x.setValue(t);
      const side = t > THRESHOLD && right ? 1 : t < -THRESHOLD && left ? -1 : 0;
      if (side !== armed.current) {
        armed.current = side;
        if (side !== 0) haptics.select();
      }
    },
    onDeactivate: event => {
      const t = event.translationX;
      const v = event.velocityX;
      const flicked = Math.abs(v) > FLICK_VELOCITY && Math.abs(t) > 36;
      if ((t > THRESHOLD || (flicked && v > 0)) && right) { haptics.tap(); right.onCommit(); }
      else if ((t < -THRESHOLD || (flicked && v < 0)) && left) { haptics.tap(); left.onCommit(); }
      armed.current = 0;
      Animated.spring(x, { toValue: 0, velocity: v / 1000, bounciness: 4, useNativeDriver: true }).start();
    },
  });

  const rightReveal = {
    opacity: x.interpolate({ inputRange: [0, THRESHOLD * 0.6, THRESHOLD], outputRange: [0, 0.6, 1], extrapolate: 'clamp' }),
    transform: [{ scale: x.interpolate({ inputRange: [THRESHOLD * 0.5, THRESHOLD], outputRange: [0.85, 1], extrapolate: 'clamp' }) }],
  };
  const leftReveal = {
    opacity: x.interpolate({ inputRange: [-THRESHOLD, -THRESHOLD * 0.6, 0], outputRange: [1, 0.6, 0], extrapolate: 'clamp' }),
    transform: [{ scale: x.interpolate({ inputRange: [-THRESHOLD, -THRESHOLD * 0.5], outputRange: [1, 0.85], extrapolate: 'clamp' }) }],
  };

  const press = (to: number) => {
    Animated.timing(scale, { toValue: to, duration: 120, useNativeDriver: true }).start();
  };

  return (
    <View style={style}>
      {right && (
        <Animated.View pointerEvents="none" style={[styles.reveal, styles.revealLeftSide, { backgroundColor: right.color }, rightReveal]}>
          <SymbolView name={right.icon} size={22} tintColor="#fff" />
          <Text style={styles.revealText}>{right.label}</Text>
        </Animated.View>
      )}
      {left && (
        <Animated.View pointerEvents="none" style={[styles.reveal, styles.revealRightSide, { backgroundColor: left.color }, leftReveal]}>
          <Text style={styles.revealText}>{left.label}</Text>
          <SymbolView name={left.icon} size={22} tintColor="#fff" />
        </Animated.View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View style={{ transform: [{ translateX: x }, { scale }] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityActions={[
              ...(right ? [{ name: 'right', label: right.label }] : []),
              ...(left ? [{ name: 'left', label: left.label }] : []),
            ]}
            onAccessibilityAction={event => {
              if (event.nativeEvent.actionName === 'right') right?.onCommit();
              if (event.nativeEvent.actionName === 'left') left?.onCommit();
            }}
            onPressIn={() => press(0.97)}
            onPressOut={() => press(1)}
            onPress={event => onPress(event.currentTarget)}
            pressRetentionOffset={12}
          >
            {children}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  reveal: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.medium,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 22,
  },
  revealLeftSide: { justifyContent: 'flex-start' },
  revealRightSide: { justifyContent: 'flex-end' },
  revealText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

export const swipeColors = { watched: '#2f9e6e', download: colors.accent, remove: '#d9534f' } as const;
