import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ThemePreset } from '@ficus/shared'
import type { useTheme } from '../providers/ThemeProvider'
import {
  BUILT_IN_THEMES,
  findWebTheme,
  highContrastLast,
  THEME_PICKER_ENABLED,
  type WebThemeDefinition,
} from '../theme/registry'
import { presetAppearance } from '../theme/custom'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { hasAppearances, useThemeHoverPreview } from '../hooks/useThemeHoverPreview'
import { PaletteIcon } from './icons'
import { ThemeSwatch } from './ThemeSwatch'
import { SegmentedAppearanceControl } from './SegmentedAppearanceControl'

type Circle =
  | { kind: 'builtin'; id: string; label: string; theme: WebThemeDefinition }
  // Phase 2: a circle for a foreign/shared preset only needs enough of
  // ThemePreset to paint its swatch and re-apply it (id, document, owner) —
  // never the full server DTO, since the quick picker synthesizes one for
  // the currently-active shared preset without an extra fetch (see below).
  | { kind: 'preset'; id: string; label: string; preset: Pick<ThemePreset, 'id' | 'document' | 'owner'> }

// Hoisted so a caller that never passes `presets` (auth-disabled instances,
// or before the query resolves) doesn't create a new empty array every
// render, which would otherwise cost an extra effect run below on each of
// this component's re-renders for no reason.
const EMPTY: ThemePreset[] = []

/**
 * Desktop header theme picker: swap the color palette without opening
 * Settings. Circles are every built-in plus the caller's saved theme presets;
 * hovering previews the whole app on intent and always fully restores the
 * stored selection; clicking persists through the existing ThemeProvider
 * paths (setThemeId / applyPreset), so sync and device-override behavior is
 * identical to the Settings ThemeControl.
 */
export function ThemeQuickPicker({
  value,
  presets = EMPTY,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  /** The caller's saved theme presets (fetched via React Query at the call site). */
  presets?: ThemePreset[]
  enabled?: boolean
}) {
  const hover = useThemeHoverPreview(value.preferredTheme)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  // Phase 2: the currently-active preset (own or a foreign shared one) always
  // gets a circle, even when it isn't in `presets` (the caller's own
  // library) — the quick picker stays compact by only ever adding this ONE
  // extra circle, not a whole "Shared" gallery. Synthesized directly from
  // ThemeProvider state (no extra fetch): `presetOwnerId` is populated
  // whenever ANY preset is applied (see ThemeProvider's doc comment), so
  // this also covers the caller's own preset if it somehow isn't in
  // `presets` yet (e.g. the list query hasn't resolved).
  const activeForeignPreset =
    value.presetId &&
    value.presetOwnerId &&
    value.customTheme &&
    !presets.some((preset) => preset.id === value.presetId)
      ? { id: value.presetId, document: value.customTheme, owner: { id: value.presetOwnerId, displayName: '' } }
      : null
  const circles: Circle[] = highContrastLast([
    ...BUILT_IN_THEMES.map((theme) => ({ kind: 'builtin' as const, id: theme.id, label: theme.label, theme })),
    ...presets.map((preset) => ({ kind: 'preset' as const, id: preset.id, label: preset.document.name, preset })),
    ...(activeForeignPreset
      ? [
          {
            kind: 'preset' as const,
            id: activeForeignPreset.id,
            label: activeForeignPreset.document.name,
            preset: activeForeignPreset,
          },
        ]
      : []),
  ])

  const restorePreview = hover.end

  const close = () => {
    restorePreview()
    setOpen(false)
  }

  const selectCircle = (circle: Circle) => {
    restorePreview()
    if (circle.kind === 'preset') value.applyPreset(circle.preset)
    else value.setThemeId(circle.id)
  }

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const selected = panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    ;(selected ?? panel?.querySelector<HTMLElement>('[role="radio"]'))?.focus()
  }, [open])
  usePopupDismiss({ open, popup: containerRef, trigger: triggerRef, onDismiss: close })

  if (!enabled) return null

  // Light / Dark / System applies only to a theme with both appearances: the selected one, or the one being previewed.
  const previewing = circles.find((circle) => circle.id === hover.hoveredId)
  const showAppearance = findWebTheme(value.themeId).kind === 'dual' || (!!previewing && hasAppearances(previewing))

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Theme"
        onClick={() => (open ? close() : setOpen(true))}
        className={clsx(
          'hidden md:flex items-center justify-center p-2 rounded-md',
          open ? 'bg-selection text-accent-light' : 'text-muted hover:text-primary hover:bg-surface-hover'
        )}
      >
        <PaletteIcon className="w-5 h-5" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Theme"
          className="ficus-overlay absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-th-border bg-surface p-3 shadow-theme-lg"
        >
          {/* The cells touch, so sweeping between circles never crosses a gap that would restore the app for a
              frame; the padding inside each cell keeps the circles apart. */}
          <div role="radiogroup" aria-label="Color theme" className="flex flex-wrap" onMouseLeave={restorePreview}>
            {circles.map((circle) => {
              const selected =
                circle.kind === 'preset' ? value.presetId === circle.id : !value.presetId && value.themeId === circle.id
              const previewing = hover.hoveredId === circle.id
              return (
                <button
                  key={circle.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={circle.label}
                  className="group flex h-8 w-8 shrink-0 items-center justify-center focus:outline-none"
                  onMouseEnter={() => hover.start(circle)}
                  onClick={() => selectCircle(circle)}
                  onKeyDown={(event) => {
                    // Explicit, rather than relying on native button default
                    // action: preventDefault suppresses that default so a real
                    // browser never double-fires this on the same keypress.
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    selectCircle(circle)
                  }}
                >
                  <span className="block h-6 w-6 rounded-full">
                    <ThemeSwatch
                      ring={previewing ? 'on' : selected ? (hover.hoveredId ? 'dim' : 'on') : undefined}
                      spec={
                        circle.kind === 'builtin'
                          ? { kind: 'builtin', theme: circle.theme, appearance: value.preferredTheme }
                          : {
                              kind: 'preset',
                              document: circle.preset.document,
                              appearance: presetAppearance(circle.preset.document, value.preferredTheme),
                            }
                      }
                      className="h-full w-full"
                    />
                  </span>
                </button>
              )
            })}
          </div>
          {showAppearance && (
            <SegmentedAppearanceControl value={value.appearance} onChange={value.setAppearance} className="mt-3" />
          )}
        </div>
      )}
    </div>
  )
}
