import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rpConfigFor } from './webauthn'

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
