/**
 * utils/theme.ts — Animaxia Desktop design tokens (JS mirror of the CSS
 * variables in globals.css). Dark "cinema" palette: near-black backgrounds,
 * zinc text, rose accent (plus = rose, pro = amber, success = emerald).
 * No indigo/blue anywhere — the brand is rose on charcoal.
 *
 * The renderer paints with CSS classes from globals.css; these tokens exist
 * for the few places that need literal colors in JS (canvas, inline styles).
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

/** Plan key → accent color used for badges and highlights. */
export const planColor: Record<string, string> = {
  free: colors.zinc,
  plus: colors.rose,
  pro: colors.amber,
};

export type ThemeSetting = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

/** Apply the resolved theme to the document root (globals.css switches vars). */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
}
