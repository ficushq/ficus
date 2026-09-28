import type { AppearanceSetting } from '@ficus/shared/theme-schema'
import { SegmentedControl, type SegmentedControlOption } from './SegmentedControl'
import { SunIcon, MoonIcon, MonitorIcon } from './icons'

const APPEARANCE_OPTIONS: readonly SegmentedControlOption<AppearanceSetting>[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
]

/**
 * Light/Dark/System tab-picker, shared by ThemeQuickPicker's flyout and the
 * Settings Theme section so both explain and control appearance identically.
 * Deliberately NOT reused by the onboarding `ThemePreferenceControl`: that
 * control is a differently-styled bordered pill using native
 * `<input type="radio">` elements (its own regression test asserts on
 * `.checked`), has no icons, a different option order, and never needs the
 * disabled/hint state a unified theme requires here — unifying it would only
 * be a cosmetic change bought at the cost of rewriting a passing,
 * behavior-level test for no functional gain.
 */
export function SegmentedAppearanceControl({
  value,
  onChange,
  disabled = false,
  hintId,
  className,
}: {
  value: AppearanceSetting
  onChange: (next: AppearanceSetting) => void
  /** Unified themes (e.g. High contrast) have one appearance; disable the control and point at the explanatory hint. */
  disabled?: boolean
  hintId?: string
  className?: string
}) {
  return (
    <SegmentedControl
      ariaLabel="Appearance"
      options={APPEARANCE_OPTIONS}
      value={value}
      onChange={onChange}
      disabled={disabled}
      hintId={hintId}
      className={className}
    />
  )
}
