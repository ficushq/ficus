import { describe, test, expect, afterEach } from 'bun:test'
import { normalizeOrigin, corsAllowOrigins, isAllowedWsOrigin, primaryWebOrigin } from './web-origins'

const KEYS = ['FICUS_WEB_ORIGIN', 'WEBAUTHN_ORIGIN', 'APP_URL', 'NODE_ENV'] as const
const orig: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (orig[k] === undefined) delete process.env[k]
    else process.env[k] = orig[k]
  }
})

describe('primaryWebOrigin', () => {
  test('strips a base path — WebAuthn requires a bare origin (the /tau footgun)', () => {
    process.env.FICUS_WEB_ORIGIN = 'https://home.example.com/tau'
    expect(primaryWebOrigin()).toBe('https://home.example.com')
  })
  test('falls back to APP_URL (path stripped) when FICUS_WEB_ORIGIN is unset', () => {
    delete process.env.FICUS_WEB_ORIGIN
    delete process.env.WEBAUTHN_ORIGIN
    process.env.APP_URL = 'https://home.example.com/tau'
    expect(primaryWebOrigin()).toBe('https://home.example.com')
  })
  test('defaults to localhost when nothing configured', () => {
    delete process.env.FICUS_WEB_ORIGIN
    delete process.env.WEBAUTHN_ORIGIN
    delete process.env.APP_URL
    expect(primaryWebOrigin()).toBe('http://localhost:5173')
  })
})

describe('normalizeOrigin', () => {
  test('lowercases scheme+host and strips trailing slash', () => {
    expect(normalizeOrigin('HTTPS://App.Example.COM/')).toBe('https://app.example.com')
  })
  test('normalizes default port away via URL parsing', () => {
    expect(normalizeOrigin('https://app.example.com:443')).toBe('https://app.example.com')
  })
  test('empty / undefined → undefined', () => {
    expect(normalizeOrigin(undefined)).toBeUndefined()
    expect(normalizeOrigin('   ')).toBeUndefined()
  })
})

describe('corsAllowOrigins', () => {
  test('includes configured origins, normalized', () => {
    delete process.env.NODE_ENV
    process.env.FICUS_WEB_ORIGIN = 'https://App.Example.com/'
    expect(corsAllowOrigins()).toContain('https://app.example.com')
  })
  test('includes localhost dev origins when NOT production', () => {
    process.env.NODE_ENV = 'development'
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    expect(corsAllowOrigins()).toContain('http://localhost:5173')
  })
  test('EXCLUDES localhost in production (no credentialed local origin)', () => {
    process.env.NODE_ENV = 'production'
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    const o = corsAllowOrigins()
    expect(o).toContain('https://app.example.com')
    expect(o).not.toContain('http://localhost:5173')
    expect(o).not.toContain('http://127.0.0.1:5173')
  })
})

describe('isAllowedWsOrigin (CSWSH defense)', () => {
  test('missing Origin (non-browser client) → allowed', () => {
    expect(isAllowedWsOrigin(undefined)).toBe(true)
  })
  test('allowlisted Origin → allowed (case/slash-insensitive)', () => {
    process.env.NODE_ENV = 'production'
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    expect(isAllowedWsOrigin('https://app.example.com')).toBe(true)
    expect(isAllowedWsOrigin('HTTPS://App.Example.com/')).toBe(true)
  })
  test('cross-site attacker Origin → rejected', () => {
    process.env.NODE_ENV = 'production'
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    expect(isAllowedWsOrigin('https://evil.com')).toBe(false)
  })
  test('localhost Origin rejected in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    expect(isAllowedWsOrigin('http://localhost:5173')).toBe(false)
  })
})
