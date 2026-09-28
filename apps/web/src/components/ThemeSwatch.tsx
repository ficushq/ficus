import { useLayoutEffect, useRef } from 'react'
import clsx from 'clsx'
import type { CustomThemeDocument, EffectiveAppearance } from '@ficus/shared'
import { findWebTheme, type WebThemeDefinition } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { applyCustomTheme, removeCustomProperties } from '../theme/custom'

export type ThemeSwatchSpec =
  | { kind: 'builtin'; theme: WebThemeDefinition; appearance: 'light' | 'dark' }
  | { kind: 'preset'; document: CustomThemeDocument; appearance: EffectiveAppearance }

/**
 * One theme circle's paint: shared by ThemeQuickPicker's circles, the
 * Settings theme grid, and the "My themes" library rows, so the three surfaces
 * can never drift out of sync on how a theme's swatch resolves. See
 * design-system.css's `.theme-swatch` doc comment for why the outline lives
 * in that class as an inset box-shadow rather than a per-caller `border`.
 *
 * A built-in theme paints declaratively: `[data-theme-scope][data-theme][data-appearance]`
 * scoping in builtins.css resolves its real tokens onto this element, so no
 * JS ever computes a built-in's colors. A preset has no static CSS rule (its
 * overrides are an arbitrary per-document palette/token set), so it paints
 * imperatively via the same applyResolvedTheme → applyCustomTheme DOM path
 * the live preview and the custom-theme editor use — falling back to the
 * plain base paint (never a blank circle) if the document fails to apply.
 */
/** Paints a preset's document onto one swatch element (or half), falling back to the plain base paint. */
function paintPreset(element: HTMLElement, document: CustomThemeDocument, appearance: EffectiveAppearance) {
  const base = findWebTheme(document.base)
  removeCustomProperties(element)
  applyResolvedTheme(element, base, appearance)
  try {
    applyCustomTheme(element, document, appearance)
  } catch {
    removeCustomProperties(element)
  }
}

const APPEARANCES = ['light', 'dark'] as const

export function ThemeSwatch({
  spec,
  ring,
  className,
}: {
  spec: ThemeSwatchSpec
  /** A picker's ring around the circle, in the circle's own theme colour: `on`, `dim`, or none. */
  ring?: 'on' | 'dim'
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const halves = useRef<(HTMLSpanElement | null)[]>([])
  // A theme with both appearances shows both halves (see design-system.css's .theme-swatch-half).
  const split = (spec.kind === 'builtin' ? spec.theme : findWebTheme(spec.document.base)).kind === 'dual'
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || spec.kind !== 'preset') return
    // The circle itself carries the current appearance, which its ring uses; each half its own.
    paintPreset(element, spec.document, spec.appearance)
    if (split)
      APPEARANCES.forEach(
        (appearance, i) => halves.current[i] && paintPreset(halves.current[i]!, spec.document, appearance)
      )
  }, [spec, split])

  const classes = clsx('theme-swatch block', split && 'theme-swatch-split', className)
  if (spec.kind === 'builtin')
    return (
      <span
        data-theme-scope=""
        data-theme={spec.theme.id}
        data-appearance={spec.theme.kind === 'unified' ? undefined : spec.appearance}
        data-ring={ring}
        className={classes}
      >
        {split &&
          APPEARANCES.map((appearance) => (
            <span
              key={appearance}
              data-theme-scope=""
              data-theme={spec.theme.id}
              data-appearance={appearance}
              className="theme-swatch-half"
            />
          ))}
      </span>
    )
  return (
    <span ref={ref} data-theme-scope="" data-ring={ring} className={classes}>
      {split &&
        APPEARANCES.map((appearance, i) => (
          <span
            key={appearance}
            ref={(element) => {
              halves.current[i] = element
            }}
            data-theme-scope=""
            data-appearance={appearance}
            className="theme-swatch-half"
          />
        ))}
    </span>
  )
}
