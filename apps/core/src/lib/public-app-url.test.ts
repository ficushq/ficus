import { expect, test } from 'bun:test'
import { resolvePublicAppUrl } from './public-app-url'
import { relayConnectionSecretKey } from '../services/push/relay'

test('uses the existing APP_URL, preserving reverse-proxy base path and ports', () => {
  expect(resolvePublicAppUrl({ APP_URL: 'https://Home.Example.com:8443/ficus/' })).toBe(
    'https://home.example.com:8443/ficus'
  )
  expect(resolvePublicAppUrl({ APP_URL: 'https://192.0.2.1:8443/ficus' })).toBe('https://192.0.2.1:8443/ficus')
})
test('keeps PUBLIC_URL compatibility but gives APP_URL authority', () => {
  expect(resolvePublicAppUrl({ PUBLIC_URL: 'https://legacy.example/ficus/' })).toBe('https://legacy.example/ficus')
  expect(resolvePublicAppUrl({ APP_URL: 'https://current.example/ficus', PUBLIC_URL: 'https://legacy.example' })).toBe(
    'https://current.example/ficus'
  )
  expect(relayConnectionSecretKey({ PUBLIC_URL: 'https://example.com/ficus' })).toBe(
    relayConnectionSecretKey({ APP_URL: 'https://example.com/ficus/' })
  )
})
test('never substitutes internal API address or silently falls back from an invalid configured app URL', () => {
  expect(resolvePublicAppUrl({ FICUS_API_URL: 'http://127.0.0.1:3000' })).toBeUndefined()
  for (const APP_URL of [
    'ftp://example.com',
    'https://user:password@example.com',
    'https://example.com/ficus?token=secret',
    'https://example.com/#fragment',
    'invalid',
  ]) {
    expect(resolvePublicAppUrl({ APP_URL, PUBLIC_URL: 'https://legacy.example' })).toBeUndefined()
  }
})
