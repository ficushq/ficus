import type { MiddlewareHandler } from 'hono'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('read-deadline')

/**
 * Core's listener idle timeout (Bun.serve `idleTimeout`, index.ts).
 *
 * Bun's idle timer only ever closes a request that carries no body: a GET, or a
 * POST without one. If such a handler has sent nothing for this long, Bun closes
 * the socket and the client sees "The socket connection was closed unexpectedly"
 * while the handler keeps running. A request with a body (a JSON POST) is never
 * closed by it, even after the handler has read the body. Measured on Bun 1.4.2:
 * at 30 s the close comes about 32 s after the request; handlers that answer at
 * 28 s and 31 s still get through. Reads answer before then ({@link readDeadline});
 * body-less writes have the timer held off ({@link holdIdleTimerForBodylessWrites}).
 */
export const CORE_IDLE_TIMEOUT_SECONDS = 30

/**
 * How long a read (GET or HEAD under /api) may take before Core answers it with a
 * 503 itself. It sits a few seconds under {@link CORE_IDLE_TIMEOUT_SECONDS} so the
 * client always gets an answer it can explain, never a dropped socket. A read has
 * no side effects, so answering early loses nothing but the late result.
 */
export const READ_DEADLINE_SECONDS = 25

/** Seconds a client should wait before retrying a read that ran out of time. */
export const READ_DEADLINE_RETRY_AFTER_SECONDS = 5

export const READ_DEADLINE_CODE = 'read_deadline_exceeded'

export function readDeadlineMessage(seconds: number): string {
  return `Ficus is busy and did not finish this read within ${seconds} seconds. Nothing was changed; try again in a few seconds.`
}

/** Requests whose route set its own idle timeout: the read deadline leaves them alone. */
const ownIdleTimeout = new WeakSet<Request>()

type IdleTimeoutServer = { timeout(request: Request, seconds: number): void }

/** The part of a Hono context these helpers use, so any route's context fits. */
type RequestContext = { env: unknown; req: { raw: Request } }

/** Bun's server, as index.ts hands it to `app.fetch` (hono/bun `getBunServer` reads it the same way). */
function bunServer(c: RequestContext): IdleTimeoutServer | undefined {
  const env = c.env
  if (!env || typeof env !== 'object') return undefined
  const server: unknown = 'server' in env ? env.server : env
  if (!server || typeof server !== 'object' || !('timeout' in server)) return undefined
  return typeof server.timeout === 'function' ? (server as IdleTimeoutServer) : undefined
}

/**
 * Give this request its own idle timeout (0 disables it) instead of the
 * listener's 30 seconds, for routes that legitimately work longer before they
 * answer (workspace transfers, work stream creation). The read deadline then
 * does not answer for them either.
 */
export function extendIdleTimeout(c: RequestContext, seconds: number): void {
  exemptFromReadDeadline(c)
  bunServer(c)?.timeout(c.req.raw, seconds)
}

/** For a route that sets the idle timeout itself (the local-app proxy). */
export function exemptFromReadDeadline(c: RequestContext): void {
  ownIdleTimeout.add(c.req.raw)
}

const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Keep Bun's idle timer off a write that carries no body (the CLI's pause, resume,
 * cancel and reopen, or a body-less DELETE) while its handler runs, so a slow
 * mutation answers with its real result instead of a dropped socket. That is how
 * Bun already treats a write with a body. A write cannot be answered early the way
 * a read is, because it may already have changed something.
 *
 * The timer comes back once the handler returns, before the response is written:
 * `server.timeout(request, 0)` lasts for the whole keep-alive socket, so leaving it
 * off would let that idle connection stay open forever. A route that set its own
 * idle timeout ({@link extendIdleTimeout}, {@link exemptFromReadDeadline}) keeps it.
 */
export function holdIdleTimerForBodylessWrites(options: { idleTimeoutSeconds?: number } = {}): MiddlewareHandler {
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? CORE_IDLE_TIMEOUT_SECONDS
  return async (c, next) => {
    if (READ_METHODS.has(c.req.method) || c.req.raw.body !== null) return next()
    const server = bunServer(c)
    if (!server) return next()
    server.timeout(c.req.raw, 0)
    try {
      await next()
    } finally {
      if (!ownIdleTimeout.has(c.req.raw)) server.timeout(c.req.raw, idleTimeoutSeconds)
    }
  }
}

/**
 * Answer a read that has not produced a response within the deadline with a 503,
 * `Retry-After` and code {@link READ_DEADLINE_CODE}, before Bun's idle timer can
 * drop it. Only the time to the response headers counts: a streamed body that
 * started in time is not cut. The handler is not cancelled; its late result is
 * discarded and logged.
 */
export function readDeadline(options: { seconds?: number } = {}): MiddlewareHandler {
  const seconds = options.seconds ?? READ_DEADLINE_SECONDS
  return async (c, next) => {
    if (!READ_METHODS.has(c.req.method)) return next()
    const started = performance.now()
    const work = next()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), seconds * 1000)
    })
    try {
      const first = await Promise.race([work.then(() => 'answered' as const), expired])
      if (first === 'answered' || ownIdleTimeout.has(c.req.raw)) {
        await work
        return
      }
    } finally {
      clearTimeout(timer)
    }
    const route = `${c.req.method} ${c.req.path}`
    log.warn(`${route} had no answer after ${seconds}s; answered 503 ${READ_DEADLINE_CODE}`)
    work.then(
      () =>
        log.warn(`${route} finished ${Math.round(performance.now() - started)}ms after it started; result discarded`),
      (error: unknown) => log.warn(`${route} failed after its read deadline:`, error)
    )
    // A fresh Response, so headers the abandoned handler may already have set on `c` do not leak into it.
    return new Response(JSON.stringify({ error: readDeadlineMessage(seconds), code: READ_DEADLINE_CODE }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(READ_DEADLINE_RETRY_AFTER_SECONDS),
        'Cache-Control': 'no-store',
      },
    })
  }
}
