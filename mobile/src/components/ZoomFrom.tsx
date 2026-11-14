import { useRef, type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

/** Where on screen a transition starts: the card or button that was tapped. */
export type Rect = { x: number; y: number; width: number; height: number };

/** Measure the view an event came from, for ZoomFrom. Resolves null if it can't be measured. */
export function rectOf(target: unknown): Promise<Rect | null> {
  return new Promise(resolve => {
    const view = target as { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void } | null;
    if (!view?.measureInWindow) return resolve(null);
    view.measureInWindow((x, y, width, height) => resolve(width > 0 && height > 0 ? { x, y, width, height } : null));
  });
}

/**
 * Grows its content out of `origin` (the tapped card) into its own frame, like iOS's zoom
 * transition: it starts at the card's size and place with rounded corners and springs open.
 * Without an origin it just fades in. Runs on the UI thread (Reanimated).
 */
export function ZoomFrom({ origin, children, style }: { origin?: Rect | null; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const view = useRef<{ measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void } | null>(null);
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const from = useSharedValue({ dx: 0, dy: 0, scale: 1 });
  const started = useRef(false);

  const start = () => {
    if (started.current) return;
    started.current = true;
    view.current?.measureInWindow((x, y, width, height) => {
      if (origin && width > 0 && height > 0 && !reduced) {
        from.set({
          dx: origin.x + origin.width / 2 - (x + width / 2),
          dy: origin.y + origin.height / 2 - (y + height / 2),
          scale: Math.max(0.05, Math.min(1, origin.width / width)),
        });
        progress.set(withSpring(1, { duration: 450, dampingRatio: 0.86 }));
      } else {
        progress.set(withTiming(1, { duration: 200 }));
      }
    });
  };

  const animated = useAnimatedStyle(() => {
    const t = progress.get();
    const { dx, dy, scale } = from.get();
    return {
      opacity: interpolate(t, [0, 0.2], [0, 1], 'clamp'),
      borderRadius: interpolate(t, [0, 1], [18, 0], 'clamp'),
      transform: [
        { translateX: dx * (1 - t) },
        { translateY: dy * (1 - t) },
        { scale: scale + (1 - scale) * t },
      ],
    };
  });

  return (
    <Animated.View ref={view as never} onLayout={start} style={[styles.frame, style, animated]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden' },
});
