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

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    headers: getAuthHeaders(),
  })
  if (!response.ok) await throwApiError(response)
  return response.json()
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
