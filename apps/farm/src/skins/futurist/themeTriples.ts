import type { ThemePreference } from '@ficus/shared'

/**
 * Stand-in for `@ficus/shared/theme-triples`, which rename Task 32 adds with
 * exactly this shape (each built-in theme's page background, primary text and
 * primary colour, per appearance, keyed by final theme id). Until then the
 * table is empty and the Futurist style uses its own palette; swap this import for
 * the shared module when it lands.
 */
export interface ThemeTriple {
  background: string
  foreground: string
  accent: string
}

export const THEME_TRIPLES: Readonly<Record<string, { light: ThemeTriple; dark: ThemeTriple }>> = {}

/** Futurist's own palette: near-black, cyan lines, magenta for what's alive. */
export const FUTURIST_DEFAULT: ThemeTriple = { background: '#05070a', foreground: '#8fe3ff', accent: '#ff4fd8' }

/**
 * The three colours the Futurist style should use for someone's theme choice:
 * their theme's triple (custom themes use their base theme; unknown ids fall
 * back to `ficus`), light or dark by their appearance setting (`system`
 * follows the OS), else Futurist's own palette.
 */
export function tripleFor(
  preference: Pick<ThemePreference, 'themeId' | 'appearance'> | null | undefined,
  prefersDark: boolean,
  table: Readonly<Record<string, { light: ThemeTriple; dark: ThemeTriple }>> = THEME_TRIPLES
): ThemeTriple {
  const id = preference?.themeId.replace(/^custom:/, '') ?? 'ficus'
  const entry = table[id] ?? table.ficus
  if (!entry) return FUTURIST_DEFAULT
  const dark = preference?.appearance === 'dark' || (preference?.appearance !== 'light' && prefersDark)
  return dark ? entry.dark : entry.light
}
