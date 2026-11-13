import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type DeviceHealth = {
  power: 'charging' | 'full' | 'battery' | 'unknown';
  batteryLevel?: number; // 0–1
  thermal: 'nominal' | 'fair' | 'serious' | 'critical';
  lowPowerMode: boolean;
};

type NativeDeviceHealth = { getHealthAsync(): Promise<DeviceHealth> };

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativeDeviceHealth>('DeviceHealth') : null;

/** Current device health, or null when the native module isn't available (web, Expo Go, Android). */
export async function getDeviceHealth(): Promise<DeviceHealth | null> {
  if (!native) return null;
  try {
    return await native.getHealthAsync();
  } catch {
    return null;
  }
}
