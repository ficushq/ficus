import { expect, test } from 'bun:test'
import { computePublicAppUrlChangeImpact } from './impact'

test('a base-path-only change keeps the origin but needs a reconnect and warns about the build base path', () => {
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '')).toMatchObject({
    originChanged: false,
    relayReconnectRequired: true,
    mobileReady: true,
    basePathMismatch: true,
  })
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '/ficus/')).toMatchObject({
    basePathMismatch: false,
  })
})

test('unchanged and cleared addresses', () => {
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example', '')).toMatchObject({
    originChanged: false,
    relayReconnectRequired: false,
  })
  const cleared = computePublicAppUrlChangeImpact('https://a.example', undefined, '')
  expect(cleared).toMatchObject({ originChanged: true, relayReconnectRequired: true, mobileReady: false, basePathMismatch: false })
  expect(cleared.webhooks[0]).toEqual({ label: 'GitHub webhook', before: 'https://a.example/api/webhooks/github', after: null })
})

test('http addresses are not mobile-ready', () => {
  expect(computePublicAppUrlChangeImpact(undefined, 'http://192.0.2.1:3000', '').mobileReady).toBe(false)
})
