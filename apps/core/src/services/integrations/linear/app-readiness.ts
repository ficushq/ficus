import type { OAuthAuthority } from '../authorization/authority'

/**
 * Whether the Linear agent app may be installed under each OAuth authority.
 *
 * An install creates a delegable, mentionable member in a Linear workspace and
 * points Linear's app webhook at Ficus, so it stays off until the side that
 * receives what it creates exists:
 * - `local` (self-hosted): on, now that the direct app webhook at
 *   `/api/webhooks/linear-app` acknowledges sessions.
 * - `platform_broker` (Ficus Cloud): turned on once the Platform OAuth broker
 *   knows `linear` and the hosted event relay delivers app webhooks.
 *
 * While an authority is off, the Linear plugin offers no managed driver under
 * it (so `authorization/start` refuses with `unsupported_provider`), the OAuth
 * app settings report `available: false`, saving them is refused, and the web
 * card hides the Agent app section. API-key connections are unaffected.
 */
const LINEAR_APP_READY: Readonly<Record<OAuthAuthority, boolean>> = {
  // The direct app webhook and session acknowledgment exist (stream D).
  local: true,
  platform_broker: false,
}

let testOverride: Readonly<Record<OAuthAuthority, boolean>> | undefined

export function isLinearAppReady(authority: OAuthAuthority): boolean {
  return (testOverride ?? LINEAR_APP_READY)[authority]
}

/** Overrides readiness for one test and returns a restoration callback. */
export function setLinearAppReadinessForTest(readiness: Readonly<Record<OAuthAuthority, boolean>>): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only')
  const previous = testOverride
  testOverride = readiness
  return () => {
    testOverride = previous
  }
}
