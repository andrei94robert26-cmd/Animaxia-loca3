/**
 * theme/index.ts — Animaxia Mobile design tokens.
 *
 * Dark "cinema" palette matching the web console: near-black backgrounds,
 * zinc text and a rose accent (plus = rose, pro = amber, success = emerald).
 * No indigo/blue anywhere — the brand is rose on charcoal.
 */

export const colors = {
  bg: '#0a0a10',
  bgSoft: '#101018',
  card: '#14141d',
  cardSoft: '#191924',
  border: '#26262f',
  borderSoft: '#1d1d27',

  text: '#f4f4f5',
  textMuted: '#a1a1aa',
  textDim: '#71717a',

  rose: '#f43f5e',
  roseSoft: '#fb7185',
  roseDark: '#881337',
  fuchsia: '#d946ef',
  emerald: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  zinc: '#a1a1aa',

  overlay: 'rgba(0,0,0,0.55)',
  skeleton: '#1b1b26',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  title: 26,
  h1: 22,
  h2: 18,
  body: 15,
  small: 13,
  tiny: 11,
} as const;

/** Plan key → accent color used for badges and highlights. */
export const planColor: Record<string, string> = {
  free: colors.zinc,
  plus: colors.rose,
  pro: colors.amber,
};

/** Content type → badge color. */
export const typeColor: Record<string, string> = {
  anime: colors.rose,
  movie: colors.fuchsia,
  tv: colors.emerald,
  sports: colors.amber,
  news: colors.zinc,
  mined: colors.zinc,
};
