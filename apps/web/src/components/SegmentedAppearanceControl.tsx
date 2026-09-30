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
 * The onboarding `ThemePreferenceControl` is the same `SegmentedControl`
 * (compact) but keeps its own System-first order, no icons, and no
 * disabled/hint state, so it doesn't reuse this wrapper.
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
