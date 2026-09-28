import { getSecretStore } from '../secrets'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../lib/infra/logger'
import {
  PUSH_RELAY_BASE_URL,
  relayInstanceTokenPattern,
  relayRoutingSchema,
  type RelayRouting,
} from '@ficus/shared/push-relay'

const log = createLogger('push-relay')

// Misconfiguration warnings are gated once per distinct bad value per process,
// so a broken override warns on discovery but does not spam logs on every send.
const warnedInvalidBaseUrl = new Set<string>()

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Accept only an https origin (or http on localhost, for local dev) with no
 * path, query, fragment, or embedded credentials. Returns the URL's origin,
 * which trims any trailing slash. Anything else is rejected so a
 * misconfigured value can never redirect push-relay traffic to another host.
 */
function validateRelayBaseUrl(candidate: string): string | null {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return null
  return url.origin
}

/**
 * Resolve the push-relay origin: `FICUS_PUSH_RELAY_URL` (Core-specific override)
 * → `FICUS_PLATFORM_BASE_URL` (the same fleet artifact the OAuth broker already
 * reuses on hosted tenants) → the built-in default. Whichever candidate wins
 * is validated; an invalid value is logged once and the built-in default is
 * used rather than silently trying the next tier or an unverifiable origin.
 */
export function resolvePushRelayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.FICUS_PUSH_RELAY_URL?.trim() || env.FICUS_PLATFORM_BASE_URL?.trim()
  if (!candidate) return PUSH_RELAY_BASE_URL
  const validated = validateRelayBaseUrl(candidate)
  if (validated) return validated
  if (!warnedInvalidBaseUrl.has(candidate)) {
    warnedInvalidBaseUrl.add(candidate)
    log.warn(`Ignoring invalid push-relay base URL '${candidate}'; falling back to the default relay`)
  }
  return PUSH_RELAY_BASE_URL
}

/** Runtime-only credential; never a Secret Store value or squad environment input. */
export function pushRelayConfig(env?: NodeJS.ProcessEnv) {
  const token = (env ? env.FICUS_PUSH_RELAY_TOKEN : getSecretStore().get('FICUS_PUSH_RELAY_TOKEN'))?.trim()
  if (!token) return null
  const match = relayInstanceTokenPattern.exec(token)
  if (!match) throw new Error('FICUS_PUSH_RELAY_TOKEN must be a push-only instance credential')
  return { token, instanceId: match[1], baseUrl: resolvePushRelayBaseUrl(env) }
}

export async function sendRelayAlert(
  bindingToken: string,
  routing: Record<string, unknown>,
  deps: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    config?: ReturnType<typeof pushRelayConfig>
  } = {}
) {
  const config = deps.config === undefined ? pushRelayConfig() : deps.config
  if (!config) return { accepted: false, reason: 'not_configured' }
  const allowed: RelayRouting = {}
  for (const key of [
    'squadId',
    'agentId',
    'workStreamId',
    'waitId',
    'questionId',
    'messageId',
    'actionId',
    'eventType',
    'workStreamNumber',
    'preview',
    'collapseKey',
    'threadKey',
    'interruptionLevel',
  ] as const) {
    if (routing[key] !== undefined) {
      const candidate = relayRoutingSchema.safeParse({ [key]: routing[key] })
      if (candidate.success) Object.assign(allowed, candidate.data)
    }
  }
  try {
    const response = await (deps.fetch ?? fetch)(`${config.baseUrl}/api/push-relay/send`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, bindingToken, eventId: randomUUID(), routing: allowed }),
    })
    // Never surface provider bodies/headers (or log fetch exceptions containing
    // the request). This path must not fall back to direct APNs on denial.
    if (!response.ok) {
      await response.body?.cancel()
      return { accepted: false, reason: response.status === 403 ? 'pro_required' : 'relay_unavailable' }
    }
    const body = (await response.json()) as { accepted?: boolean; reason?: string }
    return {
      accepted: body.accepted === true,
      reason:
        body.reason === 'device_unregistered' ? 'device_unregistered' : body.accepted ? undefined : 'relay_unavailable',
    }
  } catch {
    return { accepted: false, reason: 'relay_unavailable' }
  }
}

/** Human-user enrollment approval is forwarded with the scoped server credential. */
export async function enrollInstancePro(input: { publicKey: string; label: string }) {
  const config = pushRelayConfig()
  if (!config) throw new Error('Instance Pro is not configured on this server')
  const response = await fetch(`${config.baseUrl}/api/push-relay/enrollments`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('Cloud enrollment is unavailable')
  }
  return (await response.json()) as import('@ficus/shared/push-relay').ActivationChallenge
}
