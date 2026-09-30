import { describe, expect, it } from 'bun:test'
import { extractBearerToken, isAuthorized, loadExecutorAuthToken } from './auth'

function headers(init?: Record<string, string>): Headers {
  return new Headers(init)
}

describe('extractBearerToken', () => {
  it('returns the token from a Bearer authorization header', () => {
    expect(extractBearerToken(headers({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('is case-insensitive on the Bearer scheme', () => {
    expect(extractBearerToken(headers({ authorization: 'bearer tok' }))).toBe('tok')
  })

  it('returns null when the header is absent', () => {
    expect(extractBearerToken(headers())).toBeNull()
  })

  it('returns null for a non-bearer scheme', () => {
    expect(extractBearerToken(headers({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull()
  })
})

describe('loadExecutorAuthToken', () => {
  it('loads and trims a configured token file once', () => {
    expect(loadExecutorAuthToken({ EXECUTOR_AUTH_TOKEN_FILE: '/run/token' }, () => 'a'.repeat(64) + '\n')).toBe(
      'a'.repeat(64)
    )
  })
  it('fails closed for ambiguous, unreadable, empty, and oversized configuration', () => {
    expect(() =>
      loadExecutorAuthToken({ EXECUTOR_AUTH_TOKEN: 'literal', EXECUTOR_AUTH_TOKEN_FILE: '/run/token' }, () => 'file')
    ).toThrow()
    expect(() =>
      loadExecutorAuthToken({ EXECUTOR_AUTH_TOKEN_FILE: '/run/token' }, () => {
        throw new Error('secret filesystem detail')
      })
    ).toThrow('Unable to read executor auth token file')
    expect(() => loadExecutorAuthToken({ EXECUTOR_AUTH_TOKEN_FILE: '/run/token' }, () => '\n')).toThrow()
    expect(() => loadExecutorAuthToken({ EXECUTOR_AUTH_TOKEN_FILE: '/run/token' }, () => 'x'.repeat(4097))).toThrow()
  })
})

describe('isAuthorized', () => {
  it('always authorizes when no token is configured (k8s / legacy boxes)', () => {
    expect(isAuthorized(headers(), undefined)).toBe(true)
    expect(isAuthorized(headers(), '')).toBe(true)
    // A stray token header against an unenforcing server is harmless.
    expect(isAuthorized(headers({ authorization: 'Bearer whatever' }), undefined)).toBe(true)
  })

  it('authorizes a matching bearer token', () => {
    expect(isAuthorized(headers({ authorization: 'Bearer sekret' }), 'sekret')).toBe(true)
  })

  it('rejects a missing header when a token is configured', () => {
    expect(isAuthorized(headers(), 'sekret')).toBe(false)
  })

  it('rejects a wrong token', () => {
    expect(isAuthorized(headers({ authorization: 'Bearer nope' }), 'sekret')).toBe(false)
  })

  it('rejects a token that is a prefix of the expected one (length mismatch)', () => {
    expect(isAuthorized(headers({ authorization: 'Bearer sekre' }), 'sekret')).toBe(false)
  })
})
