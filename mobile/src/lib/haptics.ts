import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// iPads have no Taptic Engine, so stay quiet there instead of making calls that do nothing.
const enabled = Platform.OS === 'ios' && !Platform.isPad;

export const haptics = {
  tap: () => { if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); },
  seek: () => { if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); },
  select: () => { if (enabled) void Haptics.selectionAsync(); },
  skipped: () => { if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); },
  edge: () => { if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid); },
};
