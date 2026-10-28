import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_VAULTS,
  managedBigbrainHostBindingSchema,
  managedBigbrainHostStateSchema,
  managedBigbrainOriginHasVault,
} from '@ficus/shared/managed-bigbrain'

const MAX_INPUT = 1024 * 1024 + 64 * 1024
const MAX_OUTPUT = 16 * 1024 * 1024
const REQUEST_MS = 15000
/** A join (upstream connectInvite) is a redeem that spends the single-use link, then a whoami with the
 * credential it returned. That whoami is reserved when the redeem succeeds: one use, this vault only,
 * keyed by a hash of the new credential (never the credential), bounded in count and lifetime. */
export const JOIN_GRACE_MS = 30_000
export const JOIN_GRACE_MAX = 16
/** Reserved whoamis pass the normal in-flight caps but have their own small ones, so in-flight never
 * exceeds the normal caps (4 host, 2 per vault) plus this allowance. A reserved whoami that finds its
 * cap full waits for a slot (in arrival order, at most JOIN_WAIT_MS) instead of being refused. */
export const JOIN_RESERVED_VAULT = 1
/** Defence in depth: with MANAGED_BIGBRAIN_MAX_VAULTS (2) vaults the per-vault cap already bounds this. */
export const JOIN_RESERVED_HOST = 2
export const JOIN_WAIT_MS = 5_000
const MEMBER_CREDENTIAL = /^sv_[A-Za-z0-9_-]{1,512}$/
const credentialKey = (vaultId: string, credential: string) =>
  `${vaultId}:${createHash('sha256').update(credential).digest('hex')}`
const routeSchema = z
  .object({
    vaultId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]{36}$/),
    upstreamVaultId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]{36}$/),
    origin: z.string().max(253),
    state: z.enum(['ready', 'maintenance', 'disabled']),
  })
  .strict()
  // A recorded origin (either form) for exactly this vault; never re-derived from the current label.
  .refine((v) => managedBigbrainOriginHasVault(v.origin, v.vaultId))
export const gatewayManifestSchema = managedBigbrainHostBindingSchema
  .extend({
    contractVersion: z.literal(1),
    hostState: managedBigbrainHostStateSchema,
    routes: z.array(routeSchema).max(MANAGED_BIGBRAIN_MAX_VAULTS),
  })
  .strict()
  .refine((v) => new Set(v.routes.map((r) => r.vaultId)).size === v.routes.length)
  // Routing is by hostname: a duplicate fails closed instead of reaching the first match.
  .refine((v) => new Set(v.routes.map((r) => new URL(r.origin).hostname)).size === v.routes.length)
export type GatewayManifest = z.infer<typeof gatewayManifestSchema>

const GET_PATHS = new Set([
  '/invite',
  '/authorize',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/v1/whoami',
  '/v1/members',
  '/v1/contributions',
  '/v1/evidence',
  '/v1/assertions',
  '/v1/identities',
  '/v1/search',
  '/v1/feed',
])
const POST_PATHS = new Set([
  '/mcp',
  '/invite/check',
  '/register',
  '/authorize/consent',
  '/authorize/invite',
  '/token',
  '/v1/invites/redeem',
  '/v1/invites',
  '/v1/members',
  '/v1/evidence',
  '/v1/evidence/batch',
  '/v1/assertions',
  '/v1/identities',
  '/v1/moderation',
  '/v1/credentials/agent',
])
const record = '[a-zA-Z0-9_-]{1,200}'
const getRecord = new RegExp(`^/v1/(?:evidence|assertions)/${record}$`)
const postRecord = new RegExp(
  `^/v1/(?:assertions/${record}/(?:correct|retract)|contributions/${record}/(?:withdraw|restore)|members/${record}/(?:email|access|remove)|invites/${record}/cancel)$`
)
function allowed(method: string, path: string): boolean {
  if (path.includes('%') || path.includes('\\') || path.includes('//')) return false
  return method === 'GET'
    ? GET_PATHS.has(path) ||
        getRecord.test(path) ||
        ['/assets/hanken-grotesk-latin.woff2', '/assets/hanken-grotesk-latin-ext.woff2'].includes(path)
    : method === 'POST' && (POST_PATHS.has(path) || postRecord.test(path))
}
function safeRedirect(location: string, origin: string): boolean {
  try {
    const url = new URL(location, origin)
    if (url.username || url.password || url.hash) return false
    if (url.origin === origin) return true
    if (
      url.protocol === 'https:' &&
      ['claude.ai', 'claude.com'].includes(url.hostname) &&
      !url.port &&
      url.pathname === '/api/mcp/auth_callback'
    )
      return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/callback'
  } catch {
    return false
  }
}
function refusal(status: number, code: string): Response {
  return Response.json(
    { code },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        ...(status === 429 ? { 'Retry-After': '1' } : {}),
      },
    }
  )
}
class Bucket {
  private last: number
  private tokens: number
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now: number
  ) {
    this.last = now
    this.tokens = burst
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.last) * this.perSecond) / 1000)
    this.last = Math.max(this.last, now)
    if (this.tokens < 1) return false
    this.tokens--
    return true
  }
}
async function readInput(request: Request, signal: AbortSignal): Promise<ArrayBuffer | undefined> {
  const length = request.headers.get('Content-Length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_INPUT)) throw new Error('input_limit')
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new Error('deadline')
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_INPUT) throw new Error('input_limit')
      chunks.push(next.value)
    }
    return new Uint8Array(Buffer.concat(chunks)).buffer
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readOutput(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new Error('deadline')
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_OUTPUT) throw new Error('output_limit')
      chunks.push(next.value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Exact-host, bounded credential-free forwarding. Nothing in a request chooses an IP/port.
 * Upstream retains all auth/member/write enforcement. No content/auth/URL logging exists here.
 */
/** Root-prepared per-vault socket: owned by that vault's UID, group gateway, never caller-chosen. */
export const vaultSocketPath = (vaultId: string) => `/run/ficus-bigbrain/vaults/${vaultId}/http.sock`
export const GATEWAY_SOCKET = '/run/ficus-bigbrain/gateway/http.sock'

export function createGatewayHandler(options: {
  manifest: () => Promise<unknown>
  now?: () => number
  fetch?: (url: string, init: RequestInit & { unix: string }) => Promise<Response>
  /** Fixture-only override of the fixed socket location. */
  socketPath?: (vaultId: string) => string
  /** Fixture-only override of JOIN_WAIT_MS. */
  joinWaitMs?: number
}): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now
  const forward = options.fetch ?? ((url, init) => fetch(url, init))
  const socketFor = options.socketPath ?? vaultSocketPath
  let aggregate = 0
  const globalBucket = new Bucket(2, 20, now())
  type VaultLoad = { active: number; mutations: number; reserved: number; read: Bucket; write: Bucket }
  const vaults = new Map<string, VaultLoad>()
  let reservedActive = 0
  const reservedWaiters: Array<{ vault: VaultLoad; admit: () => void }> = []
  const reservedFits = (vault: VaultLoad) => reservedActive < JOIN_RESERVED_HOST && vault.reserved < JOIN_RESERVED_VAULT
  const takeReserved = (vault: VaultLoad) => {
    reservedActive++
    vault.reserved++
  }
  const releaseReserved = (vault: VaultLoad) => {
    reservedActive--
    vault.reserved--
    for (let i = 0; i < reservedWaiters.length; ) {
      const waiter = reservedWaiters[i]!
      if (!reservedFits(waiter.vault)) {
        i++
        continue
      }
      reservedWaiters.splice(i, 1)
      takeReserved(waiter.vault)
      waiter.admit()
    }
  }
  /** Resolves true holding a reserved slot, or false (holding nothing) on timeout or abort. */
  const acquireReserved = (vault: VaultLoad, signal: AbortSignal): Promise<boolean> => {
    if (reservedFits(vault) && !reservedWaiters.some((w) => w.vault === vault)) {
      takeReserved(vault)
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const waiter = {
        vault,
        admit: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', give)
          resolve(true)
        },
      }
      const give = () => {
        const index = reservedWaiters.indexOf(waiter)
        if (index < 0) return
        reservedWaiters.splice(index, 1)
        clearTimeout(timer)
        signal.removeEventListener('abort', give)
        resolve(false)
      }
      const timer = setTimeout(give, options.joinWaitMs ?? JOIN_WAIT_MS)
      signal.addEventListener('abort', give, { once: true })
      reservedWaiters.push(waiter)
      if (signal.aborted) give()
    })
  }
  // Insertion-ordered: the oldest reservation is dropped first when full.
  const joinGrace = new Map<string, number>()
  const pruneGrace = (at: number) => {
    for (const [key, expires] of joinGrace) if (expires <= at) joinGrace.delete(key)
  }
  const reserveJoin = (vaultId: string, redeemed: Uint8Array) => {
    let credential: unknown
    try {
      credential = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(redeemed)) as { token?: unknown })
        ?.token
    } catch {
      return
    }
    if (typeof credential !== 'string' || !MEMBER_CREDENTIAL.test(credential)) return
    const at = now()
    pruneGrace(at)
    const key = credentialKey(vaultId, credential)
    joinGrace.delete(key)
    while (joinGrace.size >= JOIN_GRACE_MAX) joinGrace.delete(joinGrace.keys().next().value!)
    joinGrace.set(key, at + JOIN_GRACE_MS)
  }
  /** Consumes the reservation for exactly this vault and credential, if one is live. */
  const claimJoin = (vaultId: string, authorization: string | null): boolean => {
    if (joinGrace.size === 0 || !authorization?.startsWith('Bearer ')) return false
    const credential = authorization.slice(7)
    if (!MEMBER_CREDENTIAL.test(credential)) return false
    pruneGrace(now())
    return joinGrace.delete(credentialKey(vaultId, credential))
  }
  return async (request) => {
    let manifest: GatewayManifest
    try {
      manifest = gatewayManifestSchema.parse(await options.manifest())
    } catch {
      return refusal(503, 'not_installed')
    }
    if (manifest.hostState !== 'active') return refusal(503, 'maintenance')
    const host = request.headers.get('Host') ?? ''
    const route = manifest.routes.find((route) => new URL(route.origin).hostname === host)
    const url = new URL(request.url)
    if (!route || url.pathname.length + url.search.length > 8192 || !allowed(request.method, url.pathname))
      return refusal(404, 'not_found')
    if (route.state !== 'ready') return refusal(503, 'maintenance')
    for (const [id, v] of vaults) if (!v.active && !manifest.routes.some((r) => r.vaultId === id)) vaults.delete(id)
    let vault = vaults.get(route.vaultId)
    if (!vault) {
      vault = {
        active: 0,
        mutations: 0,
        reserved: 0,
        read: new Bucket(1, 10, now()),
        write: new Bucket(0.5, 10, now()),
      }
      vaults.set(route.vaultId, vault)
    }
    // MCP POSTs are reads; all other POSTs are serialized mutations (including native auth).
    const mutation = request.method === 'POST' && url.pathname !== '/mcp'
    const redeem = request.method === 'POST' && url.pathname === '/v1/invites/redeem'
    // The reserved whoami after a join skips the buckets and the normal in-flight caps for its own
    // small ones (still counted in the normal totals while in flight); every other request, including
    // a second whoami, is limited as usual.
    const reserved =
      request.method === 'GET' &&
      url.pathname === '/v1/whoami' &&
      claimJoin(route.vaultId, request.headers.get('Authorization'))
    if (!reserved) {
      if (aggregate >= 4 || vault.active >= 2 || (mutation && vault.mutations >= 1)) return refusal(429, 'busy')
      if (!(mutation ? vault.write : vault.read).take(now()) || !globalBucket.take(now())) return refusal(429, 'busy')
    } else if (!(await acquireReserved(vault, request.signal))) return refusal(429, 'busy')
    aggregate++
    vault.active++
    if (mutation) vault.mutations++
    const controller = new AbortController()
    let timedOut = false
    let finished = false
    let deferred = false
    const requestAbort = () => controller.abort()
    request.signal.addEventListener('abort', requestAbort, { once: true })
    if (request.signal.aborted) controller.abort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_MS)
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', requestAbort)
      aggregate--
      vault!.active--
      if (mutation) vault!.mutations--
      if (reserved) releaseReserved(vault!)
    }
    try {
      const type = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
      if (
        request.method === 'POST' &&
        type &&
        !['application/json', 'application/x-www-form-urlencoded'].includes(type)
      )
        return refusal(415, 'invalid_request')
      const body = await readInput(request, controller.signal)
      if (controller.signal.aborted) throw new Error('deadline')
      const headers = new Headers()
      for (const key of [
        'authorization',
        'content-type',
        'accept',
        'mcp-protocol-version',
        'origin',
        'referer',
        'cookie',
      ]) {
        const value = request.headers.get(key)
        if (value !== null) headers.set(key, value)
      }
      headers.set('Host', host)
      headers.set('X-Forwarded-Proto', 'https')
      headers.set('Accept-Encoding', 'identity')
      // Unix socket only: the vault has no TCP listener anyone could squat.
      const response = await forward(`http://${host}${url.pathname}${url.search}`, {
        unix: socketFor(route.vaultId),
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        await response.body?.cancel().catch(() => {})
        throw new Error('deadline')
      }
      const outgoing = new Headers(response.headers)
      for (const key of [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'content-length',
        'content-encoding',
      ])
        outgoing.delete(key)
      outgoing.set('Cache-Control', 'no-store')
      const location = outgoing.get('Location')
      if (location && !safeRedirect(location, route.origin)) {
        await response.body?.cancel().catch(() => {})
        return refusal(502, 'upstream_protocol')
      }
      const declared = Number(response.headers.get('Content-Length'))
      if (declared > MAX_OUTPUT) {
        await response.body?.cancel().catch(() => {})
        return refusal(502, 'output_limit')
      }
      if (!response.body) return new Response(null, { status: response.status, headers: outgoing })
      if (redeem && response.ok) {
        // Buffered (bounded, under the same deadline) so the reservation exists before the client
        // can send its whoami. The body is relayed unchanged and never logged or kept.
        const redeemed = await readOutput(response.body, controller.signal)
        reserveJoin(route.vaultId, redeemed)
        return new Response(redeemed, { status: response.status, headers: outgoing })
      }
      const reader = response.body.getReader()
      let bytes = 0
      let stopped = false
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const dispose = async () => {
        controller.signal.removeEventListener('abort', abort)
        try {
          await reader.cancel()
        } catch {
          /* no raw upstream errors */
        }
        try {
          reader.releaseLock()
        } catch {
          /* a canceled pending read settles first */
        }
        finish()
      }
      const abort = () => {
        if (stopped) return
        stopped = true
        streamController.error(new Error(timedOut ? 'deadline' : 'cancelled'))
        void dispose()
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c
        },
        async pull(c) {
          if (stopped) return
          try {
            const next = await reader.read()
            if (stopped) return
            if (next.done) {
              stopped = true
              c.close()
              await dispose()
              return
            }
            bytes += next.value.byteLength
            if (bytes > MAX_OUTPUT) throw new Error('output_limit')
            c.enqueue(next.value)
          } catch (error) {
            if (stopped) return
            stopped = true
            c.error(
              new Error(
                error instanceof Error && error.message === 'output_limit' ? 'output_limit' : 'upstream_unavailable'
              )
            )
            controller.abort()
            await dispose()
          }
        },
        async cancel() {
          stopped = true
          controller.abort()
          await dispose()
        },
      })
      deferred = true
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
      return new Response(stream, { status: response.status, headers: outgoing })
    } catch (error) {
      controller.abort()
      const code = error instanceof Error ? error.message : ''
      if (!timedOut && code === 'output_limit') return refusal(502, 'output_limit')
      return refusal(
        timedOut ? 504 : code === 'input_limit' ? 413 : 503,
        timedOut ? 'upstream_unavailable' : code === 'input_limit' ? 'resource_limit' : 'upstream_unavailable'
      )
    } finally {
      if (!deferred) finish()
    }
  }
}
