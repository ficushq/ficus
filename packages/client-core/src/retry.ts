/**
 * Retry policy for the apps' query clients.
 *
 * Core answers a read it cannot finish within its deadline with `503` and `Retry-After: 5`, and the
 * handler behind it keeps running. Retrying such a read at once (or after a second, like any other
 * failure) starts another slow handler on a server that just said it is busy. A 503 therefore waits
 * at least as long as Retry-After asks, backs off from there, and gives up rather than wait longer
 * than a bound. Every other failure keeps TanStack Query's usual three retries and backoff.
 *
 * One 503 has a longer bound. While Core cannot provision a sandbox, a read served from it (a
 * workspace tree or file) answers 503 with a `SANDBOX_PROVISION_*` code and the provisioning
 * circuit's cooldown as Retry-After, which can pass a minute. That read succeeds once the sandbox is
 * up, so it waits up to five minutes per retry, and the screen shows that the workspace is starting
 * (isSandboxProvisioningFailure) rather than an error.
 */

/** Retries for an ordinary failed query, as TanStack Query's default. */
export const QUERY_RETRY_LIMIT = 3
/** Retries for a busy (503) read: each one may start another slow handler. */
export const BUSY_RETRY_LIMIT = 2
/** A 503 without a usable Retry-After waits as long as Core's own read deadline asks. */
export const BUSY_RETRY_DEFAULT_MS = 5_000
/** A 503 is never retried sooner than this, even when Retry-After says 0. */
export const BUSY_RETRY_MIN_MS = 1_000
/** The longest a busy read waits before a retry (before jitter); a longer Retry-After stops retrying. */
export const BUSY_RETRY_MAX_MS = 60_000
/** Retries for a read refused while its sandbox cannot be provisioned. */
export const SANDBOX_PROVISION_RETRY_LIMIT = 4
/** The longest such a read waits before a retry (before jitter): a provisioning cooldown can pass a minute. */
export const SANDBOX_PROVISION_RETRY_MAX_MS = 5 * 60_000
/** Core's error codes for a sandbox it cannot provision yet (SandboxProvisionErrorCode). */
export const SANDBOX_PROVISION_CODE_PREFIX = 'SANDBOX_PROVISION_'

/**
 * An HTTP Retry-After value (delta-seconds or an HTTP-date) as milliseconds from `now`, or
 * undefined when absent or unparseable. A date in the past is 0.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) return Number(text) * 1000
  // An HTTP-date always names its day and month; Date.parse alone would read "-5" as a year.
  if (!/[a-z]/i.test(text)) return undefined
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

type HttpFailure = { status: number; retryAfterMs?: number; code?: string }

/** The error code of a failed request: its own `code`, or the response body's (the web ApiError's `payload`). */
function failureCode(error: object): string | undefined {
  const own = (error as { code?: unknown }).code
  if (typeof own === 'string') return own
  const payload = (error as { payload?: unknown }).payload
  const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

function httpFailure(error: unknown): HttpFailure | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  if (typeof status !== 'number') return undefined
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  return { status, retryAfterMs: typeof retryAfterMs === 'number' ? retryAfterMs : undefined, code: failureCode(error) }
}

/**
 * Whether a read was refused (503) because Core cannot provision its sandbox yet. Such a read is
 * retried for longer, and a screen waiting on it can say the workspace is starting.
 */
export function isSandboxProvisioningFailure(error: unknown): boolean {
  const failure = httpFailure(error)
  return failure?.status === 503 && !!failure.code?.startsWith(SANDBOX_PROVISION_CODE_PREFIX)
}

/** How many times, and for how long at most each time, a busy (503) read is retried. */
function busyBounds(error: unknown): { limit: number; maxMs: number } {
  return isSandboxProvisioningFailure(error)
    ? { limit: SANDBOX_PROVISION_RETRY_LIMIT, maxMs: SANDBOX_PROVISION_RETRY_MAX_MS }
    : { limit: BUSY_RETRY_LIMIT, maxMs: BUSY_RETRY_MAX_MS }
}

/** The wait a 503 asks for before its first retry, bounded below; undefined for any other failure. */
function busyBaseDelay(error: unknown): number | undefined {
  const failure = httpFailure(error)
  if (failure?.status !== 503) return undefined
  return Math.max(BUSY_RETRY_MIN_MS, failure.retryAfterMs ?? BUSY_RETRY_DEFAULT_MS)
}

/** TanStack Query `retry`: `failureCount` is how many retries already ran. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const busy = busyBaseDelay(error)
  if (busy === undefined) return failureCount < QUERY_RETRY_LIMIT
  const { limit, maxMs } = busyBounds(error)
  return failureCount < limit && busy * 2 ** failureCount <= maxMs
}

/**
 * TanStack Query `retryDelay`. A 503 waits Retry-After (or the default), doubled per retry, plus up
 * to a tenth more so a page's queries do not all return at once; never less than Retry-After asks.
 */
export function queryRetryDelay(failureCount: number, error: unknown, random: () => number = Math.random): number {
  const busy = busyBaseDelay(error)
  if (busy === undefined) return Math.min(1000 * 2 ** failureCount, 30_000)
  const delay = Math.min(busy * 2 ** failureCount, busyBounds(error).maxMs)
  return Math.round(delay + delay * 0.1 * random())
}
