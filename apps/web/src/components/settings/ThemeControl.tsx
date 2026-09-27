import { useQuery } from '@tanstack/react-query'
import { ThemePresetLibrary } from './ThemePresetLibrary'
import { ThemeSwatchGrid, type ThemeGridOption } from './ThemeSwatchGrid'
import { SegmentedAppearanceControl } from '../SegmentedAppearanceControl'
import type { AppearanceSetting, ThemePreset } from '@ficus/shared'
import type { useTheme } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, highContrastLast, THEME_PICKER_ENABLED } from '../../theme/registry'
import { hasAppearances, useThemeHoverPreview } from '../../hooks/useThemeHoverPreview'
import { selfServiceQueryEnabled, useOptionalAuth } from '../../providers/AuthProvider'
import { queries } from '../../queryOptions'

// Hoisted so a caller whose "mine" list hasn't resolved yet doesn't create a
// new empty array every render (mirrors ThemeQuickPicker's EMPTY).
const EMPTY_PRESETS: ThemePreset[] = []

export function ThemeControl({
  value,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  enabled?: boolean
}) {
  const { themeId, appearance, setThemeId, setAppearance, theme, toggleTheme, customTheme, presetId } = value
  const hover = useThemeHoverPreview(value.preferredTheme)
  const selected = findWebTheme(themeId)
  const auth = useOptionalAuth()
  const { data: minePresets = EMPTY_PRESETS, isSuccess: mineLoaded } = useQuery({
    ...queries.themePresets.list('mine'),
    enabled: selfServiceQueryEnabled(auth),
  })
  // A preset id present but absent from the caller's own library is someone
  // else's shared preset (see ThemeProvider's presetOwnerId doc comment) —
  // the same "not in my list" test ThemeQuickPicker's activeForeignPreset uses.
  // Until the library has loaded, don't guess: an own preset would flash as
  // shared, or worse, get a duplicate dot once the real list resolves.
  const foreignPreset = !!presetId && mineLoaded && !minePresets.some((preset) => preset.id === presetId)

  // The grid: every built-in, the caller's own saved presets, and — only if
  // it isn't already one of those — the currently active shared preset. This
  // mirrors ThemeQuickPicker's `circles` composition exactly (see its doc
  // comment) so both entry points show the same set for the same state.
  const gridOptions: ThemeGridOption[] = highContrastLast([
    ...BUILT_IN_THEMES.map((builtin) => ({
      kind: 'builtin' as const,
      id: builtin.id,
      label: builtin.label,
      accessibleLabel: builtin.label,
      theme: builtin,
    })),
    ...minePresets.map((preset) => ({
      kind: 'preset' as const,
      id: preset.id,
      label: preset.document.name,
      accessibleLabel: preset.document.name,
      preset,
    })),
    ...(foreignPreset && customTheme && presetId
      ? [
          {
            kind: 'preset' as const,
            id: presetId,
            label: customTheme.name,
            accessibleLabel: `${customTheme.name} (shared)`,
            preset: { id: presetId, document: customTheme, owner: { id: value.presetOwnerId!, displayName: '' } },
          },
        ]
      : []),
  ])
  // A custom/preset theme active selects its dot (or, for a detached one-off
  // with no library dot to represent it, no dot at all — never the plain
  // built-in it happens to be based on, which would misrepresent it as
  // unmodified). Otherwise the active built-in's own dot is selected.
  const selectedId = customTheme ? presetId : selected.id
  // Light / Dark / System applies only to a theme with both appearances: the selected one, or the one being previewed.
  const previewing = gridOptions.find((option) => option.id === hover.hoveredId)
  const showAppearance = selected.kind === 'dual' || (!!previewing && hasAppearances(previewing))

  return (
    <section data-setting-target="appearance" aria-label="Theme" className="ficus-section py-5">
      <h3 data-setting-target="dark-mode" className="font-medium text-primary">
        Theme
      </h3>
      {enabled ? (
        <div className="mt-3 flex flex-col gap-4">
          <ThemeSwatchGrid
            options={gridOptions}
            selectedId={selectedId}
            currentAppearance={value.preferredTheme}
            previewingId={hover.hoveredId}
            onPreview={hover.start}
            onPreviewEnd={hover.end}
            onSelect={(option) => {
              hover.end()
              if (option.kind === 'builtin') setThemeId(option.id)
              else value.applyPreset(option.preset)
            }}
          />
          {showAppearance && (
            <SegmentedAppearanceControl
              value={appearance}
              onChange={(next: AppearanceSetting) => setAppearance(next)}
              className="max-w-xs"
            />
          )}
        </div>
      ) : (
        <button className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary mt-3" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>
      )}
      {value.customThemeError && <p role="alert">{value.customThemeError}</p>}
      {enabled && <ThemePresetLibrary value={value} />}
    </section>
  )
}
