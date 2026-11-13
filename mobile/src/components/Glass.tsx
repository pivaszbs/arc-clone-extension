import { BlurView } from 'expo-blur';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '../theme';

/** Frosted-glass surface used by the player controls. */
export function Glass({ children, style, round = radius.large }: { children: ReactNode; style?: StyleProp<ViewStyle>; round?: number }) {
  return (
    <View style={[styles.clip, { borderRadius: round }, style]}>
      <BlurView intensity={45} tint="systemChromeMaterialDark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, styles.tint]} />
      {children}
    </View>
  );
}

export function IconButton({ name, label, onPress, size = 22, disabled, tint = colors.text }: {
  name: SFSymbol; label: string; onPress: () => void; size?: number; disabled?: boolean; tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.icon, { opacity: disabled ? 0.3 : pressed ? 0.55 : 1 }]}
    >
      <SymbolView name={name} size={size} tintColor={tint} />
    </Pressable>
  );
}

export function GlassPill({ label, onPress, accent }: { label: string; onPress: () => void; accent?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Glass round={radius.pill} style={accent ? styles.accentBorder : undefined}>
        <Text style={[styles.pillText, accent && { color: colors.accent }]}>{label}</Text>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)' },
  tint: { backgroundColor: colors.glassTint },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pillText: { color: colors.text, fontSize: 15, fontWeight: '600', paddingHorizontal: 18, paddingVertical: 10 },
  accentBorder: { borderColor: colors.accent },
});
