import { Link, useLocation } from 'react-router-dom'
import { useOnboarding } from '../../hooks/useOnboarding'

/**
 * Persistent nag pill: renders on every page while the instance is not
 * `ready` and the viewer is an admin, and nowhere else — absent when ready,
 * absent for non-admins, and absent while loading or on a failed status
 * request (`useOnboarding` collapses both of those to `status: undefined`,
 * so a broken query never breaks a working instance's shell). See
 * docs/history/superpowers/specs/2026-08-05-onboarding-checklist-design.md §3.
 */
export function OnboardingBanner() {
  const { pathname } = useLocation()
  const { status, isAdmin } = useOnboarding()
  if (pathname === '/onboarding' || !isAdmin || !status || status.ready) return null

  // Counts RESOLVED items — `done` OR `skipped` — matching the spec's ready
  // algebra (`ready` = every item `done` or `skipped`), so an admin who
  // skips e.g. Slack sees progress move rather than the count appearing
  // stuck. The denominator is `status.items.length`, not a hand-synced
  // constant — one less fact to keep in sync with core's item list.
  const resolvedCount = status.items.filter((item) => item.state === 'done' || item.state === 'skipped').length

  return (
    <Link
      to="/onboarding"
      className="shrink-0 bg-accent text-on-accent px-4 py-2 flex items-center justify-between gap-4 text-sm font-medium hover:bg-accent-hover transition-colors"
    >
      <span>
        Setup {resolvedCount}/{status.items.length} — finish setting up Ficus
      </span>
      <span aria-hidden="true">→</span>
    </Link>
  )
}
