import {
  LIVE_ACTIVITY_RELAY_MAX_BODY_BYTES,
  relayLiveActivityResponseSchema,
  relayLiveActivitySendSchema,
  type RelayLiveActivityResponse,
  type RelayLiveActivitySend,
} from '@ficus/shared/live-activity-relay'
import { pushRelayConfig } from './relay'
import { isPlatformManaged } from '../secrets/managed'
import { platformRequest, PlatformRequestError } from '../platform/instance-client'

export type LiveActivityRelayResult =
  | { ok: true; status: 'sent' | 'queued' | 'duplicate' | 'superseded' }
  | {
      ok: false
      reason:
        | Extract<RelayLiveActivityResponse, { status: 'rejected' }>['reason']
        | 'not_configured'
        | 'invalid_request'
        | 'relay_unavailable'
      retryable: boolean
    }

const rejected = (reason: Extract<LiveActivityRelayResult, { ok: false }>['reason']): LiveActivityRelayResult => ({
  ok: false,
  reason,
  // Retry only with the SAME persisted event. Unknown delivery is never resent automatically.
  retryable: ['rate_limited', 'in_flight', 'provider_unavailable', 'relay_unavailable'].includes(reason),
})

export const liveActivityRelayConfigured = () => Boolean(pushRelayConfig()) || isPlatformManaged()

/** Explicit ActivityKit transport. Does not mutate tokens, generate retry identities or fall
 * back to direct APNs. Wiring requires durable registration and delivery lifecycle storage. */
export async function sendRelayLiveActivity(
  input: RelayLiveActivitySend,
  deps: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    config?: ReturnType<typeof pushRelayConfig>
    managed?: boolean
    request?: typeof platformRequest
  } = {}
): Promise<LiveActivityRelayResult> {
  const parsed = relayLiveActivitySendSchema.safeParse(input)
  if (!parsed.success) return rejected('invalid_request')
  const body = JSON.stringify(parsed.data)
  if (new TextEncoder().encode(body).byteLength > LIVE_ACTIVITY_RELAY_MAX_BODY_BYTES) return rejected('invalid_request')
  try {
    const config = deps.config === undefined ? pushRelayConfig() : deps.config
    if (!config) {
      if (!(deps.managed ?? (deps.config === undefined && isPlatformManaged()))) return rejected('not_configured')
      const result = await (deps.request ?? platformRequest)({
        path: '/api/cloud-mobile-pro/live-activities/send',
        body: parsed.data,
        schema: relayLiveActivityResponseSchema,
        maxResponseBytes: 1024,
      })
      return result.status === 'rejected' ? rejected(result.reason) : { ok: true, status: result.status }
    }
    const response = await (deps.fetch ?? fetch)(`${config.baseUrl}/api/push-relay/live-activities/send`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body,
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) return rejected('unauthorized')
      if (response.status === 403) return rejected('pro_required')
      if (response.status === 409) return rejected('conflict')
      if (response.status === 410) return rejected('destination_revoked')
      if (response.status === 429) return rejected('rate_limited')
      // Unknown endpoints/invalid contracts must not become a background retry loop.
      return rejected(response.status >= 500 ? 'relay_unavailable' : 'invalid_request')
    }
    // Never trust arbitrary relay response bodies, even from a configured development origin.
    const reader = response.body?.getReader()
    if (!reader) return rejected('relay_unavailable')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > 1024) return rejected('relay_unavailable')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const result = relayLiveActivityResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
    if (!result.success) return rejected('relay_unavailable')
    return result.data.status === 'rejected' ? rejected(result.data.reason) : { ok: true, status: result.data.status }
  } catch (error) {
    if (error instanceof PlatformRequestError) {
      if (error.status === 401) return rejected('unauthorized')
      if (error.status === 403) return rejected('pro_required')
      if (error.status === 409) return rejected('conflict')
      if (error.status === 410) return rejected('destination_revoked')
      if (error.status === 429) return rejected('rate_limited')
      if (!error.retryable) return rejected('invalid_request')
    }
    // Transport failure is ambiguous; retries MUST preserve the event for relay deduplication.
    // Provider errors, URLs, tokens and payloads never enter logs or user-facing error text.
    return rejected('relay_unavailable')
  }
}
