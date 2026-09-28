/**
 * One colour triple per built-in theme and appearance, for surfaces that paint a theme without its CSS (a native
 * canvas, a widget, a preview tile).
 *
 * - `background` is the theme's `--color-bg-page`, `foreground` its `--color-text-primary` and `accent` its
 *   `--color-primary`, read from `apps/web/src/index.css` (Iris) and `apps/web/src/theme/builtins.css` (every other
 *   built-in).
 * - Every value is a lowercase `#rrggbb` hex string. The CSS stores these tokens as space-separated sRGB channels
 *   (`63 107 79`), so each triple is the same colour, written as hex.
 * - `accent` is the accent fill (buttons, selected state), not a text colour: it is not guaranteed to reach 3:1 as
 *   text on `background` (Iris dark's `#5b21b6` on `#090a12` is about 2.2:1).
 * - Keys are the built-in theme ids. A theme with one constant appearance repeats the same triple for light and dark.
 *
 * `apps/web/src/theme/themeTriples.test.ts` checks every value against the CSS, so the two cannot drift.
 */
export interface ThemeTriple {
  background: string
  foreground: string
  accent: string
}

export const THEME_TRIPLES: Readonly<Record<string, { light: ThemeTriple; dark: ThemeTriple }>> = {
  ficus: {
    light: { background: '#f1e9db', foreground: '#29241e', accent: '#3f6b4f' },
    dark: { background: '#1c1a17', foreground: '#ede6de', accent: '#9fb57f' },
  },
  iris: {
    light: { background: '#faf9fc', foreground: '#252332', accent: '#5b21b6' },
    dark: { background: '#090a12', foreground: '#e2e8f0', accent: '#5b21b6' },
  },
  harbor: {
    light: { background: '#f4f9fa', foreground: '#162b34', accent: '#0e5f6d' },
    dark: { background: '#0b161e', foreground: '#e6f3f6', accent: '#126776' },
  },
  ember: {
    light: { background: '#fcf8f3', foreground: '#35261e', accent: '#97371d' },
    dark: { background: '#1b1412', foreground: '#faebdd', accent: '#a23f22' },
  },
  nurebairo: {
    light: { background: '#21191f', foreground: '#dde9f4', accent: '#cf717a' },
    dark: { background: '#21191f', foreground: '#dde9f4', accent: '#cf717a' },
  },
  phosphorus: {
    light: { background: '#d3e0d5', foreground: '#263c34', accent: '#62517a' },
    dark: { background: '#d3e0d5', foreground: '#263c34', accent: '#62517a' },
  },
  yamabukiiro: {
    light: { background: '#e0aa24', foreground: '#30261a', accent: '#64204f' },
    dark: { background: '#e0aa24', foreground: '#30261a', accent: '#64204f' },
  },
  moegiiro: {
    light: { background: '#286a3c', foreground: '#f7eaf8', accent: '#ffda52' },
    dark: { background: '#286a3c', foreground: '#f7eaf8', accent: '#ffda52' },
  },
  adzukiiro: {
    light: { background: '#803653', foreground: '#f2d8f5', accent: '#bcc9dd' },
    dark: { background: '#803653', foreground: '#f2d8f5', accent: '#bcc9dd' },
  },
  asagiiro: {
    light: { background: '#355f7b', foreground: '#fff6ec', accent: '#ffd65a' },
    dark: { background: '#355f7b', foreground: '#fff6ec', accent: '#ffd65a' },
  },
  'high-contrast': {
    light: { background: '#ffffff', foreground: '#000000', accent: '#000000' },
    dark: { background: '#ffffff', foreground: '#000000', accent: '#000000' },
  },
}
