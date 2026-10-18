import { ApiError } from '../api/client'

/**
 * The server's own `{ error }` sentence for a failed local app action (for example why a
 * restart was refused with 409). Anything else gets a generic message, so raw transport
 * details or stack traces never reach the UI.
 */
export function localDeploymentActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const payload = error.payload as { error?: unknown } | undefined
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
  }
  return 'Something went wrong. Try again.'
}
