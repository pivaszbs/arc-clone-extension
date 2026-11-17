import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo';

export type HardwareKey = 'space' | 'left' | 'right' | 'escape';

type NativeKeyCommands = {
  addListener(event: 'onKey', listener: (event: { key: HardwareKey }) => void): EventSubscription;
};

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativeKeyCommands>('KeyCommands') : null;

/**
 * Calls `onKey` for hardware keyboard presses (iPad keyboard, Mac) while `enabled`.
 * No-op where the native module is missing (web, Expo Go, Android).
 */
export function useHardwareKeys(onKey: (key: HardwareKey) => void, enabled = true) {
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!native || !enabled) return;
    const subscription = native.addListener('onKey', ({ key }) => latest.current(key));
    return () => subscription.remove();
  }, [enabled]);
}
