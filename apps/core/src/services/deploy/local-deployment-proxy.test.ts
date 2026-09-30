import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { like } from 'drizzle-orm'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import {
  createLocalDeployment,
  stopLocalDeploymentRecord,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { configureLocalDeploymentProxyDependencies, proxyLocalDeploymentRequest } from './local-deployment-proxy'

const LEGACY_TOKEN_QUERY_PARAM = '_tau_token' // ficus-p5-bridge

describe('localDeployment proxy', () => {
  let testPrefix: string
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []

  beforeEach(() => {
    testPrefix = `local-deployment-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    fetchCalls.length = 0
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
      fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: url.toString(), init: init ?? {} })
        return new Response('proxied', { status: 201, headers: { 'content-type': 'text/plain' } })
      }) as unknown as typeof fetch,
    })
  })

  afterEach(async () => {
    configureLocalDeploymentProxyDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  function localDeploymentUrl(localDeployment: { urlPathOrHost: string }, path = '', query = ''): string {
    const url = new URL(`http://ficus.test${localDeployment.urlPathOrHost}`)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    if (query) {
      for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value)
    }
    return url.toString()
  }

  /** The token is not on the DTO; it rides the URL Ficus hands the browser. */
  function browserToken(localDeployment: { urlPathOrHost: string }): string {
    return new URL(`http://ficus.test${localDeployment.urlPathOrHost}`).searchParams.get('_ficus_token') ?? ''
  }

  async function createTestSquad(): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'LocalDeployment proxy test squad' })
      .returning()
    return new Squad(row)
  }

  it('refuses missing localDeployments', async () => {
    const response = await proxyLocalDeploymentRequest(
      '00000000-0000-0000-0000-000000000000',
      new Request('http://ficus.test/api/app/missing/'),
      ''
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('refuses stopped localDeployments', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await stopLocalDeploymentRecord(localDeployment.id)

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`),
      ''
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects missing or invalid browser localDeployment tokens without Ficus auth', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const missing = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`),
      ''
    )
    const invalid = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/?_ficus_token=wrong`),
      ''
    )

    expect(missing.status).toBe(401)
    expect(invalid.status).toBe(401)
    expect(missing.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(invalid.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(fetchCalls).toHaveLength(0)
  })

  it('ensures the squad sandbox and retries target resolution when core has not adopted it yet', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    const ensureCalls: string[] = []
    const targetCalls: string[] = []
    configureLocalDeploymentProxyDependencies({
      ensureSquadSandbox: async (squadOrId) => {
        ensureCalls.push(typeof squadOrId === 'string' ? squadOrId : squadOrId.id)
        return '/workspace'
      },
      resolveLocalDeploymentTarget: async (sandboxId) => {
        targetCalls.push(sandboxId)
        if (targetCalls.length === 1) throw new Error(`Sandbox not found: ${localDeployment.sandboxId}`)
        return { host: '127.0.0.1', port: 5173 }
      },
      fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: url.toString(), init: init ?? {} })
        return new Response('proxied', { status: 201 })
      }) as unknown as typeof fetch,
    })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment)),
      ''
    )

    expect(response.status).toBe(201)
    expect(ensureCalls).toEqual([squad.id])
    expect(targetCalls).toEqual([localDeployment.sandboxId, localDeployment.sandboxId])
  })

  it('forwards method, path, query, and body with a valid browser localDeployment token', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(
        localDeploymentUrl(localDeployment, 'api/items', `filter=all&${LEGACY_TOKEN_QUERY_PARAM}=forwarded-by-bridge`),
        {
          method: 'POST',
          body: 'hello',
          headers: { 'content-type': 'text/plain' },
        }
      ),
      'api/items'
    )

    expect(response.status).toBe(201)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:5173/api/items?filter=all')
    expect(fetchCalls[0].url).not.toContain('_ficus_token')
    // The Platform bridge may forward the credential under its old name too: never to the app.
    expect(fetchCalls[0].url).not.toContain(LEGACY_TOKEN_QUERY_PARAM)
    expect(fetchCalls[0].init.method).toBe('POST')
    expect(await new Response(fetchCalls[0].init.body as BodyInit).text()).toBe('hello')
  })

  it('strips an app-supplied proxy-error marker while preserving the app response', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
      fetch: mock(
        async () =>
          new Response('app-owned error', {
            status: 500,
            headers: { 'x-ficus-app-proxy': 'error', 'content-type': 'text/plain' },
          })
      ) as unknown as typeof fetch,
    })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment, 'status')),
      'status'
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('x-ficus-app-proxy')).toBeNull()
    expect(await response.text()).toBe('app-owned error')
  })

  it('preserves response status and content-type', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const response = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment, 'status')),
      'status'
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('proxied')
  })

  it("sets a path-scoped cookie so the app's own asset requests authenticate", async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment)),
      ''
    )

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`ficus_app_${localDeployment.id}=`)
    // Path scoping is the security boundary — it keeps this credential off
    // Ficus's own API and off every other deployment.
    expect(cookie).toContain(`Path=/api/app/${localDeployment.id}/`)
    expect(cookie).toContain('HttpOnly')
  })

  it('accepts the cookie alone, which is how subresources load at all', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    // No query string: exactly what the browser sends for /assets/index-*.js.
    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/assets/index-abc.js`, {
        headers: { cookie: `ficus_app_${localDeployment.id}=${browserToken(localDeployment)}` },
      }),
      'assets/index-abc.js'
    )

    expect(res.status).toBe(201)
    expect(fetchCalls[0].url).toContain('/assets/index-abc.js')
    // Nothing to re-mint: the request already carried the credential.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('still refuses a wrong cookie value', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })

    const res = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/assets/x.js`, {
        headers: { cookie: `ficus_app_${localDeployment.id}=nope` },
      }),
      'assets/x.js'
    )

    expect(res.status).toBe(401)
  })

  it('does not forward Ficus auth credentials', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    await proxyLocalDeploymentRequest(
      localDeployment.id,
      // Use the valid signed URL (carries _ficus_token) so the request authenticates,
      // then assert the Ficus auth credentials are not forwarded upstream.
      new Request(localDeploymentUrl(localDeployment), {
        headers: {
          authorization: 'Bearer ficus-token',
          'x-auth-token': 'ficus-token',
          cookie: 'ficus_password=secret; other=value',
          'x-keep': 'yes',
        },
      }),
      ''
    )

    const headers = fetchCalls[0].init.headers as Headers
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-auth-token')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.get('x-keep')).toBe('yes')
  })

  it('requires a valid browser token even when Ficus auth credentials are present', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    // Ficus auth header but NO _ficus_token: previously a Ficus auth header
    // short-circuited the token check and proxied (201). Must now be 401.
    const noToken = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/`, {
        headers: { authorization: 'Bearer ficus-session' },
      }),
      ''
    )
    expect(noToken.status).toBe(401)

    // Wrong token, also rejected — never reaches the upstream fetch.
    const wrongToken = await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(`http://ficus.test/api/app/${localDeployment.id}/?_ficus_token=wrong`, {
        headers: { authorization: 'Bearer ficus-session' },
      }),
      ''
    )
    expect(wrongToken.status).toBe(401)
    expect(fetchCalls).toHaveLength(0)
  })

  it('does not forward hop-by-hop headers', async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    await proxyLocalDeploymentRequest(
      localDeployment.id,
      new Request(localDeploymentUrl(localDeployment), {
        headers: { connection: 'keep-alive, x-hop', upgrade: 'websocket', 'x-hop': 'remove-me', 'x-keep': 'yes' },
      }),
      ''
    )

    const headers = fetchCalls[0].init.headers as Headers
    expect(headers.has('connection')).toBe(false)
    expect(headers.has('upgrade')).toBe(false)
    expect(headers.has('keep-alive')).toBe(false)
    expect(headers.has('x-hop')).toBe(false)
    expect(headers.get('x-keep')).toBe('yes')
  })
})
