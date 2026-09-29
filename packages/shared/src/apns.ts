import { createPrivateKey, sign as cryptoSign } from 'node:crypto'
import http2 from 'node:http2'

const APNS_REQUEST_TIMEOUT_MS = 10_000
export type ApnsEnvironment = 'production' | 'sandbox'

export interface ApnsConfig {
  keyP8: string
  keyId: string
  teamId: string
  bundleId: string
  /** Default APNs environment used only when a device-specific value is not supplied. */
  environment: ApnsEnvironment
}

/**
 * Rebuild a canonical PEM from a paste-mangled key: secrets pasted through
 * UIs/env files commonly arrive with newlines flattened to spaces, encoded as
 * literal "\n", or stripped entirely. All of those keep the BEGIN/END markers
 * (so naive sanity checks pass) but make OpenSSL fail with NO_START_LINE.
 * Extract the base64 body, drop all whitespace, and re-wrap at 64 columns.
 */
export function normalizePemKey(raw: string): string {
  const unescaped = raw.replace(/\\n/g, '\n').trim()
  const match = unescaped.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/)
  if (!match) return unescaped
  const label = match[1]
  const body = match[2].replace(/\s+/g, '')
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Build the APNs provider JWT (ES256), signed with the .p8 key.
 * `dsaEncoding: 'ieee-p1363'` produces the raw r||s signature JOSE requires (not DER).
 * Pure + deterministic given nowSec — unit-tested with a generated EC key.
 */
export function buildApnsJwt(config: { keyP8: string; keyId: string; teamId: string }, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSec }))
  const signingInput = `${header}.${claims}`
  const key = createPrivateKey(normalizePemKey(config.keyP8))
  const signature = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64url(signature)}`
}

export type ApnsInterruptionLevel = 'passive' | 'active' | 'time-sensitive'

export interface ApnsAlertPayload {
  title: string
  body: string
  /** Rendered between title and body on iOS. */
  subtitle?: string
  /** Notifications sharing a thread id are grouped on the device. */
  threadId?: string
  /** Passive pushes are delivered silently; the default is a normal, audible alert. */
  interruptionLevel?: ApnsInterruptionLevel
  /** Sent as the apns-collapse-id header: a newer push with the same id replaces this one. */
  collapseId?: string
  data?: Record<string, unknown>
  badge?: number
}

/** Build the APNs JSON payload (aps envelope + custom data for deep-linking). */
export function buildApnsPayload(p: ApnsAlertPayload): Record<string, unknown> {
  return {
    aps: {
      alert: { title: p.title, ...(p.subtitle ? { subtitle: p.subtitle } : {}), body: p.body },
      ...(p.interruptionLevel === 'passive' ? {} : { sound: 'default' }),
      ...(p.badge !== undefined ? { badge: p.badge } : {}),
      ...(p.threadId ? { 'thread-id': p.threadId } : {}),
      ...(p.interruptionLevel ? { 'interruption-level': p.interruptionLevel } : {}),
    },
    ...(p.data ?? {}),
  }
}

/** Request headers for one APNs push; the collapse id is optional and omitted rather than sent empty. */
export function buildApnsHeaders(input: {
  jwt: string
  topic: string
  pushType: 'alert' | 'liveactivity'
  collapseId?: string
}): Record<string, string> {
  return {
    authorization: `bearer ${input.jwt}`,
    'apns-topic': input.topic,
    'apns-push-type': input.pushType,
    ...(input.collapseId ? { 'apns-collapse-id': input.collapseId } : {}),
    'content-type': 'application/json',
  }
}

// Apple allows reusing a provider token for up to 1h; refresh well before then.
let cachedJwt: { token: string; iat: number; keyP8: string; keyId: string; teamId: string } | null = null
function getProviderJwt(config: ApnsConfig): string {
  const nowSec = Math.floor(Date.now() / 1000)
  if (
    cachedJwt &&
    cachedJwt.keyP8 === config.keyP8 &&
    cachedJwt.keyId === config.keyId &&
    cachedJwt.teamId === config.teamId &&
    nowSec >= cachedJwt.iat &&
    nowSec - cachedJwt.iat < 50 * 60
  )
    return cachedJwt.token
  const token = buildApnsJwt(config, nowSec)
  cachedJwt = { token, iat: nowSec, keyP8: config.keyP8, keyId: config.keyId, teamId: config.teamId }
  return token
}

export interface ApnsSendResult {
  ok: boolean
  status: number
  /** Apple's failure reason (e.g. 'BadDeviceToken', 'Unregistered') when status !== 200. */
  reason?: string
}

/** APNs Live Activity event verbs. */
export type LiveActivityEvent = 'start' | 'update' | 'end'

export interface LiveActivityPushInput {
  event: LiveActivityEvent
  /** Must match FicusWorkAttributes.ContentState in the native companion — field-for-field. */
  contentState: Record<string, unknown>
  /** Seconds since epoch after which iOS renders the card as stale. */
  staleDate?: number
  /** Attributes TYPE NAME, e.g. 'FicusWorkAttributes'. Required for `start`. */
  attributesType?: string
  /** Static attributes, e.g. { origin }. Required for `start`. */
  attributes?: Record<string, unknown>
  /** `end` only: when iOS should remove the finished card. */
  dismissalDate?: number
  /** Injectable clock so tests pin `timestamp` instead of racing it. */
  nowSec?: number
}

/**
 * Build the `aps` payload for a Live Activity push.
 *
 * Deliberately carries NO alert/sound/badge keys: adding any of them turns this into a
 * user-visible notification on top of the activity update, which is not what an aggregated
 * work card should do. `timestamp` is required by APNs and is how iOS discards updates that
 * arrive out of order, so it is always present.
 *
 * `attributes-type`/`attributes` are ONLY valid on a `start` event (they define the activity
 * being created); sending them on an update is rejected by APNs, so they are omitted unless the
 * event is `start`.
 */
export function buildLiveActivityPayload(input: LiveActivityPushInput): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: input.nowSec ?? Math.floor(Date.now() / 1000),
    event: input.event,
    'content-state': input.contentState,
  }
  if (input.staleDate !== undefined) aps['stale-date'] = input.staleDate
  if (input.event === 'start') {
    if (input.attributesType) aps['attributes-type'] = input.attributesType
    if (input.attributes) aps.attributes = input.attributes
  }
  if (input.event === 'end' && input.dismissalDate !== undefined) aps['dismissal-date'] = input.dismissalDate
  return { aps }
}

function apnsHostForEnvironment(environment: ApnsEnvironment): string {
  return environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
}

/**
 * One APNs request over a fresh node:http2 session. APNs requires HTTP/2 and
 * Bun's fetch is HTTP/1.1-only (it fails with Malformed_HTTP_Response against
 * api.push.apple.com), so this must stay on node:http2.
 */
export function apnsHttp2Request(
  args: {
    host: string
    path: string
    headers: Record<string, string>
    body: string
  },
  options: { timeoutMs?: number } = {}
): Promise<{ status: number; body: string }> {
  const timeoutMs = options.timeoutMs ?? APNS_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid APNs request deadline')
  return new Promise((resolve, reject) => {
    const client = http2.connect(args.host)
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.destroy()
      } catch {
        // closing a dead session is fine
      }
      settle()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`APNs request timed out after ${timeoutMs}ms`))),
      timeoutMs
    )
    client.on('error', (err) => finish(() => reject(err)))

    let req: http2.ClientHttp2Stream
    try {
      req = client.request({ ':method': 'POST', ':path': args.path, ...args.headers })
    } catch (error) {
      finish(() => reject(error))
      return
    }
    req.on('error', (err) => finish(() => reject(err)))
    let status = 0
    let responseBody = ''
    req.setEncoding('utf8')
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0)
    })
    req.on('data', (chunk: string) => {
      if (responseBody.length + chunk.length > 8192) {
        finish(() => reject(new Error('APNs response exceeded its size limit')))
        return
      }
      responseBody += chunk
    })
    req.on('end', () => finish(() => resolve({ status, body: responseBody })))
    req.end(args.body)
  })
}

/**
 * Shared HTTP/2 transport for both push types.
 *
 * The only differences between them are the topic and the apns-push-type header: Live Activity
 * pushes go to `<bundleId>.push-type.liveactivity`, and sending them to the plain bundle id is
 * rejected. Everything else — host selection, JWT, error decoding, logging — is identical, so it
 * lives here once.
 */
export async function dispatchApns(input: {
  config: ApnsConfig
  deviceToken: string
  body: string
  deviceEnvironment?: ApnsEnvironment
  pushType: 'alert' | 'liveactivity'
  collapseId?: string
}): Promise<ApnsSendResult> {
  const { config, deviceToken, body, pushType } = input
  const jwt = getProviderJwt(config)
  const environment = input.deviceEnvironment ?? config.environment
  const host = apnsHostForEnvironment(environment)
  const topic = pushType === 'liveactivity' ? `${config.bundleId}.push-type.liveactivity` : config.bundleId

  try {
    const res = await apnsHttp2Request({
      host,
      path: `/3/device/${deviceToken}`,
      headers: buildApnsHeaders({ jwt, topic, pushType, collapseId: input.collapseId }),
      body,
    })

    if (res.status === 200) {
      return { ok: true, status: res.status }
    }

    let reason: string | undefined
    try {
      reason = JSON.parse(res.body).reason
    } catch {
      reason = undefined
    }
    return { ok: false, status: res.status, reason }
  } catch (err) {
    return { ok: false, status: 0, reason: String(err) }
  }
}
