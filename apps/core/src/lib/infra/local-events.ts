import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createLogger } from './logger'

/**
 * Authenticated HTTP transport for best-effort cross-process events.
 *
 * The API and worker exchange seven channels: `app_events`, `agent_control`,
 * `secret_changed`, `setting_changed`, `device_token_revoked`,
 * `instance_maintenance_changed`, and `system_restart`. Notifications dispatch
 * locally and are forwarded to the configured peer without acknowledgement or
 * persistence. The ONE retry the transport performs is a short, bounded one
 * when the peer refuses the connection (nothing listening yet — see
 * `CONNECT_REFUSED_RETRY_DELAYS_MS`); every other failure drops the event
 * immediately. A successful HTTP response only means that the peer route
 * accepted the event, not that a handler acted on it.
 *
 * Loopback is the default topology; bind and peer URL overrides support split
 * network namespaces. Every post is authenticated. Token resolution is an
 * explicit token, then an HMAC derived from the encryption key, then a random
 * per-process fail-closed token.
 *
 * This preserves the former PostgreSQL NOTIFY best-effort and self-delivery
 * semantics while avoiding dedicated database listener connections. Durable DB
 * state and polling remain the authoritative backstops where each channel has
 * one; this transport is only a fast hint path.
 */

const log = createLogger('local-events')

/** Path served by the worker's listener and mounted on the api's Hono app. */
export const INTERNAL_EVENTS_PATH = '/internal/events'

/** Header carrying the shared secret. */
export const INTERNAL_EVENT_TOKEN_HEADER = 'x-ficus-internal-token'

const DEFAULT_WORKER_EVENT_PORT = 3003
const DEFAULT_API_PORT = 3000

/** Bound so a hung peer can never stall a request; NOT a retry. */
const POST_TIMEOUT_MS = 5_000

/**
 * Waits between attempts, applied ONLY when the peer refuses the connection,
 * i.e. nothing is listening on its port yet. The api and worker restart in
 * parallel on every upgrade (and `bun dev` starts both), and the worker boots
 * faster, so events emitted in the first seconds of a worker's life used to be
 * dropped every single start. Roughly two seconds of retrying closes that
 * window without turning the transport into a queue: after the last wait the
 * event is dropped like any other failure. Timeouts, HTTP rejections and other
 * network errors are never retried — a peer that is up but failing is a bug to
 * surface, not a race to paper over.
 */
export const CONNECT_REFUSED_RETRY_DELAYS_MS: readonly number[] = [500, 1500]

export const LOCAL_EVENT_CHANNELS = [
  'app_events',
  'agent_control',
  'secret_changed',
  'setting_changed',
  'device_token_revoked',
  'instance_maintenance_changed',
  'system_restart',
] as const

export type LocalEventFailureCategory = 'http_rejection' | 'network' | 'timeout'

/**
 * Coalesced peer-down state. The first refused post logs one line and starts
 * the window; later drops are counted silently and reported in a single
 * summary when the peer answers again. Without this every event emitted while
 * the peer restarted produced a multi-line error dump, so the log for the
 * expected case (the peer is coming up) looked like an outage.
 */
interface PeerDownWindow {
  since: number
  dropped: number
}
type LocalEventChannel = (typeof LOCAL_EVENT_CHANNELS)[number]
type DiagnosticBucket = LocalEventChannel | 'other'

export interface LocalEventForwardingDiagnostics {
  channels: Array<{
    channel: DiagnosticBucket
    attempts: number
    failures: Record<LocalEventFailureCategory, number>
    lastFailure: null | {
      at: string
      category: LocalEventFailureCategory
      status: number | null
    }
  }>
}

interface MutableDiagnostic {
  attempts: number
  failures: Record<LocalEventFailureCategory, number>
  lastFailure: LocalEventForwardingDiagnostics['channels'][number]['lastFailure']
}

const LOCAL_EVENT_DIAGNOSTIC_BUCKETS = [...LOCAL_EVENT_CHANNELS, 'other'] as const

function diagnosticBucket(channel: string): DiagnosticBucket {
  return (LOCAL_EVENT_CHANNELS as readonly string[]).includes(channel) ? (channel as LocalEventChannel) : 'other'
}

function emptyDiagnostics(): Map<DiagnosticBucket, MutableDiagnostic> {
  return new Map(
    LOCAL_EVENT_DIAGNOSTIC_BUCKETS.map((channel) => [
      channel,
      {
        attempts: 0,
        failures: { http_rejection: 0, network: 0, timeout: 0 },
        lastFailure: null,
      },
    ])
  )
}

export type LocalEventHandler = (payload: string) => void

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type Log = Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'>

export interface LocalEventTransportOptions {
  /** Absolute URL of the peer's `/internal/events`. Unset = local-only. */
  peerUrl?: string | null
  /** Shared secret. Unset/null = reject every inbound post (fail closed). */
  token?: string | null
  log?: Log
  /** Test seam for deterministic transport failures. Defaults to global fetch. */
  fetchFn?: FetchFn
  /** Test seam for the connection-refused retry waits. Defaults to an unref'd timer. */
  sleepFn?: (ms: number) => Promise<void>
}

function port(envVar: string, fallback: number): number {
  const raw = process.env[envVar]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    log.warn(`${envVar}='${raw}' is not a valid port; using ${fallback}`)
    return fallback
  }
  return parsed
}

/** Port the worker's loopback event listener binds. */
export function workerEventPort(): number {
  return port('FICUS_WORKER_EVENT_PORT', DEFAULT_WORKER_EVENT_PORT)
}

/**
 * Address the worker's event listener binds. Defaults to loopback, which is
 * correct for the systemd topology where both units share a host.
 *
 * It is overridable because `docker-compose.core.yml` and `docs/k8s/*` are
 * SUPPORTED deployments that put api and worker in separate network
 * namespaces, where a loopback-only listener cannot be reached at all — agent
 * stop/abort and secret invalidation would simply stop crossing, silently.
 * Overriding is safe because every post is authenticated with a shared secret
 * (see `internalEventToken`); loopback is defence in depth, not the only
 * control. Binding beyond loopback is logged, since it widens exposure and
 * should always be a deliberate act.
 */
export function workerEventBindHost(): string {
  const configured = process.env.FICUS_WORKER_EVENT_BIND?.trim()
  if (!configured || configured === '127.0.0.1') return '127.0.0.1'
  log.warn(
    `FICUS_WORKER_EVENT_BIND='${configured}' — the internal event listener is bound beyond loopback. ` +
      'Ensure it is reachable ONLY from the paired Ficus process (private network / container network).'
  )
  return configured
}

/**
 * Where the api posts events (the worker's dedicated event listener).
 * `FICUS_WORKER_EVENT_URL` overrides for split-namespace deployments, e.g.
 * `http://worker:3003/internal/events` under Compose.
 */
export function workerPeerUrl(): string {
  return process.env.FICUS_WORKER_EVENT_URL?.trim() || `http://127.0.0.1:${workerEventPort()}${INTERNAL_EVENTS_PATH}`
}

/**
 * Where the worker posts events: the api's EXISTING Hono server, so the api
 * needs no second listener. Matches `index.ts`'s default bind hostname.
 * `FICUS_API_EVENT_URL` overrides for split-namespace deployments.
 */
export function apiPeerUrl(): string {
  return (
    process.env.FICUS_API_EVENT_URL?.trim() ||
    `http://localhost:${port('PORT', DEFAULT_API_PORT)}${INTERNAL_EVENTS_PATH}`
  )
}

let processToken: string | null = null

/**
 * Domain separator for deriving the event token from FICUS_ENCRYPTION_KEY. Any
 * other secret derived from that key MUST use a different label, so that
 * disclosing one derived value never yields another.
 */
const INTERNAL_EVENT_TOKEN_LABEL = 'tau-internal-events-v1'

/**
 * The shared secret both units must agree on, resolved in three steps:
 *
 * 1. `FICUS_INTERNAL_EVENT_TOKEN` when set — the explicit, preferred value.
 * 2. Otherwise DERIVED from `FICUS_ENCRYPTION_KEY`, which every existing
 *    deployment already sets and both units already read from the same
 *    environment. Without this step, upgrading an instance that predates
 *    `FICUS_INTERNAL_EVENT_TOKEN` would silently stop delivering agent control
 *    signals (stop / abort-tool) until an operator noticed the log and added
 *    a var — a regression pg NOTIFY never had, since it needed no shared
 *    secret at all. Derivation is one-way (HMAC with a domain-separating
 *    label), so holding the event token does not reveal the encryption key,
 *    and anyone who holds the encryption key already has strictly more.
 * 3. Only if BOTH are unset: a random per-process token, which fails closed
 *    (every cross-process post 401s) rather than accepting unauthenticated
 *    posts.
 */
export function resolveInternalEventToken(env: NodeJS.ProcessEnv = process.env): {
  token: string
  source: 'explicit' | 'derived' | 'random'
} {
  if (env.FICUS_INTERNAL_EVENT_TOKEN) {
    return { token: env.FICUS_INTERNAL_EVENT_TOKEN, source: 'explicit' }
  }
  if (env.FICUS_ENCRYPTION_KEY) {
    return {
      token: createHmac('sha256', env.FICUS_ENCRYPTION_KEY).update(INTERNAL_EVENT_TOKEN_LABEL).digest('hex'),
      source: 'derived',
    }
  }
  return { token: randomBytes(32).toString('hex'), source: 'random' }
}

export function internalEventToken(): string {
  if (processToken) return processToken

  const { token, source } = resolveInternalEventToken()
  processToken = token
  if (source === 'random') {
    log.error(
      'Neither FICUS_INTERNAL_EVENT_TOKEN nor FICUS_ENCRYPTION_KEY is set — cross-process events ' +
        '(agent control signals, event forwarding, secret invalidation) are DISABLED. Set the ' +
        'SAME value in the environment of both tau-api and tau-worker.'
    )
  }
  return processToken
}

/**
 * Constant-time token comparison. Digesting first keeps both operands the same
 * length, so `timingSafeEqual` cannot throw on (and thereby leak) a length
 * mismatch.
 */
function tokensMatch(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

/** Walk an error's `cause` chain (cycle-safe) and report whether any link matches. */
function errorChainSome(error: unknown, predicate: (value: { name?: unknown; code?: unknown }) => boolean): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = current as { name?: unknown; code?: unknown; cause?: unknown }
    if (predicate(value)) return true
    current = value.cause
  }
  return false
}

function isTimeoutError(error: unknown, timeoutSignal: AbortSignal): boolean {
  if (timeoutSignal.aborted) return true
  return errorChainSome(
    error,
    (value) => value.name === 'TimeoutError' || value.name === 'AbortError' || value.code === 'ETIMEDOUT'
  )
}

/**
 * Nothing is listening on the peer's port. Bun reports this as
 * `code: 'ConnectionRefused'`; Node-style errors use `ECONNREFUSED`.
 */
export function isConnectionRefusedError(error: unknown): boolean {
  return errorChainSome(error, (value) => value.code === 'ConnectionRefused' || value.code === 'ECONNREFUSED')
}

/** A timer that never keeps the process alive: a pending retry must not delay shutdown. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
}

/**
 * One side of the transport: a handler registry, an optional loopback server
 * and an optional peer to forward to.
 */
export class LocalEventTransport {
  private handlers = new Map<string, Set<LocalEventHandler>>()
  private server: ReturnType<typeof Bun.serve> | null = null
  private peerUrl: string | null
  private token: string | null
  private log: Log
  private fetchFn: FetchFn
  private sleepFn: (ms: number) => Promise<void>
  private diagnostics = emptyDiagnostics()
  private peerDown: PeerDownWindow | null = null
  /** Bumped by `close()` so an in-flight retry loop from before the close stops. */
  private generation = 0

  constructor(options: LocalEventTransportOptions = {}) {
    this.peerUrl = options.peerUrl ?? null
    this.token = options.token ?? null
    this.log = options.log ?? log
    this.fetchFn = options.fetchFn ?? fetch
    this.sleepFn = options.sleepFn ?? unrefSleep
  }

  /** Point this transport at its peer (called once at process startup). */
  configure(options: Pick<LocalEventTransportOptions, 'peerUrl' | 'token'>): void {
    if (options.peerUrl !== undefined) this.peerUrl = options.peerUrl
    if (options.token !== undefined) this.token = options.token
  }

  /** Register a handler for `channel`. Returns an unlisten function. */
  async listen(channel: string, callback: LocalEventHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(callback)
    return async () => {
      this.handlers.get(channel)?.delete(callback)
    }
  }

  /**
   * Deliver `payload` on `channel` to this process's handlers and to the peer.
   * Best-effort: a peer failure is logged, never thrown.
   */
  async notify(channel: string, payload: string): Promise<void> {
    // pg delivered notifications on a later tick, including to the sender's own
    // listener. Deferring preserves that (a handler may itself notify).
    queueMicrotask(() => this.dispatch(channel, payload))
    await this.post(channel, payload)
  }

  /** Fan a payload out to this process's handlers, isolating handler throws. */
  private dispatch(channel: string, payload: string): void {
    const set = this.handlers.get(channel)
    if (!set) return
    for (const handler of set) {
      try {
        handler(payload)
      } catch (error) {
        this.log.error(`Error in local-events handler for '${channel}':`, error)
      }
    }
  }

  private recordFailure(
    diagnostic: MutableDiagnostic,
    category: LocalEventFailureCategory,
    status: number | null
  ): void {
    diagnostic.failures[category] += 1
    diagnostic.lastFailure = { at: new Date().toISOString(), category, status }
  }

  /** The peer answered (any status) or failed for a non-refused reason: close the peer-down window. */
  private notePeerReachable(): void {
    if (!this.peerDown) return
    const { since, dropped } = this.peerDown
    this.peerDown = null
    const seconds = ((Date.now() - since) / 1000).toFixed(1)
    this.log.warn(
      `Peer ${this.peerUrl} is reachable again after ${seconds}s; ${dropped} event${dropped === 1 ? '' : 's'} dropped while it was down`
    )
  }

  /** Every retry was refused: drop the event, logging once per outage. */
  private notePeerRefused(channel: string, attempts: number): void {
    if (this.peerDown) {
      this.peerDown.dropped += 1
      return
    }
    this.peerDown = { since: Date.now(), dropped: 1 }
    this.log.warn(
      `Peer ${this.peerUrl} is not listening (connection refused ${attempts}x); dropped '${channel}'. ` +
        'Further drops are counted silently until the peer answers again.'
    )
  }

  /**
   * One POST. Resolves to `'sent'` on any HTTP response, `'refused'` when
   * nothing is listening (retryable) or `'failed'` for every other error.
   * Diagnostics are recorded for `sent` (rejections) and `failed`; the caller
   * records a `refused` only once it gives up.
   */
  private async postOnce(
    channel: string,
    payload: string,
    diagnostic: MutableDiagnostic
  ): Promise<'sent' | 'refused' | 'failed'> {
    const timeoutSignal = AbortSignal.timeout(POST_TIMEOUT_MS)
    try {
      const res = await this.fetchFn(this.peerUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { [INTERNAL_EVENT_TOKEN_HEADER]: this.token } : {}),
        },
        body: JSON.stringify({ channel, payload }),
        signal: timeoutSignal,
      })
      this.notePeerReachable()
      if (!res.ok) {
        this.recordFailure(diagnostic, 'http_rejection', res.status)
        // Loud on purpose: a dropped `agent_control` signal means a user's
        // "stop" button silently did nothing.
        this.log.error(`Failed to forward '${channel}' to ${this.peerUrl}: HTTP ${res.status}`)
      }
      return 'sent'
    } catch (error) {
      const timedOut = isTimeoutError(error, timeoutSignal)
      if (!timedOut && isConnectionRefusedError(error)) return 'refused'
      this.notePeerReachable()
      this.recordFailure(diagnostic, timedOut ? 'timeout' : 'network', null)
      // Best-effort by design — log and continue.
      this.log.error(`Failed to forward '${channel}' to ${this.peerUrl}:`, error)
      return 'failed'
    }
  }

  private async post(channel: string, payload: string): Promise<void> {
    if (!this.peerUrl) return // No peer configured (tests, single-process use).
    const generation = this.generation
    const diagnostic = this.diagnostics.get(diagnosticBucket(channel))!
    diagnostic.attempts += 1
    let attempts = 0
    for (const delayMs of [0, ...CONNECT_REFUSED_RETRY_DELAYS_MS]) {
      if (delayMs > 0) await this.sleepFn(delayMs)
      if (this.generation !== generation) return // Closed while waiting to retry.
      attempts += 1
      if ((await this.postOnce(channel, payload, diagnostic)) !== 'refused') return
    }
    // The peer being down (not started yet, restarting, shut down) lands here.
    this.recordFailure(diagnostic, 'network', null)
    this.notePeerRefused(channel, attempts)
  }

  getDiagnostics(): LocalEventForwardingDiagnostics {
    return {
      channels: LOCAL_EVENT_DIAGNOSTIC_BUCKETS.map((channel) => {
        const diagnostic = this.diagnostics.get(channel)!
        return {
          channel,
          attempts: diagnostic.attempts,
          failures: { ...diagnostic.failures },
          lastFailure: diagnostic.lastFailure ? { ...diagnostic.lastFailure } : null,
        }
      }),
    }
  }

  /** Handle an inbound event post. Shared by the worker server and api route. */
  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== INTERNAL_EVENTS_PATH || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 })
    }

    const presented = request.headers.get(INTERNAL_EVENT_TOKEN_HEADER)
    if (!this.token || !presented || !tokensMatch(this.token, presented)) {
      return new Response('Unauthorized', { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const { channel, payload } = (body ?? {}) as { channel?: unknown; payload?: unknown }
    if (typeof channel !== 'string' || typeof payload !== 'string') {
      return new Response('Bad Request', { status: 400 })
    }

    this.dispatch(channel, payload)
    return new Response(null, { status: 204 })
  }

  /**
   * Start the event listener. Loopback by default; `FICUS_WORKER_EVENT_BIND`
   * widens it for split-namespace deployments (see `workerEventBindHost`).
   * Every inbound post is authenticated regardless of bind address.
   */
  serve(options: { port?: number; hostname?: string } = {}): ReturnType<typeof Bun.serve> {
    if (this.server) return this.server
    this.server = Bun.serve({
      hostname: options.hostname ?? workerEventBindHost(),
      port: options.port ?? workerEventPort(),
      fetch: (request) => this.handleRequest(request),
      idleTimeout: 30,
    })
    return this.server
  }

  async close(): Promise<void> {
    this.generation += 1
    this.handlers.clear()
    this.diagnostics = emptyDiagnostics()
    this.peerDown = null
    if (this.server) {
      await this.server.stop(true)
      this.server = null
    }
  }
}

let defaultTransport: LocalEventTransport | null = null

function getTransport(): LocalEventTransport {
  if (!defaultTransport) {
    defaultTransport = new LocalEventTransport({ token: internalEventToken() })
  }
  return defaultTransport
}

/**
 * Point this process's transport at its peer. Call once at startup:
 * `'api'` posts to the worker's loopback listener, `'worker'` posts back to
 * the api's existing Hono server.
 */
export function configureLocalEvents(role: 'api' | 'worker'): void {
  getTransport().configure({ peerUrl: role === 'api' ? workerPeerUrl() : apiPeerUrl() })
}

export function getLocalEventForwardingDiagnostics(): LocalEventForwardingDiagnostics {
  return getTransport().getDiagnostics()
}

/** Same shape as the old `pgNotify`. */
export function notify(channel: string, payload: string): Promise<void> {
  return getTransport().notify(channel, payload)
}

/** Same shape as the old `pgListen`. */
export function listen(channel: string, callback: LocalEventHandler): Promise<() => Promise<void>> {
  return getTransport().listen(channel, callback)
}

/** Start the worker's loopback event listener. Worker process only. */
export function startWorkerEventServer(): ReturnType<typeof Bun.serve> {
  return getTransport().serve({ port: workerEventPort() })
}

/** Handle an inbound event post (mounted on the api's Hono app). */
export function handleInternalEventPost(request: Request): Promise<Response> {
  return getTransport().handleRequest(request)
}

/** Same shape as the old `closePgListener`. */
export async function closeLocalEvents(): Promise<void> {
  if (!defaultTransport) return
  await defaultTransport.close()
  defaultTransport = null
}
