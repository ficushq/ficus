import type { MiddlewareHandler } from 'hono'
import { createLogger } from '../lib/infra/logger'
import { QueryCancellationScope } from '../db/query-cancellation'

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

/**
 * Requests that turned their idle timer off or up through {@link extendIdleTimeout},
 * and when {@link restoreExtendedIdleTimeout} turns it back on: once the handler
 * returns, or once the response body has been sent ({@link holdIdleTimerUntilBodySent}).
 */
const extendedIdleTimeouts = new WeakMap<Request, { untilBodySent: boolean }>()

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
 *
 * Bun applies `server.timeout(request, seconds)` to the whole keep-alive socket,
 * not just this request, so {@link restoreExtendedIdleTimeout} puts the listener's
 * timeout back once the handler returns.
 */
export function extendIdleTimeout(c: RequestContext, seconds: number): void {
  exemptFromReadDeadline(c)
  if (!extendedIdleTimeouts.has(c.req.raw)) extendedIdleTimeouts.set(c.req.raw, { untilBodySent: false })
  bunServer(c)?.timeout(c.req.raw, seconds)
}

/**
 * Keep this request's idle timer off (or extended) until its response body has
 * been sent, rather than only until the handler returns, for a body that is
 * already a stream and can go quiet for longer than the listener's timeout while
 * it is produced: a directory archive being packed, or a download relayed from a
 * box. Bun cuts a streamed body that goes quiet, even mid-download.
 *
 * Only for such bodies: holding the timer means relaying the body through a JS
 * stream, and Bun sends a relayed body chunked, without its Content-Length and
 * without sendfile. A file body (`Bun.file`) cannot go quiet, so the restore when
 * the handler returns is right for it. A request that has not extended its
 * timeout gets it turned off here.
 */
export function holdIdleTimerUntilBodySent(c: RequestContext): void {
  if (!extendedIdleTimeouts.has(c.req.raw)) extendIdleTimeout(c, 0)
  extendedIdleTimeouts.get(c.req.raw)!.untilBodySent = true
}

/** For a route that sets the idle timeout itself (the local-app proxy). */
export function exemptFromReadDeadline(c: RequestContext): void {
  ownIdleTimeout.add(c.req.raw)
}

const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Turn the listener's idle timer back on for a request. Bun may throw here for a
 * request whose client has already gone; that is logged rather than allowed to
 * replace the handler's own result or error.
 */
function restoreIdleTimer(server: IdleTimeoutServer, request: Request, seconds: number): void {
  try {
    server.timeout(request, seconds)
  } catch (error) {
    log.warn(`Could not restore the idle timer for ${request.method} ${new URL(request.url).pathname}:`, error)
  }
}

/**
 * The same response, with a body that calls `restore` once it has been read to
 * the end, has failed, or has been cancelled (the client went away). It runs
 * before the end of the body is handed to Bun, while the request still owns its
 * socket: Bun ignores a timeout set after it has finished the response.
 */
function restoreWhenBodySent(response: Response, body: ReadableStream<Uint8Array>, restore: () => void): Response {
  let restored = false
  const restoreOnce = () => {
    if (restored) return
    restored = true
    restore()
  }
  const reader = body.getReader()
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        restoreOnce()
        controller.error(error)
        return
      }
      if (chunk.done) {
        restoreOnce()
        controller.close()
        return
      }
      controller.enqueue(chunk.value)
    },
    cancel(reason) {
      restoreOnce()
      return reader.cancel(reason)
    },
  })
  return new Response(tracked, response)
}

/**
 * Put the listener's idle timeout back on a request whose route turned it off or
 * up with {@link extendIdleTimeout}. Without this, every keep-alive connection that
 * once made such a request would never be closed for idleness.
 *
 * The timer comes back once the handler returns, before the response is written,
 * or, for a route that called {@link holdIdleTimerUntilBodySent}, once its response
 * body has been sent. The local-app proxy ({@link exemptFromReadDeadline}) manages
 * its own.
 */
export function restoreExtendedIdleTimeout(options: { idleTimeoutSeconds?: number } = {}): MiddlewareHandler {
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? CORE_IDLE_TIMEOUT_SECONDS
  return async (c, next) => {
    let answered = false
    try {
      await next()
      answered = true
    } finally {
      const extension = extendedIdleTimeouts.get(c.req.raw)
      const server = extension ? bunServer(c) : undefined
      if (extension && server) {
        const restore = () => restoreIdleTimer(server, c.req.raw, idleTimeoutSeconds)
        // Bun sends no body for a HEAD, so it would never be read to the end.
        const body = answered && extension.untilBodySent && c.req.method !== 'HEAD' ? c.res.body : null
        if (body) c.res = restoreWhenBodySent(c.res, body, restore)
        else restore()
      }
    }
  }
}

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
 * idle timeout ({@link extendIdleTimeout}, {@link exemptFromReadDeadline}) keeps it
 * here; {@link restoreExtendedIdleTimeout} restores an extended one.
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
      if (!ownIdleTimeout.has(c.req.raw)) restoreIdleTimer(server, c.req.raw, idleTimeoutSeconds)
    }
  }
}

/**
 * Answer a read that has not produced a response within the deadline with a 503,
 * `Retry-After` and code {@link READ_DEADLINE_CODE}, before Bun's idle timer can
 * drop it. Only the time to the response headers counts: a streamed body that
 * started in time is not cut.
 *
 * Nobody reads an abandoned handler's result, so its database work is cancelled
 * (db/query-cancellation.ts): when the deadline answers for it, and when the client
 * hangs up before it answered. Only the queries the handler has in flight at that
 * moment are cancelled (running ones once they have run for a second); they fail
 * with 57014 and their pool connections are free for the next request. Once the
 * handler has answered nothing is cancelled, so a streamed body runs its own course,
 * and work the read shared with other callers runs outside its scope.
 */
export function readDeadline(options: { seconds?: number } = {}): MiddlewareHandler {
  const seconds = options.seconds ?? READ_DEADLINE_SECONDS
  return async (c, next) => {
    if (!READ_METHODS.has(c.req.method)) return next()
    const started = performance.now()
    const scope = new QueryCancellationScope()
    const request = c.req.raw
    const onDisconnect = () => scope.abandon(new Error('the client closed the connection'))
    if (request.signal.aborted) onDisconnect()
    else request.signal.addEventListener('abort', onDisconnect, { once: true })
    const work = scope.run(() => next())
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), seconds * 1000)
    })
    try {
      const first = await Promise.race([work.then(() => 'answered' as const), expired])
      if (first === 'answered') return
      if (ownIdleTimeout.has(request)) {
        await work
        return
      }
      scope.abandon(new Error(`no answer within the ${seconds}s read deadline`))
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onDisconnect)
      // No-op once abandoned; otherwise the handler answered and nothing more is recorded.
      scope.close()
    }
    const route = `${c.req.method} ${c.req.path}`
    log.warn(
      `${route} had no answer after ${seconds}s; answered 503 ${READ_DEADLINE_CODE} and cancelled its database queries`
    )
    work.then(
      () =>
        log.warn(`${route} finished ${Math.round(performance.now() - started)}ms after it started; result discarded`),
      (error: unknown) => log.warn(`${route} stopped after its read deadline:`, error)
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
