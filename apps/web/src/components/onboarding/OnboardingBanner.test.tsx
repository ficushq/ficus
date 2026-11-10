import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'
import { OnboardingBanner } from './OnboardingBanner'
import type { OnboardingStatus } from '../../api/onboarding'

/**
 * Seeds a real QueryClient (permissions + onboarding status caches) rather
 * than mocking `useOnboarding` — OnboardingPage.test.tsx does the same, and
 * both files target the same underlying hook module. Mocking it here
 * previously leaked into useOnboarding.test.tsx's own unit tests when both
 * ran in the same bun test process (this repo has known cross-file
 * mock.module leakage); seeding the cache sidesteps that collision entirely.
 */
function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    ready: false,
    items: [
      { id: 'ai_provider', required: true, state: 'done' },
      { id: 'first_squad', required: true, state: 'todo' },
      { id: 'github', required: false, state: 'skipped' },
    ],
    ...overrides,
  }
}

function render(permissions: string[] | undefined, onboardingStatus: OnboardingStatus | undefined, path = '/'): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (permissions) {
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  }
  if (onboardingStatus) {
    queryClient.setQueryData(onboardingQueryKeys.status(), onboardingStatus)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <OnboardingBanner />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('OnboardingBanner', () => {
  test('renders "Setup N/3" for an admin while not ready, counting RESOLVED (done OR skipped) items', () => {
    // ai_provider is 'done' AND github is 'skipped' — both count toward N, per
    // the spec's ready algebra (`ready` = every item done OR skipped). An
    // admin who skips an optional item must see progress move, not appear stuck.
    const html = render(['settings:read'], status())

    expect(html).toContain('Setup 2/3')
    expect(html).toContain('/onboarding')
  })

  test('derives the denominator from status.items.length, not a hardcoded item count', () => {
    // Synthetic 2-item status proves the "/N" half of the pill is read off the
    // response rather than a hand-synced constant.
    const html = render(
      ['settings:read'],
      status({
        items: [
          { id: 'ai_provider', required: true, state: 'done' },
          { id: 'first_squad', required: true, state: 'todo' },
        ],
      })
    )

    expect(html).toContain('Setup 1/2')
  })

  test('does not link to setup from the setup page itself', () => {
    expect(render(['settings:read'], status(), '/onboarding')).toBe('')
  })

  test('is absent when ready', () => {
    expect(render(['settings:read'], status({ ready: true }))).toBe('')
  })

  test('is absent for non-admins even while not ready', () => {
    // Holds SOME permission, just not the gating one — proves the gate is
    // permission-specific, not merely "any permissions present".
    expect(render(['agents:read'], status())).toBe('')
  })

  test('is absent while loading (admin, no cached status yet — the query has not resolved)', () => {
    expect(render(['settings:read'], undefined)).toBe('')
  })
})
