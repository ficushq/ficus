import { THEME_TRIPLES, type ThemeTriple } from '@ficus/shared/theme-triples'
import type { ThemePreference } from '@ficus/shared'

export type { ThemeTriple }

/** Futurist's own palette: near-black, cyan lines, magenta for what's alive (when there's no theme to read). */
export const FUTURIST_DEFAULT: ThemeTriple = { background: '#05070a', foreground: '#8fe3ff', accent: '#ff4fd8' }

/**
 * The three colours the Futurist style should use for someone's theme choice:
 * their theme's triple from `@ficus/shared/theme-triples` (a custom theme's
 * `themeId` is its base theme; unknown ids fall back to `ficus`), light or
 * dark by their appearance setting (`system` follows the OS), else
 * Futurist's own palette.
 */
export function tripleFor(
  preference: Pick<ThemePreference, 'themeId' | 'appearance'> | null | undefined,
  prefersDark: boolean,
  table: Readonly<Record<string, { light: ThemeTriple; dark: ThemeTriple }>> = THEME_TRIPLES
): ThemeTriple {
  const entry = table[preference?.themeId ?? 'ficus'] ?? table.ficus
  if (!entry) return FUTURIST_DEFAULT
  const dark = preference?.appearance === 'dark' || (preference?.appearance !== 'light' && prefersDark)
  return dark ? entry.dark : entry.light
}
