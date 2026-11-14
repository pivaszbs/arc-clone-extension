import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { haptics } from '../lib/haptics';
import { colors, radius } from '../theme';

export type SwipeAction = { label: string; icon: SymbolViewProps['name']; color: string; onCommit: () => void };

type Props = {
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Revealed by swiping right. */
  right?: SwipeAction;
  /** Revealed by swiping left. */
  left?: SwipeAction;
  children: React.ReactNode;
};

const THRESHOLD = 88;
const FLICK_VELOCITY = 800;
const PRESS_EASE = Easing.bezier(0.23, 1, 0.32, 1);
const SNAP_BACK = { duration: 400, dampingRatio: 0.8 } as const;

/**
 * A card that presses like a button and swipes like a Mail row: past the threshold (or flicked)
 * it commits that side's action, then springs home with the finger's velocity.
 */
export function SwipeCard({ style, onPress, accessibilityLabel, right, left, children }: Props) {
  const x = useSharedValue(0);
  const scale = useSharedValue(1);
  const armed = useSharedValue(0);
  const reduced = useReducedMotion();
  const hasRight = !!right;
  const hasLeft = !!left;
  const commitRight = () => { haptics.tap(); right?.onCommit(); };
  const commitLeft = () => { haptics.tap(); left?.onCommit(); };

  const pan = usePanGesture({
    // Horizontal only: a vertical move hands the touch to the list's scroll.
    activeOffsetX: [-14, 14],
    failOffsetY: [-10, 10],
    onUpdate: event => {
      'worklet';
      const raw = event.translationX;
      // Rubber band toward a side with no action.
      const t = (raw > 0 && !hasRight) || (raw < 0 && !hasLeft) ? raw / 4 : raw;
      x.set(t);
      const side = t > THRESHOLD && hasRight ? 1 : t < -THRESHOLD && hasLeft ? -1 : 0;
      if (side !== armed.get()) {
        armed.set(side);
        if (side !== 0) scheduleOnRN(haptics.select);
      }
    },
    onDeactivate: event => {
      'worklet';
      const t = event.translationX;
      const v = event.velocityX;
      const flicked = Math.abs(v) > FLICK_VELOCITY && Math.abs(t) > 36;
      if ((t > THRESHOLD || (flicked && v > 0)) && hasRight) scheduleOnRN(commitRight);
      else if ((t < -THRESHOLD || (flicked && v < 0)) && hasLeft) scheduleOnRN(commitLeft);
      armed.set(0);
      x.set(withSpring(0, { ...SNAP_BACK, velocity: v }));
    },
  });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { scale: scale.get() }],
  }));
  const rightReveal = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [0, THRESHOLD * 0.6, THRESHOLD], [0, 0.6, 1], 'clamp'),
    transform: [{ scale: interpolate(x.get(), [THRESHOLD * 0.5, THRESHOLD], [0.85, 1], 'clamp') }],
  }));
  const leftReveal = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [-THRESHOLD, -THRESHOLD * 0.6, 0], [1, 0.6, 0], 'clamp'),
    transform: [{ scale: interpolate(x.get(), [-THRESHOLD, -THRESHOLD * 0.5], [1, 0.85], 'clamp') }],
  }));

  const press = (to: number) => {
    if (!reduced) scale.set(withTiming(to, { duration: 120, easing: PRESS_EASE }));
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
        <Animated.View style={cardStyle}>
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
            onPress={onPress}
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
