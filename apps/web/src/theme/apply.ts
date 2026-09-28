import type { EffectiveAppearance } from '@ficus/shared'
import type { WebThemeDefinition } from './registry'

/**
 * Applies a resolved theme to the document root:
 *
 * - `data-theme="<theme id>"` and `data-appearance="light|dark"` on <html>
 *   (unified themes omit `data-appearance` — they have no variant);
 * - the theme's variant class, keeping the literal `dark` class for the tau
 *   dark variant so existing Tailwind `dark:` variants keep working during
 *   the migration.
 *
 * Kept as a pure DOM function so both the provider and tests can drive it.
 */
export function applyResolvedTheme(
  root: HTMLElement,
  theme: WebThemeDefinition,
  appearance: EffectiveAppearance
): void {
  root.setAttribute('data-theme', theme.id)
  if (appearance === 'constant') {
    root.removeAttribute('data-appearance')
  } else {
    root.setAttribute('data-appearance', appearance)
  }

  const activeClass = theme.variantClass[appearance] ?? null
  const allVariantClasses = new Set(
    Object.values(theme.variantClass).filter((cls): cls is string => typeof cls === 'string')
  )
  // The literal `dark` class is the migration bridge for existing Tailwind
  // dark: variants (report §4.1); every resolution manages it explicitly so a
  // unified theme or a variant switch never leaves it behind.
  allVariantClasses.add('dark')
  for (const cls of allVariantClasses) {
    if (cls !== activeClass) root.classList.remove(cls)
  }
  if (activeClass) root.classList.add(activeClass)
}
