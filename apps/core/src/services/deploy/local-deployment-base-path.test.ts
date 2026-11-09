import { describe, expect, test } from 'bun:test'
import type { LocalDeployment } from '@ficus/shared'
import { attachPeerAddress, getClientAddress, isTrustedProxyPeer } from '../../lib/client-address'
import {
  decideLocalAppBase,
  LOCAL_APP_BASE_REDIRECT_PARAM,
  parseLocalAppsBaseMarker,
  reconcileLocalAppBasePath,
  withoutRedirectMarker,
  type ReconcileLocalAppBasePathDependencies,
} from './local-deployment-base-path'

const ID = '11111111-2222-4333-8444-555555555555'

function appRequest(url: string, headers: Record<string, string> = {}) {
  const path = new URL(url).pathname.replace(/^\/ficus(?=\/)/, '')
  return { url, path, header: (name: string) => headers[name.toLowerCase()] }
}

describe('decideLocalAppBase', () => {
  const opts = { hostedAppsDomain: false, publicBase: '/ficus' }

  test('redirects a request under another base to the public base once, keeping the token', () => {
    const decision = decideLocalAppBase(
      appRequest(`http://localhost:3000/api/app/${ID}/x?_ficus_token=t`, { host: 'localhost:3000' }),
      { ...opts, requestBase: '' }
    )
    expect(decision).toEqual({
      kind: 'redirect',
      location: `/ficus/api/app/${ID}/x?_ficus_token=t&${LOCAL_APP_BASE_REDIRECT_PARAM}=1`,
    })
  })

  test('serves a request already under the public base', () => {
    expect(
      decideLocalAppBase(appRequest(`http://localhost:3000/ficus/api/app/${ID}/x`), { ...opts, requestBase: '/ficus' })
    ).toEqual({ kind: 'proxy', stripMarker: false, afterRedirect: false })
  })

  test('a second pass never redirects: a proxy that hides the prefix gets the app served in place', () => {
    // The strip proxy rewrote Host and sent no X-Forwarded-Host, so the redirected
    // request still resolves to the root base.
    const first = decideLocalAppBase(appRequest(`http://127.0.0.1:3000/api/app/${ID}/?_ficus_token=t`), {
      ...opts,
      requestBase: '',
    })
    expect(first.kind).toBe('redirect')
    const location = (first as { location: string }).location
    const second = decideLocalAppBase(appRequest(`http://127.0.0.1:3000${location.replace(/^\/ficus/, '')}`), {
      ...opts,
      requestBase: '',
    })
    expect(second).toEqual({ kind: 'proxy', stripMarker: true, afterRedirect: true })
  })

  test('refuses a WebSocket upgrade under another base', () => {
    expect(
      decideLocalAppBase(appRequest(`http://localhost:3000/api/app/${ID}/ws`, { upgrade: 'websocket' }), {
        ...opts,
        requestBase: '',
      })
    ).toEqual({ kind: 'reject-upgrade' })
  })

  test('serves in place for hosted apps, a root base and a base Core never strips', () => {
    const req = appRequest(`http://localhost:3000/api/app/${ID}/`)
    const proxy = { kind: 'proxy', stripMarker: false, afterRedirect: false }
    expect(decideLocalAppBase(req, { ...opts, hostedAppsDomain: true, requestBase: '' })).toEqual(proxy)
    expect(decideLocalAppBase(req, { hostedAppsDomain: false, publicBase: '', requestBase: '' })).toEqual(proxy)
    expect(decideLocalAppBase(req, { hostedAppsDomain: false, publicBase: '/settings', requestBase: '' })).toEqual(
      proxy
    )
  })

  test('the marker is removed before the request reaches the app, keeping the socket peer', () => {
    const original = new Request(`http://h/api/app/${ID}/?_ficus_token=t&${LOCAL_APP_BASE_REDIRECT_PARAM}=1`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    attachPeerAddress(original, '127.0.0.1')
    const stripped = withoutRedirectMarker(original)
    expect(new URL(stripped.url).search).toBe('?_ficus_token=t')
    // A loopback peer is a trusted proxy: its X-Forwarded-For and X-Forwarded-Host stay believable.
    expect(isTrustedProxyPeer(stripped)).toBe(true)
    expect(getClientAddress(stripped)).toBe('203.0.113.7')
  })
})

function deployment(id: string, mode: LocalDeployment['mode'] = 'managed'): LocalDeployment {
  return { id, mode } as LocalDeployment
}

function harness(opts: {
  basePath: string
  marker?: string
  live: LocalDeployment[]
  failing?: Set<string>
  hosted?: boolean
}) {
  const restarts: string[] = []
  const state = { marker: opts.marker }
  const deps: ReconcileLocalAppBasePathDependencies = {
    publicBasePath: () => opts.basePath,
    hostedAppsDomain: () => opts.hosted ?? false,
    listLive: async () => opts.live,
    restart: async (id) => {
      restarts.push(id)
      if (opts.failing?.has(id)) throw new Error('box unavailable')
    },
    readMarker: () => state.marker,
    writeMarker: async (value) => {
      state.marker = value
    },
  }
  return { deps, restarts, state }
}

describe('reconcileLocalAppBasePath', () => {
  test('a missing marker is the root base: a root instance restarts nothing after upgrading', async () => {
    const h = harness({ basePath: '', live: [deployment('a'), deployment('b')] })
    expect(await reconcileLocalAppBasePath(h.deps)).toEqual({ basePath: '', restarted: [], failed: [] })
    expect(h.restarts).toEqual([])
  })

  test('a missing marker on a non-root instance restarts the managed apps once', async () => {
    const h = harness({ basePath: '/ficus', live: [deployment('a'), deployment('x', 'attached'), deployment('b')] })
    expect((await reconcileLocalAppBasePath(h.deps)).restarted).toEqual(['a', 'b'])
    expect(parseLocalAppsBaseMarker(h.state.marker)).toEqual({ basePath: '/ficus', failed: [] })
    await reconcileLocalAppBasePath(h.deps)
    expect(h.restarts).toEqual(['a', 'b'])
  })

  test('a base change restarts managed apps; hosted apps are left alone', async () => {
    const changed = harness({
      basePath: '',
      marker: JSON.stringify({ basePath: '/ficus', failed: [] }),
      live: [deployment('a')],
    })
    expect((await reconcileLocalAppBasePath(changed.deps)).restarted).toEqual(['a'])
    const hosted = harness({ basePath: '/ficus', live: [deployment('a')], hosted: true })
    expect((await reconcileLocalAppBasePath(hosted.deps)).restarted).toEqual([])
    expect(parseLocalAppsBaseMarker(hosted.state.marker).basePath).toBe('/ficus')
  })

  test('a failed restart is retried on the next reconcile; successful ones are not restarted again', async () => {
    const failing = new Set(['b'])
    const h = harness({ basePath: '/ficus', live: [deployment('a'), deployment('b'), deployment('c')], failing })
    const first = await reconcileLocalAppBasePath(h.deps)
    expect(first).toEqual({ basePath: '/ficus', restarted: ['a', 'c'], failed: ['b'] })
    expect(parseLocalAppsBaseMarker(h.state.marker)).toEqual({ basePath: '/ficus', failed: ['b'] })

    // Still failing: only b is tried again.
    await reconcileLocalAppBasePath(h.deps)
    expect(h.restarts).toEqual(['a', 'b', 'c', 'b'])

    failing.clear()
    expect(await reconcileLocalAppBasePath(h.deps)).toEqual({ basePath: '/ficus', restarted: ['b'], failed: [] })
    await reconcileLocalAppBasePath(h.deps)
    expect(h.restarts).toEqual(['a', 'b', 'c', 'b', 'b'])
  })

  test('a failed app that is no longer live is dropped from the retry list', async () => {
    const h = harness({
      basePath: '/ficus',
      marker: JSON.stringify({ basePath: '/ficus', failed: ['gone'] }),
      live: [deployment('a')],
    })
    expect((await reconcileLocalAppBasePath(h.deps)).restarted).toEqual([])
    expect(parseLocalAppsBaseMarker(h.state.marker)).toEqual({ basePath: '/ficus', failed: [] })
  })

  test('an unreadable marker counts as the root base', () => {
    expect(parseLocalAppsBaseMarker('not json')).toEqual({ basePath: '', failed: [] })
    expect(parseLocalAppsBaseMarker(undefined)).toEqual({ basePath: '', failed: [] })
  })
})
