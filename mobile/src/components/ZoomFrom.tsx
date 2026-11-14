import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** Where on screen a transition starts: the card or button that was tapped. */
export type Rect = { x: number; y: number; width: number; height: number };

type Measurable = { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void };

/** Measure the view an event came from, for ZoomFrom. Resolves null if it can't be measured. */
export function rectOf(target: unknown): Promise<Rect | null> {
  return new Promise(resolve => {
    const view = target as Measurable | null;
    if (!view?.measureInWindow) return resolve(null);
    const timer = setTimeout(() => resolve(null), 120);
    view.measureInWindow((x, y, width, height) => {
      clearTimeout(timer);
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  });
}

/**
 * Grows its content out of `origin` (the tapped card) into its own frame, like iOS's zoom
 * transition: it starts at the card's size and place and springs open. Without an origin (or if
 * measuring fails) it fades in. React Native's Animated on the native driver: Reanimated's
 * animations didn't reach the screen in this app.
 */
/** Lets the owner close the screen by shrinking it back into the card it came from. */
export type ZoomHandle = { collapse(done: () => void): void };

export function ZoomFrom({ origin, children, style, contentStyle, backdrop, ref }: {
  origin?: Rect | null; children: ReactNode; style?: StyleProp<ViewStyle>;
  /** Style of the growing card itself (give it the screen's background, so only the card is opaque). */
  contentStyle?: StyleProp<ViewStyle>;
  /** Colour the screen behind fades to while the card grows, like a modal; behind stays visible at first. */
  backdrop?: string;
  ref?: Ref<ZoomHandle>;
}) {
  const frame = useRef<Measurable | null>(null);
  const [progress] = useState(() => new Animated.Value(0));
  const [geometry, setGeometry] = useState({ dx: 0, dy: 0, scale: 1 });
  const started = useRef(false);

  const open = (next?: { dx: number; dy: number; scale: number }) => {
    if (next) {
      setGeometry(next);
      Animated.spring(progress, { toValue: 1, damping: 24, stiffness: 140, mass: 1.1, useNativeDriver: true }).start();
    } else {
      Animated.timing(progress, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    }
  };

  // Never leave the screen invisible: if measuring hasn't answered quickly, just fade in.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!started.current) { started.current = true; open(); }
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => {
    const node = frame.current;
    if (started.current || !node?.measureInWindow) return;
    node.measureInWindow((x, y, width, height) => {
      if (started.current) return;
      started.current = true;
      if (origin && width > 0 && height > 0) {
        open({
          dx: origin.x + origin.width / 2 - (x + width / 2),
          dy: origin.y + origin.height / 2 - (y + height / 2),
          // Start no bigger than the card on either side, so a wide card still visibly grows.
          scale: Math.max(0.05, Math.min(1, origin.width / width, origin.height / height)),
        });
      } else {
        open();
      }
    });
  };

  useImperativeHandle(ref, () => ({
    collapse(done) {
      // Back into the card it came from (or a fade when it didn't come from one).
      Animated.timing(progress, { toValue: 0, duration: 280, useNativeDriver: true }).start(() => done());
    },
  }), [progress]);

  const animated = {
    opacity: progress.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' as const }),
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [geometry.dx, 0] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [geometry.dy, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [geometry.scale, 1] }) },
    ],
  };

  return (
    <View ref={frame as never} onLayout={start} style={[styles.fill, style]} collapsable={false}>
      {backdrop ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: backdrop, opacity: progress }]} /> : null}
      <Animated.View style={[styles.frame, contentStyle, animated]}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  frame: { flex: 1, overflow: 'hidden' },
});
