import type { EffectiveAppearance } from '@ficus/shared/theme-schema'
import type { CustomThemeDocument } from '@ficus/shared/custom-theme'
import { applyResolvedTheme } from './apply'
import { applyCustomTheme, removeCustomProperties } from './custom'
import type { WebThemeDefinition } from './registry'

/**
 * Full repaint of one root/element: pure DOM, never touches storage or the
 * store. Shared by every whole-app preview path — ThemeQuickPicker's hover
 * preview AND CustomThemeEditor's whole-app live preview — so preview/restore
 * and the real applied theme never drift from each other.
 */
export function paintRoot(
  root: HTMLElement,
  theme: WebThemeDefinition,
  appearance: EffectiveAppearance,
  custom: CustomThemeDocument | null
) {
  removeCustomProperties(root)
  applyResolvedTheme(root, theme, appearance)
  if (!custom) return
  try {
    applyCustomTheme(root, custom, appearance)
  } catch {
    // Preview/restore never mutates the store or recovers persisted state
    // (that belongs to ThemeProvider); fall back to the plain builtin paint.
    removeCustomProperties(root)
  }
}
