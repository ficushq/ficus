import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rpConfigFor } from './webauthn'
import { rpOriginForStepUp, webAppUrlForOrigin } from './web-origins'

const KEYS = [
  'FICUS_WEB_ORIGIN',
  'WEBAUTHN_ORIGIN',
  'WEBAUTHN_RP_ID',
  'APP_URL',
  'PUBLIC_URL',
  'FICUS_LOCAL_APP_URL',
  'NODE_ENV',
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

beforeEach(() => {
  for (const k of KEYS) delete process.env[k]
  process.env.NODE_ENV = 'production'
  // A public address (env here; the setting resolves the same way) plus the launcher's local address.
  process.env.APP_URL = 'https://pub.example.com/ficus'
  process.env.FICUS_LOCAL_APP_URL = 'http://localhost:61896'
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('rpConfigFor', () => {
  test('a ceremony from the local address verifies against localhost', () => {
    expect(rpConfigFor('http://localhost:61896')).toMatchObject({ origin: 'http://localhost:61896', rpId: 'localhost' })
  })

  test('a ceremony from the public address verifies against the public host', () => {
    expect(rpConfigFor('https://pub.example.com')).toMatchObject({
      origin: 'https://pub.example.com',
      rpId: 'pub.example.com',
    })
  })

  test('an unknown or missing Origin falls back to the primary origin', () => {
    for (const origin of ['https://evil.example', 'null', undefined, null]) {
      expect(rpConfigFor(origin)).toMatchObject({ origin: 'https://pub.example.com', rpId: 'pub.example.com' })
    }
  })

  test('WEBAUTHN_RP_ID is honored only when it covers the chosen host', () => {
    process.env.WEBAUTHN_RP_ID = 'example.com'
    expect(rpConfigFor('https://pub.example.com').rpId).toBe('example.com')
    expect(rpConfigFor('http://localhost:61896').rpId).toBe('localhost')
    process.env.WEBAUTHN_RP_ID = 'pub.example.com'
    expect(rpConfigFor('https://pub.example.com').rpId).toBe('pub.example.com')
  })
})

describe('step-up ceremonies', () => {
  test('an allowlisted request origin wins', () => {
    expect(rpOriginForStepUp('http://localhost:61896', 'https://old.example.com')).toBe('http://localhost:61896')
  })

  test('a request origin that left the allowlist falls back to the origin recorded on the session', () => {
    expect(rpOriginForStepUp('https://old.example.com', 'https://old.example.com')).toBe('https://old.example.com')
    expect(rpOriginForStepUp(undefined, 'https://old.example.com')).toBe('https://old.example.com')
  })

  test('without a usable session origin the primary origin is used', () => {
    expect(rpOriginForStepUp('https://old.example.com', null)).toBe('https://pub.example.com')
    expect(rpOriginForStepUp('https://old.example.com', 'not an origin')).toBe('https://pub.example.com')
    expect(rpOriginForStepUp('https://old.example.com', 'javascript:alert(1)')).toBe('https://pub.example.com')
  })

  test('rpConfigFor honours the session origin only in step-up mode', () => {
    expect(rpConfigFor('https://old.example.com').origin).toBe('https://pub.example.com')
    expect(
      rpConfigFor('https://old.example.com', { stepUp: { sessionOrigin: 'https://old.example.com' } })
    ).toMatchObject({ origin: 'https://old.example.com', rpId: 'old.example.com' })
  })
})

describe('webAppUrlForOrigin', () => {
  test('appends APP_BASE_PATH when set', () => {
    const saved = process.env.APP_BASE_PATH
    try {
      delete process.env.APP_BASE_PATH
      expect(webAppUrlForOrigin('https://a.example')).toBe('https://a.example')
      process.env.APP_BASE_PATH = '/ficus/'
      expect(webAppUrlForOrigin('https://a.example')).toBe('https://a.example/ficus')
    } finally {
      if (saved === undefined) delete process.env.APP_BASE_PATH
      else process.env.APP_BASE_PATH = saved
    }
  })
})
