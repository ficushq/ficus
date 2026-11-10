import { expect, test } from 'bun:test'
import { computePublicAppUrlChangeImpact } from './impact'

test('a base-path-only change keeps the origin, needs a reconnect and reports the new path', () => {
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '')).toMatchObject({
    originChanged: false,
    relayReconnectRequired: true,
    mobileReady: true,
    basePath: '/ficus',
    basePathChanged: true,
    basePathStrippable: true,
  })
  // A legacy APP_BASE_PATH deployment adding the same path to its address changes nothing.
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '/ficus/')).toMatchObject({
    basePath: '/ficus',
    basePathChanged: false,
  })
})

test('a path that is also a Ficus route is reported as not strippable', () => {
  for (const path of ['/settings', '/api', '/squads/x']) {
    expect(computePublicAppUrlChangeImpact(undefined, `https://a.example${path}`, '')).toMatchObject({
      basePath: path,
      basePathStrippable: false,
    })
  }
  expect(computePublicAppUrlChangeImpact(undefined, 'https://a.example', '').basePathStrippable).toBe(true)
})

test('running local apps are counted only when the base path changes', () => {
  const apps = { managed: 2, external: 1 }
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '', apps)).toMatchObject({
    localAppsAffected: 2,
    externalAppsAffected: 1,
  })
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://b.example', '', apps)).toMatchObject({
    basePathChanged: false,
    localAppsAffected: 0,
    externalAppsAffected: 0,
  })
})

test('unchanged and cleared addresses', () => {
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example', '')).toMatchObject({
    originChanged: false,
    relayReconnectRequired: false,
    basePathChanged: false,
  })
  const cleared = computePublicAppUrlChangeImpact('https://a.example/ficus', undefined, '')
  expect(cleared).toMatchObject({
    originChanged: true,
    relayReconnectRequired: true,
    mobileReady: false,
    basePath: '',
    basePathChanged: true,
  })
  expect(cleared.webhooks[0]).toEqual({
    label: 'GitHub webhook',
    before: 'https://a.example/ficus/api/webhooks/github',
    after: null,
  })
})

test('http addresses are not mobile-ready', () => {
  expect(computePublicAppUrlChangeImpact(undefined, 'http://192.0.2.1:3000', '').mobileReady).toBe(false)
})

test('a path that cannot be used for squad apps is reported, and their base does not change', () => {
  const apps = { managed: 2, external: 1 }
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/a;b', '', apps)).toMatchObject({
    basePath: '/a;b',
    basePathChanged: true,
    localAppsUnderBasePath: false,
    localAppsAffected: 0,
    externalAppsAffected: 0,
  })
  expect(computePublicAppUrlChangeImpact('https://a.example', 'https://a.example/ficus', '', apps)).toMatchObject({
    localAppsUnderBasePath: true,
    localAppsAffected: 2,
  })
})
