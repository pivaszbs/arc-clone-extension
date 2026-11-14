import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { haptics } from '../lib/haptics';
import { colors, radius, space, status, type } from '../theme';

/** The shared building blocks every screen uses, so spacing, colours and states stay the same. */

export type Tone = 'ok' | 'warn' | 'danger' | 'idle' | 'accent';
const toneColor: Record<Tone, string> = { ok: status.ok, warn: status.warn, danger: status.danger, idle: status.idle, accent: colors.accent };

export function StatusDot({ tone, size = 8 }: { tone: Tone; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor[tone] }} />;
}

/** A titled group of rows, like a section in iOS Settings. */
export function Section({ title, action, children, style }: {
  title?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.section, style]}>
      {(title || action) && (
        <View style={styles.sectionHeader}>
          <Text style={type.section}>{title}</Text>
          {action}
        </View>
      )}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

/** One line in a Section: optional icon or dot, title, secondary line, and something on the right. */
export function Row({ title, detail, tone, icon, right, onPress, first, children }: {
  title: string; detail?: string | null; tone?: Tone; icon?: SFSymbol; right?: ReactNode;
  onPress?: () => void; first?: boolean; children?: ReactNode;
}) {
  const body = (
    <>
      <View style={styles.rowMain}>
        {icon ? <SymbolView name={icon} size={18} tintColor={tone ? toneColor[tone] : colors.textSecondary} style={styles.rowIcon} />
          : tone ? <View style={styles.rowDot}><StatusDot tone={tone} /></View> : null}
        <View style={styles.rowText}>
          <Text style={type.body} numberOfLines={2}>{title}</Text>
          {!!detail && <Text style={type.subhead} numberOfLines={3}>{detail}</Text>}
        </View>
        {right}
        {onPress && !right && <SymbolView name="chevron.right" size={12} tintColor={colors.textTertiary} />}
      </View>
      {children}
    </>
  );
  const rowStyle = [styles.row, !first && styles.rowDivider];
  if (!onPress) return <View style={rowStyle}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => { haptics.select(); onPress(); }}
      style={({ pressed }) => [rowStyle, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

export function Button({ title, onPress, variant = 'secondary', icon, loading, disabled, style }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'plain';
  icon?: SFSymbol; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const fg = variant === 'primary' ? colors.background : variant === 'danger' ? status.danger : variant === 'plain' ? colors.accent : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      onPress={() => { haptics.select(); onPress(); }}
      hitSlop={variant === 'plain' ? 8 : 4}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'plain' && styles.buttonPlain,
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : (
        <>
          {icon && <SymbolView name={icon} size={14} tintColor={fg} />}
          <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: Tone }) {
  const share = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}>
      <View style={[styles.fill, { width: `${share * 100}%`, backgroundColor: toneColor[tone] }]} />
    </View>
  );
}

/** A number with a label, for the top of a dashboard. */
export function Stat({ value, label, tone }: { value: string; label: string; tone?: Tone }) {
  return (
    <View style={styles.stat}>
      <Text style={[type.number, tone && { color: toneColor[tone] }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={type.caption} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export type Tab<T extends string> = { key: T; title: string; icon: SFSymbol; badge?: boolean };

/** Bottom tab bar. */
export function TabBar<T extends string>({ tabs, current, onChange, bottomInset }: {
  tabs: Tab<T>[]; current: T; onChange: (key: T) => void; bottomInset: number;
}) {
  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(bottomInset, space.s) }]}>
      {tabs.map(tab => {
        const active = tab.key === current;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityLabel={tab.title}
            accessibilityState={{ selected: active }}
            onPress={() => { if (!active) { haptics.select(); onChange(tab.key); } }}
            style={styles.tab}
          >
            <View>
              <SymbolView name={tab.icon} size={22} tintColor={active ? colors.accent : colors.textTertiary} />
              {tab.badge && <View style={styles.tabBadge} />}
            </View>
            <Text style={[styles.tabText, active && { color: colors.accent }]}>{tab.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.s },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xs, minHeight: 20 },
  group: { backgroundColor: colors.surface, borderRadius: radius.medium, borderCurve: 'continuous', overflow: 'hidden' },
  row: { paddingHorizontal: space.l, paddingVertical: space.m, gap: space.s },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 24 },
  rowIcon: { width: 20, height: 20 },
  rowDot: { width: 20, alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
  pressed: { backgroundColor: colors.surfaceRaised },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 34, paddingHorizontal: 14, borderRadius: radius.pill },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surfaceRaised },
  buttonDanger: { backgroundColor: status.dangerMuted },
  buttonPlain: { minHeight: 24, paddingHorizontal: 0 },
  buttonText: { fontSize: 14, fontWeight: '600' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  stat: { flex: 1, gap: 2 },
  tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator, backgroundColor: colors.background, paddingTop: space.s },
  tab: { flex: 1, alignItems: 'center', gap: 3, minHeight: 44, justifyContent: 'center' },
  tabText: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },
  tabBadge: { position: 'absolute', top: -1, right: -5, width: 8, height: 8, borderRadius: 4, backgroundColor: status.danger },
});
