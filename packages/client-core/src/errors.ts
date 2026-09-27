export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpResponseError'
  }
}

export function isHttpResponseError(error: unknown, status?: number): error is HttpResponseError {
  return error instanceof HttpResponseError && (status === undefined || error.status === status)
}

/**
 * Extract a human-readable message from a failed API Response.
 * Shared by web and mobile. Proxy HTML is never a useful API error detail.
 */
export async function readApiErrorMessage(response: Response): Promise<string> {
  const fallback = `API error: ${response.status}`
  try {
    const contentType = response.headers.get('Content-Type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await response.clone().json()) as unknown
      const detail = readErrorDetail(body)
      return detail ? `${fallback}: ${detail}` : fallback
    }
    const text = (await response.clone().text()).trim()
    if (contentType.includes('text/html') || /<(?:!doctype|html|head|body)\b/i.test(text)) {
      return response.status >= 500
        ? `Ficus is temporarily unavailable (${response.status}). Please try again shortly.`
        : fallback
    }
    return text ? `${fallback}: ${text}` : fallback
  } catch {
    return fallback
  }
}

function readErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim()
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  // Hono's schema validator returns { success: false, error: { name, issues } }.
  // Preserve issue paths (including nested union errors) so callers can correct tool arguments.
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>
    if (Array.isArray(error.issues)) return JSON.stringify(error.issues)
  }
  return undefined
}
