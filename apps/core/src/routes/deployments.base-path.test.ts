/**
 * Route-level proof that a path-mounted local app is served under the public
 * base path on every listener: a request through the local root is redirected
 * there once, and a request already under it (prefix forwarded, or host-matched
 * behind a stripping proxy) reaches the proxy.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { coreGetPath } from '../lib/app-base-path'
import { configureDeploymentsRouteDependencies, deploymentsRouter } from './deployments'

const ID = '11111111-2222-4333-8444-555555555555'
const ENV_KEYS = ['APP_URL', 'PUBLIC_URL', 'FICUS_LOCAL_APP_URL', 'APP_BASE_PATH', 'FICUS_APPS_DOMAIN'] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

const proxied: Request[] = []
const app = new Hono<{ Variables: { resolvedLocalDeploymentId: string } }>({ getPath: coreGetPath })
// Stands in for identityMiddleware, which authenticates the app token first.
app.use('*', async (c, next) => {
  c.set('resolvedLocalDeploymentId', ID)
  await next()
})
app.route('/api', deploymentsRouter)

beforeAll(() => {
  configureDeploymentsRouteDependencies({
    proxyLocalDeploymentRequest: async (_id, request) => {
      proxied.push(request)
      return new Response('app')
    },
  })
})
afterAll(() => configureDeploymentsRouteDependencies())

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.APP_URL = 'http://localhost:8080/ficus'
  process.env.FICUS_LOCAL_APP_URL = 'http://localhost:3000'
  proxied.length = 0
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('local app requests and the public base path', () => {
  it('redirects the local root to the public base on the same host', async () => {
    const res = await app.request(`http://localhost:3000/api/app/${ID}/x?_ficus_token=t`, {
      headers: { host: 'localhost:3000', 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`/ficus/api/app/${ID}/x?_ficus_token=t&_ficus_base_redirect=1`)
    expect(proxied).toHaveLength(0)
  })

  it('serves a POST and an API call at the local root in place instead of redirecting them', async () => {
    const post = await app.request(`http://localhost:3000/api/app/${ID}/api/items?_ficus_token=t`, {
      method: 'POST',
      headers: { host: 'localhost:3000', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(post.status).toBe(200)
    const json = await app.request(`http://localhost:3000/api/app/${ID}/api/items?_ficus_token=t`, {
      headers: { host: 'localhost:3000', accept: 'application/json' },
    })
    expect(json.status).toBe(200)
    expect(proxied.map((r) => r.method)).toEqual(['POST', 'GET'])
  })

  it('proxies a request under the public base, by path or by host', async () => {
    const byPath = await app.request(`http://localhost:3000/ficus/api/app/${ID}/x?_ficus_token=t`, {
      headers: { host: 'localhost:3000' },
    })
    expect(await byPath.text()).toBe('app')
    const byHost = await app.request(`http://127.0.0.1:3000/api/app/${ID}/x`, { headers: { host: 'localhost:8080' } })
    expect(await byHost.text()).toBe('app')
    expect(proxied).toHaveLength(2)
  })

  it('does not redirect a second time when the proxy hides the prefix', async () => {
    const res = await app.request(`http://127.0.0.1:3000/api/app/${ID}/x?_ficus_token=t&_ficus_base_redirect=1`, {
      headers: { host: '127.0.0.1:3000' },
    })
    expect(res.status).toBe(200)
    expect(new URL(proxied[0].url).search).toBe('?_ficus_token=t')
  })

  it('refuses a WebSocket upgrade outside the public base', async () => {
    const res = await app.request(`http://localhost:3000/api/app/${ID}/ws`, {
      headers: { host: 'localhost:3000', upgrade: 'websocket' },
    })
    expect(res.status).toBe(404)
    expect(proxied).toHaveLength(0)
  })

  it('serves in place at the root base', async () => {
    process.env.APP_URL = 'http://localhost:8080'
    const res = await app.request(`http://localhost:3000/api/app/${ID}/x`, {
      headers: { host: 'localhost:3000', 'sec-fetch-mode': 'navigate' },
    })
    expect(res.status).toBe(200)
  })
})
