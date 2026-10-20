import { expect, test } from 'bun:test'
import { describePublicAppUrl, isLoopbackHostname, normalizePublicAppUrl, resolvePublicAppUrl } from './public-app-url'
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
  expect(resolvePublicAppUrl({ FICUS_API_URL: 'http://127.0.0.1:3000' }, undefined)).toBeUndefined()
  for (const APP_URL of [
    'ftp://example.com',
    'https://user:password@example.com',
    'https://example.com/ficus?token=secret',
    'https://example.com/#fragment',
    'invalid',
  ]) {
    expect(resolvePublicAppUrl({ APP_URL, PUBLIC_URL: 'https://legacy.example' })).toBeUndefined()
    expect(resolvePublicAppUrl({ APP_URL }, 'https://stored.example')).toBeUndefined()
  }
})

test('rejects unsafe shapes and bounds length', () => {
  for (const bad of [
    'https://ex.com/a\\b',
    'https://ex.com/a%00b',
    'https://ex.com/a%2Fb',
    'https://ex.com/a%zzb',
    'https://ex.com//x',
    'https://',
    'https://ex.com/?',
    'https://ex.com/#',
    `https://ex.com/${'a'.repeat(2048)}`,
    'https://ex.com/\u0007',
    'https://ex.com/a\nb',
    'javascript:alert(1)',
    '',
    undefined,
  ]) {
    expect(normalizePublicAppUrl(bad)).toBeUndefined()
  }
  expect(normalizePublicAppUrl(' https://Ex.com:8443/a%20b/ ')).toBe('https://ex.com:8443/a%20b')
  expect(normalizePublicAppUrl('http://localhost:61896')).toBe('http://localhost:61896')
})

test('layers environment over setting over local default', () => {
  expect(describePublicAppUrl({ APP_URL: 'https://env.example' }, 'https://set.example')).toMatchObject({
    url: 'https://env.example',
    source: 'environment',
    locked: true,
    lockedBy: 'environment',
    storedUrl: 'https://set.example',
  })
  expect(describePublicAppUrl({ PUBLIC_URL: 'https://legacy.example' }, 'https://set.example')).toMatchObject({
    url: 'https://legacy.example',
    source: 'environment',
    locked: true,
  })
  expect(
    describePublicAppUrl({ FICUS_LOCAL_APP_URL: 'http://localhost:61896' }, 'https://set.example/ficus/')
  ).toMatchObject({ url: 'https://set.example/ficus', source: 'setting', locked: false, localUrl: 'http://localhost:61896' })
  expect(describePublicAppUrl({ FICUS_LOCAL_APP_URL: 'http://localhost:61896' }, undefined)).toMatchObject({
    url: 'http://localhost:61896',
    source: 'local-default',
    locked: false,
  })
  expect(describePublicAppUrl({}, undefined)).toMatchObject({ url: undefined, source: 'none', locked: false })
  // A corrupt stored value is ignored rather than trusted.
  expect(describePublicAppUrl({ FICUS_LOCAL_APP_URL: 'http://localhost:1' }, 'ftp://x')).toMatchObject({
    url: 'http://localhost:1',
    source: 'local-default',
  })
})

test('invalid environment value stays authoritative and FICUS_MANAGED locks', () => {
  expect(describePublicAppUrl({ APP_URL: 'nope' }, 'https://set.example')).toMatchObject({
    url: undefined,
    source: 'environment',
    environmentInvalid: true,
  })
  expect(describePublicAppUrl({ FICUS_MANAGED: '1' }, 'https://set.example')).toMatchObject({
    url: 'https://set.example',
    locked: true,
    lockedBy: 'managed',
  })
  expect(describePublicAppUrl({ FICUS_MANAGED: '1', APP_URL: 'https://cloud.example' }, undefined)).toMatchObject({
    locked: true,
    lockedBy: 'managed',
  })
  expect(describePublicAppUrl({ FICUS_DESKTOP_MANAGED: '1', APP_URL: 'http://localhost:1' }, undefined)).toMatchObject(
    { desktopManaged: true, lockedBy: 'environment' }
  )
})

test('recognizes loopback hostnames', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) expect(isLoopbackHostname(host)).toBe(true)
  for (const host of ['example.com', '10.0.0.1', 'localhost.example.com']) expect(isLoopbackHostname(host)).toBe(false)
})
