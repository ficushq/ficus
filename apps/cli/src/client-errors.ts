/** A non-2xx API response. `code` is the server's machine-readable error code, when it sent one. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export function formatApiErrorPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const usage = formatUsage((payload as { usage?: unknown }).usage)
  const finish = (message: string) => `${message}${usage}`.slice(0, 500)
  const error = 'error' in payload ? (payload as { error?: unknown }).error : payload
  if (typeof error === 'string') return finish(error)
  if (!error || typeof error !== 'object') return finish(fallback)

  const issues = 'issues' in error ? (error as { issues?: unknown }).issues : undefined
  if (Array.isArray(issues)) {
    const formatted = issues
      .map((issue) => {
        if (!issue || typeof issue !== 'object') return String(issue)
        const issuePath = (issue as { path?: unknown }).path
        const path = Array.isArray(issuePath) ? issuePath.join('.') : ''
        const issueMessage = (issue as { message?: unknown }).message
        const message = typeof issueMessage === 'string' ? issueMessage : JSON.stringify(issue)
        return path ? `${path}: ${message}` : message
      })
      .filter(Boolean)
    if (formatted.length > 0) return finish(formatted.join('; '))
  }

  const message = 'message' in error ? (error as { message?: unknown }).message : undefined
  if (typeof message === 'string') return finish(message)
  return finish(JSON.stringify(error))
}

function formatUsage(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const usage = value as { squadCount?: unknown; squads?: unknown }
  if (typeof usage.squadCount !== 'number' || !Number.isSafeInteger(usage.squadCount) || usage.squadCount < 0) return ''
  const names = Array.isArray(usage.squads)
    ? usage.squads
        .flatMap((squad) =>
          squad && typeof squad === 'object' && typeof (squad as { name?: unknown }).name === 'string'
            ? [(squad as { name: string }).name.trim().slice(0, 100)]
            : []
        )
        .filter(Boolean)
        .slice(0, 10)
    : []
  return `. Used by ${usage.squadCount} squad${usage.squadCount === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}`
}
