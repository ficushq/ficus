import clsx from 'clsx'
import { useOptionalTheme } from '../providers/ThemeProvider'
import type { AppearanceSetting } from '@ficus/shared/theme-schema'
import { SegmentedControl, type SegmentedControlOption } from './SegmentedControl'

const OPTIONS: readonly SegmentedControlOption<AppearanceSetting>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * Compact System / Light / Dark switch backed by the app's appearance setting
 * (ThemeProvider). Renders nothing outside a ThemeProvider.
 */
export function ThemePreferenceControl({ className }: { className?: string }) {
  const themeContext = useOptionalTheme()
  if (!themeContext) return null
  const { appearance, setAppearance } = themeContext

  return (
    <SegmentedControl
      size="compact"
      ariaLabel="Appearance"
      options={OPTIONS}
      value={appearance}
      onChange={setAppearance}
      className={clsx('shrink-0', className)}
    />
  )
}
