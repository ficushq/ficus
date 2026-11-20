/**
 * The token lacks a scope the request needs: Linear answers `Invalid scope: \`write\` required`
 * (`FORBIDDEN`, sent with HTTP 400). Only reconnecting the app with the missing scope fixes it, so
 * callers mark the connection as needing reconnect instead of retrying. The message is the fixed
 * code `insufficient_scope`.
 */
export class LinearInsufficientScopeError extends Error {
  constructor() {
    super('insufficient_scope')
    this.name = 'LinearInsufficientScopeError'
  }
}

/** Whether Linear's GraphQL errors say the token lacks a scope. */
export function isLinearScopeError(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.some((error) => {
      const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
      return typeof message === 'string' && /^invalid scope\b/i.test(message.trim())
    })
  )
}
