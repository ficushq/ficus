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
      : undefined
  throw new ApiRequestError(formatApiErrorPayload(payload, fallback), response.status, code)
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

export async function apiPostSSE(
  path: string,
  body: unknown,
  onEvent: (event: string, data: string) => void
): Promise<void> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    let currentEvent = 'message'
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        onEvent(currentEvent, line.slice(6))
      }
    }
  }
}
