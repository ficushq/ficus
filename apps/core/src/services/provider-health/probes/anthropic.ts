import { getModels } from '@earendil-works/pi-ai/compat'
import type { HealthProbe, ProbeResult } from './types'

function baseUrl(override?: string): string {
  if (override) return override.replace(/\/$/, '')
  try {
    const models = getModels('anthropic')
    const m = models.find((x) => x.baseUrl) ?? models[0]
    return (m?.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  } catch {
    return 'https://api.anthropic.com'
  }
}

/**
 * Anthropic auth/reachability probe. `GET /v1/models` is token-free and
 * validates the API key + endpoint reachability, but it cannot proactively
 * detect credit exhaustion or request rate limits for Messages API traffic.
 * Those provider-exhaustion signals are captured from response headers in
 * `classifyResponseHeaders` (e.g. `anthropic-ratelimit-*`).
 *
 * Successful model listing can recover credential failures only. Even network,
 * capacity, and generic errors may be specific to the Messages endpoint, so
 * those (like credits and rate limits) need a successful generation to recover.
 *
 * 5xx responses intentionally return inconclusive so active probes do not
 * flap providers during transient outages; the reactive settled-error path
 * handles capacity errors from real agent requests.
 */
export const anthropicProbe: HealthProbe = {
  provider: 'anthropic',
  async probe({ apiKey, baseUrl: override }: { apiKey?: string; baseUrl?: string } = {}): Promise<ProbeResult> {
    if (!apiKey) return { state: 'inconclusive' } // local auth resolution is not provider success

    const res = await fetch(`${baseUrl(override)}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    })

    if (res.status === 429) return { state: 'unhealthy', kind: 'rate-limit', status: 429 }
    if (res.status === 401 || res.status === 403)
      return { state: 'unhealthy', kind: 'invalid-credential', status: res.status }
    if (res.status >= 500) return { state: 'inconclusive', status: res.status }
    if (!res.ok) return { state: 'unhealthy', kind: 'error', status: res.status }

    return { state: 'healthy', status: res.status, recoveryKinds: ['invalid-credential', 'expired-oauth'] }
  },
}
