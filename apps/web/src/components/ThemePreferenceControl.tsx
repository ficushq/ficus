import clsx from 'clsx'
import { useOptionalTheme } from '../providers/ThemeProvider'
import type { AppearanceSetting } from '@ficus/shared/theme-schema'

const OPTIONS: { value: AppearanceSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

// The radio is `sr-only`, so the visible label wears the keyboard focus ring.
const LABEL_FOCUS_RING =
  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus'

/**
 * Compact System / Light / Dark switch backed by the app's appearance setting
 * (ThemeProvider). Renders nothing outside a ThemeProvider.
 */
export function ThemePreferenceControl({ className }: { className?: string }) {
  const themeContext = useOptionalTheme()
  if (!themeContext) return null
  const { appearance, setAppearance } = themeContext

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={clsx('inline-flex shrink-0 rounded-md border border-th-border bg-surface p-0.5', className)}
    >
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className={clsx(
            'cursor-pointer rounded px-2.5 py-1 text-xs font-medium',
            LABEL_FOCUS_RING,
            appearance === option.value ? 'bg-accent text-on-accent' : 'text-secondary hover:bg-surface-hover'
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name="theme-preference"
            value={option.value}
            checked={appearance === option.value}
            onChange={() => setAppearance(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}
