import { VOICE_DERIVATION_ACCEPT } from '@ficus/shared'
import { config } from './config'
import { ApiRequestError, formatApiErrorPayload } from './client-errors'

function getAuthHeaders(): Record<string, string> {
  return config.password ? { Authorization: `Bearer ${config.password}` } : {}
}

async function throwApiError(response: Response): Promise<never> {
  const fallback = `Request failed: ${response.status}`
  const payload = await response.json().catch(() => undefined)
  const code =
    payload && typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : undefined
  throw new ApiRequestError(formatApiErrorPayload(payload, fallback), response.status, code, payload)
}

/**
 * Bun reports a connection the server closed before answering as `ECONNRESET`, "The
 * socket connection was closed unexpectedly". A server older than the read deadline
 * (Core's middleware/read-deadline.ts) does that to a read it took over 30 s to answer.
 */
function isDroppedConnection(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    (error as { code?: unknown }).code === 'ECONNRESET' ||
    /socket connection was closed unexpectedly/i.test(error.message)
  )
}

/** A read whose connection closed before any answer arrived. */
export class ReadConnectionDroppedError extends Error {
  constructor(readonly cause: unknown) {
    super(
      'Ficus closed the connection before answering this read, most likely because it was busy for more than 30 seconds. Nothing was changed; try again in a few seconds.'
    )
    this.name = 'ReadConnectionDroppedError'
  }
}

async function readResponse(path: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      headers: getAuthHeaders(),
    })
  } catch (error) {
    if (isDroppedConnection(error)) throw new ReadConnectionDroppedError(error)
    throw error
  }
  if (!response.ok) await throwApiError(response)
  return response
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await readResponse(path)).json()
}

/** The target of a `Link: <...>; rel="next"` header, if the response has one. */
function nextLink(response: Response): string | undefined {
  for (const part of (response.headers.get('Link') ?? '').split(',')) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part)
    if (match && /\brel="?next"?/.test(match[2]!)) return match[1]
  }
  return undefined
}

/**
 * A list that may come in pages: the first answer is an array, and a `Link: <...>;
 * rel="next"` header names the paginated request for the rest (Core caps work stream
 * history that way). Each later page is `{ items, nextCursor }` and is fetched in
 * turn, so no single request carries the whole history. A server without the header
 * answers in one request, as before.
 */
export async function apiGetList<T>(path: string): Promise<T[]> {
  const first = await readResponse(path)
  const rows = (await first.json()) as T[]
  const link = nextLink(first)
  if (!link) return rows
  // Only the link's query is used, on this request's own path, so a path prefix the
  // server does not see (a proxy in front of it) still applies.
  const pathname = path.split('?')[0]!
  const query = new URL(link, 'http://link.invalid').searchParams
  const seen = new Set<string>()
  while (!seen.has(query.toString())) {
    seen.add(query.toString())
    const page = (await apiGet<{ items?: T[]; nextCursor?: string | null }>(`${pathname}?${query}`)) ?? {}
    rows.push(...(page.items ?? []))
    if (!page.nextCursor) break
    query.set('cursor', page.nextCursor)
  }
  return rows
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) await throwApiError(response)
  return response.json()
}

/** An idempotent POST that ran out of its time budget or retries; the server may still finish it. */
export class IdempotentRequestIncompleteError extends Error {
  constructor(
    readonly reason: 'timeout' | 'retries',
    readonly idempotencyKey: string,
    readonly timeoutMs: number,
    readonly cause?: unknown
  ) {
    super(
      reason === 'timeout'
        ? `No answer within ${Math.round(timeoutMs / 1000)} seconds`
        : `The request kept failing: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'IdempotentRequestIncompleteError'
  }
}

export interface IdempotentPostOptions {
  idempotencyKey: string
  /** Total time budget across every attempt. */
  timeoutMs: number
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** Called before each retry, for a progress note. */
  onRetry?: (attempt: number, reason: string) => void
  sleep?: (ms: number) => Promise<void>
}

const RETRYABLE_STATUSES = new Set([502, 503, 504])

/**
 * POST with an `Idempotency-Key` header, a bounded total time and safe retries.
 *
 * Only for endpoints that honor the key (a repeat returns the first result),
 * so a retry can never apply the request twice. Retries cover a dropped or
 * refused connection, a gateway error (502, 503, 504) and the server's
 * `create_in_progress` answer. Every other error response is returned at once.
 */
export async function apiPostIdempotent<T>(path: string, body: unknown, options: IdempotentPostOptions): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + options.timeoutMs
  const timedOut = (cause?: unknown) =>
    new IdempotentRequestIncompleteError('timeout', options.idempotencyKey, options.timeoutMs, cause)
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timedOut()
    // Only a request that got no answer, or an answer listed below, is retried.
    let failure: unknown
    let response: Response | undefined
    try {
      response = await fetch(`${config.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': options.idempotencyKey,
          ...getAuthHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      })
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))
        throw timedOut(error)
      // fetch rejects like this when the connection drops or is refused.
      failure = error
    }
    if (response) {
      // Everything after an answer arrived is final, except the retryable statuses:
      // an unreadable body is not retried.
      if (response.ok) return (await response.json()) as T
      const error = await throwApiError(response).catch((caught: unknown) => caught)
      const retryable =
        error instanceof ApiRequestError &&
        (RETRYABLE_STATUSES.has(error.status) || (error.status === 409 && error.code === 'create_in_progress'))
      if (!retryable) throw error
      failure = error
    }
    if (attempt >= maxRetries)
      throw new IdempotentRequestIncompleteError('retries', options.idempotencyKey, options.timeoutMs, failure)
    const pause = Math.min(1000 * 2 ** attempt, deadline - Date.now())
    if (pause <= 0) throw timedOut(failure)
    options.onRetry?.(attempt + 1, failure instanceof Error ? failure.message : String(failure))
    await sleep(pause)
  }
}

/** Authenticated, checked POST whose body stays unread for a negotiated stream. */
export async function apiPostResponse(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: VOICE_DERIVATION_ACCEPT },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) await throwApiError(response)
  return response
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  })
  if (!response.ok) await throwApiError(response)
  return response.json()
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  })
  if (!response.ok) await throwApiError(response)
  return response.json()
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    headers: { ...getAuthHeaders() },
    body: form,
  })
  if (!response.ok) await throwApiError(response)
  return response.json()
}

export async function apiGetRaw(path: string): Promise<Response> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    headers: getAuthHeaders(),
  })
  if (!response.ok) await throwApiError(response)
  return response
}

/**
 * Authenticated request that resolves with ANY status and leaves the body
 * unread — for streaming downloads, whose 206/416 answers are not errors.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { ...getAuthHeaders(), ...(init.headers as Record<string, string> | undefined) },
  })
}

export async function apiDelete<T = void>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'DELETE',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) await throwApiError(response)
  if (response.status === 204) return undefined as T
  return response.json()
}

/**
 * Stream the CLI's line-oriented SSE contract: each complete `data: ` line
 * invokes the callback with the current event name (defaulting to `message`).
 * LF and CRLF delimit lines; blank lines reset the event name. Unsupported
 * fields and unterminated trailing lines are ignored. Data is not JSON-decoded
 * or joined across lines, and completion/error events remain caller-owned.
 * An optional signal aborts the request and rejects with the signal's reason.
 */
export async function apiPostSSE(
  path: string,
  body: unknown,
  onEvent: (event: string, data: string) => void,
  { signal }: { signal?: AbortSignal } = {}
): Promise<void> {
  signal?.throwIfAborted()
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) await throwApiError(response)

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let finished = false
  let cancellation: Promise<void> | undefined
  // Cancellation failures must not replace a callback, read, or abort error.
  const cancel = (reason?: unknown) => (cancellation ??= reader.cancel(reason).catch(() => {}))
  const onAbort = () => {
    void cancel(signal?.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        finished = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        signal?.throwIfAborted()
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') {
          currentEvent = 'message'
        } else if (line.startsWith('event: ')) {
          currentEvent = line.slice(7)
        } else if (line.startsWith('data: ')) {
          onEvent(currentEvent, line.slice(6))
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!finished) await cancel(signal?.reason)
    reader.releaseLock()
  }
}
