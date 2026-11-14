// Matches the extension's offline study page.
export const colors = {
  background: '#0e0e10',
  surface: '#17171b',
  surfaceRaised: '#202026',
  separator: 'rgba(255,255,255,0.08)',
  text: '#f4f4f6',
  textSecondary: 'rgba(244,244,246,0.62)',
  textTertiary: 'rgba(244,244,246,0.4)',
  accent: '#ff8248',
  accentMuted: 'rgba(255,130,72,0.18)',
  glassTint: 'rgba(14,14,16,0.35)',
} as const;

export const radius = { small: 8, medium: 14, large: 22, pill: 999 } as const;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

/** Status colours, used wherever something is healthy, waiting or failing. */
export const status = {
  ok: '#34d399',
  okMuted: 'rgba(52,211,153,0.16)',
  warn: '#fbbf24',
  warnMuted: 'rgba(251,191,36,0.16)',
  danger: '#f87171',
  dangerMuted: 'rgba(248,113,113,0.14)',
  idle: 'rgba(244,244,246,0.4)',
} as const;

/** Text styles. Screens use these instead of picking font sizes. */
export const type = {
  largeTitle: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.4 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  headline: { color: colors.text, fontSize: 16, fontWeight: '600' },
  body: { color: colors.text, fontSize: 15, fontWeight: '400', lineHeight: 20 },
  subhead: { color: colors.textSecondary, fontSize: 13, fontWeight: '400', lineHeight: 18 },
  caption: { color: colors.textTertiary, fontSize: 12, fontWeight: '500' },
  /** Small capitals above a group of rows. */
  section: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  /** Numbers that should line up: counts, times, progress. */
  number: { color: colors.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
} as const satisfies Record<string, import('react-native').TextStyle>;
