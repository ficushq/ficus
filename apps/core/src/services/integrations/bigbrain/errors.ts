export type BigbrainErrorCode =
  | 'binding_unavailable'
  | 'binding_changed'
  | 'unsupported_host'
  | 'busy'
  | 'outcome_unknown'
  | 'cancelled'
  | 'invalid_auth'
  | 'missing_scope'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'
  | 'response_too_large'
  | 'invalid_configuration'

export class BigbrainError extends Error {
  constructor(
    readonly code: BigbrainErrorCode,
    readonly retryAfterMs?: number
  ) {
    super(`Bigbrain request failed: ${code}`)
    this.name = 'BigbrainError'
  }

  toJSON(): { code: BigbrainErrorCode; retryAfterMs?: number } {
    return { code: this.code, ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }) }
  }
}
