import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { like } from 'drizzle-orm'
import { brotliCompressSync, brotliDecompressSync, deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { Hono } from 'hono'
import { attachPeerAddress } from '../../lib/client-address'
import { identityMiddleware } from '../../middleware/identity'
import { deploymentsRouter } from '../../routes/deployments'
import {
  createLocalDeployment,
  stopLocalDeploymentRecord,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import {
  configureLocalDeploymentProxyDependencies,
  keepOutOfSharedCaches,
  proxyLocalDeploymentRequest,
} from './local-deployment-proxy'

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

  it("keeps an app's immutable assets out of the CDN, still cacheable in the browser", async () => {
    const squad = await createTestSquad()
    const localDeployment = await createLocalDeployment(squad, { name: 'web', mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
      fetch: mock(
        async () =>
          new Response('chunk', {
            status: 200,
            headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
          })
      ) as unknown as typeof fetch,
    })

    // Both ways in: the shared URL (which mints the cookie) and the cookie alone (every asset after it).
    for (const request of [
      new Request(localDeploymentUrl(localDeployment, '_next/static/chunks/app.js')),
      new Request(`http://ficus.test/api/app/${localDeployment.id}/_next/static/chunks/app.js`, {
        headers: { cookie: `ficus_app_${localDeployment.id}=${browserToken(localDeployment)}` },
      }),
    ]) {
      const res = await proxyLocalDeploymentRequest(localDeployment.id, request, '_next/static/chunks/app.js')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(res.headers.get('cdn-cache-control')).toBe('no-store')
      expect(await res.text()).toBe('chunk')
    }
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

  // A per-app origin (<tenant>--<id>.<apps domain>) is the app's own origin: its
  // cookies go to it and come back, minus Ficus's own, and it sees its own host.
  // The path mount shares the Ficus origin, so no cookie crosses in either direction.
  describe('cookies and host by mount', () => {
    const APPS_DOMAIN = 'ficus.garden'
    const TENANT_ORIGIN = 'https://noah.ficus.sh'
    let previousEnv: { appsDomain?: string; appUrl?: string }

    beforeEach(() => {
      previousEnv = { appsDomain: process.env.FICUS_APPS_DOMAIN, appUrl: process.env.APP_URL }
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
        fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
          fetchCalls.push({ url: url.toString(), init: init ?? {} })
          const headers = new Headers({ 'content-type': 'text/plain' })
          headers.append('set-cookie', '__Secure-better-auth.session_token=s1; Secure; HttpOnly; SameSite=Lax; Path=/')
          headers.append('set-cookie', 'app-plain=p1; Path=/')
          return new Response('proxied', { status: 201, headers })
        }) as unknown as typeof fetch,
      })
    })

    afterEach(() => {
      for (const [name, value] of [
        ['FICUS_APPS_DOMAIN', previousEnv.appsDomain],
        ['APP_URL', previousEnv.appUrl],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })

    function enableHostedApps(): void {
      process.env.FICUS_APPS_DOMAIN = APPS_DOMAIN
      process.env.APP_URL = TENANT_ORIGIN
    }

    function appHost(id: string): string {
      return `noah--${id.replaceAll('-', '').slice(0, 12)}.${APPS_DOMAIN}`
    }

    /**
     * The request Core gets for either mount: the tenant host's /api/app/<id>/
     * route with the credential in the query (the Platform bridge always sends
     * it there), from `peer`.
     */
    async function proxied(input: { headers: Record<string, string>; peer?: string; hosted?: boolean }) {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const token = browserToken(localDeployment)
      if (input.hosted ?? true) enableHostedApps()
      const request = new Request(`${TENANT_ORIGIN}/api/app/${localDeployment.id}/dashboard?_ficus_token=${token}`, {
        headers: { host: 'noah.ficus.sh', 'x-forwarded-proto': 'https', ...input.headers },
      })
      attachPeerAddress(request, input.peer ?? '127.0.0.1')
      const response = await proxyLocalDeploymentRequest(localDeployment.id, request, 'dashboard')
      expect(response.status).toBe(201)
      return { id: localDeployment.id, response, forwarded: fetchCalls[0].init.headers as Headers }
    }

    const FICUS_COOKIES = (id: string) => [
      `ficus_session=session-secret`,
      `tau_session=legacy-session-secret`,
      `ficus_app_${id}=access-secret`,
      `tau_app_${id}=legacy-access-secret`,
      `ficus_app=legacy-app-secret`,
      `__Host-ficus_app=bridge-secret`,
      `__Host-tau_app=legacy-bridge-secret`,
    ]
    // Look-alikes an app may legitimately own: exact-name stripping must keep every one.
    const APP_COOKIES = [
      '__Secure-better-auth.session_token=app-session',
      'chlea-probe-plain=1',
      'ficus_session_theme=dark',
      'my_ficus_app=1',
      '__Host-ficus_app_prefs=2',
    ]

    it('forwards app cookies and strips every Ficus cookie by exact name on the per-app origin', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const id = localDeployment.id
      const token = browserToken(localDeployment)
      enableHostedApps()
      const request = new Request(`${TENANT_ORIGIN}/api/app/${id}/dashboard?_ficus_token=${token}`, {
        headers: {
          host: 'noah.ficus.sh',
          'x-forwarded-host': appHost(id),
          'x-forwarded-proto': 'https',
          cookie: [APP_COOKIES[0], ...FICUS_COOKIES(id), ...APP_COOKIES.slice(1)].join('; '),
        },
      })
      attachPeerAddress(request, '127.0.0.1')

      const response = await proxyLocalDeploymentRequest(id, request, 'dashboard')

      expect(response.status).toBe(201)
      const forwarded = fetchCalls[0].init.headers as Headers
      expect(forwarded.get('cookie')).toBe(APP_COOKIES.join('; '))
      expect(forwarded.get('cookie')).not.toContain('secret')
      expect(forwarded.get('host')).toBe(appHost(id))
      expect(forwarded.get('x-forwarded-host')).toBe(appHost(id))
      expect(forwarded.get('x-forwarded-proto')).toBe('https')
      expect(fetchCalls[0].url).toBe('http://127.0.0.1:5173/dashboard')
      // The app's cookies reach the browser unchanged; Core mints none of its own there.
      expect(response.headers.getSetCookie()).toEqual([
        '__Secure-better-auth.session_token=s1; Secure; HttpOnly; SameSite=Lax; Path=/',
        'app-plain=p1; Path=/',
      ])
    })

    it('sends no Cookie at all when the browser held only Ficus cookies', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const id = localDeployment.id
      enableHostedApps()
      const request = new Request(`${TENANT_ORIGIN}/api/app/${id}/?_ficus_token=${browserToken(localDeployment)}`, {
        headers: { 'x-forwarded-host': appHost(id).toUpperCase(), cookie: FICUS_COOKIES(id).join('; ') },
      })
      attachPeerAddress(request, '127.0.0.1')

      await proxyLocalDeploymentRequest(id, request, '')

      const forwarded = fetchCalls[0].init.headers as Headers
      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe(appHost(id))
    })

    it("makes the app's cookies host-only and drops ones under a Ficus name on the per-app origin", async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const id = localDeployment.id
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: 5173 }),
        fetch: mock(async () => {
          const headers = new Headers()
          // Domain=<apps domain> would reach every app of every tenant: it is not a public suffix.
          headers.append(
            'set-cookie',
            '__Secure-better-auth.session_token=fixed; Domain=ficus.garden; Path=/api; Secure'
          )
          headers.append('set-cookie', 'b=2; Path=/; domain=.FICUS.garden; HttpOnly')
          headers.append('set-cookie', `c=3;  DOMAIN = ${appHost(id)} ;SameSite=Lax`)
          headers.append('set-cookie', 'ficus_session=planted; Path=/')
          headers.append('set-cookie', '__Host-ficus_app=planted; Path=/; Secure')
          headers.append('set-cookie', `ficus_app_${id}=planted; Path=/`)
          headers.append('set-cookie', 'ficus_session_theme=dark; Path=/')
          headers.append('set-cookie', 'domain_hint=ficus.garden; Path=/')
          return new Response('ok', { headers })
        }) as unknown as typeof fetch,
      })
      enableHostedApps()
      const request = new Request(`${TENANT_ORIGIN}/api/app/${id}/?_ficus_token=${browserToken(localDeployment)}`, {
        headers: { host: 'noah.ficus.sh', 'x-forwarded-host': appHost(id) },
      })
      attachPeerAddress(request, '127.0.0.1')

      const response = await proxyLocalDeploymentRequest(id, request, '')

      expect(response.headers.getSetCookie()).toEqual([
        '__Secure-better-auth.session_token=fixed; Path=/api; Secure',
        'b=2; Path=/; HttpOnly',
        'c=3;SameSite=Lax',
        'ficus_session_theme=dark; Path=/',
        'domain_hint=ficus.garden; Path=/',
      ])
    })

    it('treats the path mount as the shared Ficus origin: no cookie either way, the Ficus host', async () => {
      const { id, response, forwarded } = await proxied({
        headers: { cookie: 'ficus_session=session-secret; app-plain=p1', 'x-forwarded-host': 'noah.ficus.sh' },
      })

      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe('noah.ficus.sh')
      expect(forwarded.get('x-forwarded-host')).toBe('noah.ficus.sh')
      // Only Core's own path-scoped access cookie: the app cannot set a cookie on the Ficus origin.
      const cookies = response.headers.getSetCookie()
      expect(cookies).toHaveLength(1)
      expect(cookies[0]).toStartWith(`ficus_app_${id}=`)
      expect(cookies[0]).toContain(`Path=/api/app/${id}/`)
    })

    it('opens no per-app origin for any other host the trusted proxy names', async () => {
      const { forwarded, response } = await proxied({
        headers: { cookie: 'ficus_session=session-secret; app-plain=p1', 'x-forwarded-host': 'ficus.example.com' },
      })

      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe('noah.ficus.sh')
      // The same-host proxy's own X-Forwarded-Host (a self-host's nginx sends its public host) is kept.
      expect(forwarded.get('x-forwarded-host')).toBe('ficus.example.com')
      expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('app-plain='))).toBe(false)
    })

    it("replaces an untrusted peer's X-Forwarded-Host with the request's own Host on the path mount", async () => {
      const { forwarded } = await proxied({ peer: '203.0.113.20', headers: { 'x-forwarded-host': 'evil.example' } })

      expect(forwarded.get('x-forwarded-host')).toBe('noah.ficus.sh')
    })

    it("ignores another deployment's app host", async () => {
      const { forwarded } = await proxied({
        headers: { cookie: 'app-plain=p1', 'x-forwarded-host': appHost('00000000-0000-0000-0000-000000000000') },
      })

      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe('noah.ficus.sh')
    })

    it('ignores the right app host from a peer that is not a trusted proxy', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const id = localDeployment.id
      enableHostedApps()
      const request = new Request(`${TENANT_ORIGIN}/api/app/${id}/?_ficus_token=${browserToken(localDeployment)}`, {
        headers: { host: 'noah.ficus.sh', 'x-forwarded-host': appHost(id), cookie: 'app-plain=p1' },
      })
      attachPeerAddress(request, '203.0.113.20')

      await proxyLocalDeploymentRequest(id, request, '')

      const forwarded = fetchCalls[0].init.headers as Headers
      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe('noah.ficus.sh')
      expect(forwarded.get('x-forwarded-host')).toBe('noah.ficus.sh')
    })

    it('has no per-app origin to honor when hosted app URLs are off', async () => {
      const { forwarded } = await proxied({
        hosted: false,
        headers: { cookie: 'app-plain=p1', 'x-forwarded-host': 'noah--000000000000.ficus.garden' },
      })

      expect(forwarded.has('cookie')).toBe(false)
      expect(forwarded.get('host')).toBe('noah.ficus.sh')
    })

    it('round-trips app cookies and the app host over real sockets', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const id = localDeployment.id
      const seen: Array<Record<string, string | null>> = []
      const app = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          seen.push(Object.fromEntries(['host', 'x-forwarded-host', 'cookie'].map((h) => [h, req.headers.get(h)])))
          const headers = new Headers()
          headers.append('set-cookie', '__Secure-chlea-probe=1; Secure; HttpOnly; SameSite=Lax; Path=/')
          headers.append('set-cookie', 'chlea-probe-plain=1; Path=/')
          return new Response('ok', { headers })
        },
      })
      // Core's own chain for this route: identity first, then the proxy.
      const routes = new Hono()
      routes.use('*', identityMiddleware)
      routes.all('/api/app/:id/*', (c) => proxyLocalDeploymentRequest(id, c.req.raw, 'probe'))
      const core = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req, server) {
          attachPeerAddress(req, server.requestIP(req)?.address)
          return routes.fetch(req)
        },
      })
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.port! }),
      })
      enableHostedApps()
      try {
        const response = await fetch(
          `http://127.0.0.1:${core.port}/api/app/${id}/probe?_ficus_token=${browserToken(localDeployment)}`,
          {
            headers: {
              host: 'noah.ficus.sh',
              'x-forwarded-host': appHost(id),
              // A ficus_session on the app origin (the app's own, or planted on the
              // apps domain) is not a Ficus login: no 401, and it never reaches the app.
              cookie: `ficus_session=garbage; __Host-ficus_app=bridge-secret; __Secure-chlea-probe=1; chlea-probe-plain=1`,
            },
          }
        )
        await response.arrayBuffer()

        expect(response.status).toBe(200)
        expect(response.headers.getSetCookie()).toEqual([
          '__Secure-chlea-probe=1; Secure; HttpOnly; SameSite=Lax; Path=/',
          'chlea-probe-plain=1; Path=/',
        ])
        expect(seen).toEqual([
          { host: appHost(id), 'x-forwarded-host': appHost(id), cookie: '__Secure-chlea-probe=1; chlea-probe-plain=1' },
        ])
      } finally {
        core.stop(true)
        app.stop(true)
      }
    })
  })

  // What the app may rely on: exactly one X-Forwarded-For, the address Core
  // resolved (an incoming X-Forwarded-For counts only from the same-host
  // reverse proxy), and no other client-address header, forged or not.
  describe('client address headers', () => {
    const FORGED = '6.6.6.6'
    const forgedHeaders = {
      'cf-connecting-ip': FORGED,
      'cf-connecting-ipv6': '2001:db8::666',
      'cf-pseudo-ipv4': FORGED,
      'true-client-ip': FORGED,
      'x-real-ip': FORGED,
      'x-client-ip': FORGED,
      'x-cluster-client-ip': FORGED,
      'fastly-client-ip': FORGED,
      'x-original-forwarded-for': FORGED,
      'x-envoy-external-address': FORGED,
      forwarded: `for=${FORGED};proto=https`,
    }
    const dropped = Object.keys(forgedHeaders)

    async function forwardedHeaders(
      init: { url?: (deployment: { urlPathOrHost: string }) => string; headers: Record<string, string> },
      peerAddress: string | undefined
    ): Promise<Headers> {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const request = new Request((init.url ?? localDeploymentUrl)(localDeployment), { headers: init.headers })
      attachPeerAddress(request, peerAddress)
      const response = await proxyLocalDeploymentRequest(localDeployment.id, request, '')
      expect(response.status).toBe(201)
      return fetchCalls[0].init.headers as Headers
    }

    it('forwards the address the same-host proxy vouched for and drops every forged header', async () => {
      // noah.ficus.sh/api/app/<id>/: Caddy (loopback peer) sets X-Forwarded-For to the visitor.
      const headers = await forwardedHeaders(
        { headers: { ...forgedHeaders, 'x-forwarded-for': '198.51.100.7', 'x-keep': 'yes' } },
        '127.0.0.1'
      )

      expect(headers.get('x-forwarded-for')).toBe('198.51.100.7')
      for (const name of dropped) expect(headers.has(name)).toBe(false)
      expect(headers.get('x-keep')).toBe('yes')
    })

    it('forwards the same single address for a request the Platform bridged from an app host', async () => {
      // <tenant>--<id>.ficus.garden: the Platform re-sends to the tenant origin, whose Caddy
      // hands Core the same route with the tenant host and the bridge's headers.
      const headers = await forwardedHeaders(
        {
          url: (deployment) =>
            localDeploymentUrl(deployment).replace('http://ficus.test', 'https://noah.ficus.sh') +
            `&${LEGACY_TOKEN_QUERY_PARAM}=bridged`,
          headers: {
            ...forgedHeaders,
            host: 'noah.ficus.sh',
            via: '2.0 Caddy, 1.1 Caddy',
            'x-forwarded-host': 'noah.ficus.sh',
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '198.51.100.7',
          },
        },
        '127.0.0.1'
      )

      expect(headers.get('x-forwarded-for')).toBe('198.51.100.7')
      for (const name of dropped) expect(headers.has(name)).toBe(false)
    })

    it('collapses a proxied chain to the nearest untrusted hop, one entry only', async () => {
      const headers = await forwardedHeaders({ headers: { 'x-forwarded-for': `${FORGED}, 198.51.100.7` } }, '127.0.0.1')

      expect(headers.get('x-forwarded-for')).toBe('198.51.100.7')
    })

    it('forwards the socket peer for a request that bypassed the proxy, ignoring its claims', async () => {
      const headers = await forwardedHeaders(
        { headers: { ...forgedHeaders, 'x-forwarded-for': FORGED } },
        '203.0.113.20'
      )

      expect(headers.get('x-forwarded-for')).toBe('203.0.113.20')
      for (const name of dropped) expect(headers.has(name)).toBe(false)
    })

    it('forwards IPv6 visitors and peers as bare addresses', async () => {
      const viaProxy = await forwardedHeaders({ headers: { 'x-forwarded-for': '2001:DB8::7' } }, '::1')
      expect(viaProxy.get('x-forwarded-for')).toBe('2001:db8::7')

      fetchCalls.length = 0
      const direct = await forwardedHeaders({ headers: { 'x-forwarded-for': FORGED } }, '2001:db8::20')
      expect(direct.get('x-forwarded-for')).toBe('2001:db8::20')

      fetchCalls.length = 0
      const mapped = await forwardedHeaders({ headers: {} }, '::ffff:203.0.113.21')
      expect(mapped.get('x-forwarded-for')).toBe('203.0.113.21')
    })

    it('sends no X-Forwarded-For when the client address is unknown', async () => {
      const headers = await forwardedHeaders({ headers: { ...forgedHeaders, 'x-forwarded-for': FORGED } }, undefined)

      expect(headers.has('x-forwarded-for')).toBe(false)
      for (const name of dropped) expect(headers.has(name)).toBe(false)
    })

    it('delivers one X-Forwarded-For over real sockets, peer captured as Core captures it', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const seen: Array<Array<[string, string]>> = []
      const app = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          seen.push([...req.headers.entries()])
          return new Response('ok')
        },
      })
      // Core's own Bun.serve wrapper (index.ts): attach the socket peer, then route.
      const core = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req, server) {
          attachPeerAddress(req, server.requestIP(req)?.address)
          return proxyLocalDeploymentRequest(localDeployment.id, req, '')
        },
      })
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.port! }),
      })
      try {
        const url = new URL(localDeploymentUrl(localDeployment))
        const response = await fetch(`http://127.0.0.1:${core.port}${url.pathname}${url.search}`, {
          headers: { ...forgedHeaders, 'x-forwarded-for': `${FORGED}, 198.51.100.7` },
        })
        expect(response.status).toBe(200)
        await response.arrayBuffer()

        const clientAddressHeaders = seen[0]!.filter(([name]) => name === 'x-forwarded-for' || dropped.includes(name))
        expect(clientAddressHeaders).toEqual([['x-forwarded-for', '198.51.100.7']])
      } finally {
        core.stop(true)
        app.stop(true)
      }
    })
  })

  // Core's server idle timeout (index.ts) closed the browser's connection while a
  // slow app was still answering. Scaled down: the server idles out at 1 s (Bun
  // checks every few seconds), the app answers after 6 s.
  describe('slow app responses', () => {
    const APP_DELAY_MS = 6_000

    it('waits past the server idle timeout for the app, and only on the proxy route', async () => {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      const app = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch() {
          await Bun.sleep(APP_DELAY_MS)
          return new Response('slow but fine')
        },
      })
      // Core's chain as index.ts serves it, with a non-proxy route just as slow.
      // The control route sits before identity so it answers late instead of 401ing.
      const routes = new Hono()
      routes.get('/api/slow-non-proxy', async (c) => {
        await Bun.sleep(APP_DELAY_MS)
        return c.text('too late')
      })
      routes.use('*', identityMiddleware)
      routes.route('/api', deploymentsRouter)
      const core = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 1,
        fetch(req, server) {
          attachPeerAddress(req, server.requestIP(req)?.address)
          return routes.fetch(req, server)
        },
      })
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.port! }),
        requestIdleTimeoutSeconds: 15,
      })
      try {
        const [proxied, nonProxy] = await Promise.all([
          fetch(`http://127.0.0.1:${core.port}${localDeployment.urlPathOrHost}`).then(
            async (response) => ({ status: response.status, body: await response.text() }),
            (error: Error) => ({ status: 0, body: error.message })
          ),
          fetch(`http://127.0.0.1:${core.port}/api/slow-non-proxy`).then(
            async (response) => ({ status: response.status, body: await response.text() }),
            (error: Error) => ({ status: 0, body: error.message })
          ),
        ])

        expect(proxied).toEqual({ status: 200, body: 'slow but fine' })
        // Every other route keeps the server's idle timeout: the connection is closed.
        expect(nonProxy.status).toBe(0)
      } finally {
        core.stop(true)
        app.stop(true)
      }
    }, 30_000)
  })

  // Real sockets end to end: an app upstream that compresses, the proxy served
  // by Bun.serve as Core serves it, and a client that reads the raw wire bytes
  // (decompress: false) and decodes them per the Content-Encoding it received,
  // as a browser does. Bun's default fetch decodes the body but kept the
  // upstream Content-Encoding, which browsers reject as
  // ERR_CONTENT_DECODING_FAILED.
  describe('compressed upstream responses', () => {
    const asset = 'body{color:red}\n'.repeat(400)
    const encoders: Record<string, (input: string) => Uint8Array<ArrayBuffer>> = {
      gzip: (input) => new Uint8Array(gzipSync(input)),
      br: (input) => new Uint8Array(brotliCompressSync(input)),
      deflate: (input) => new Uint8Array(deflateSync(input)),
      zstd: (input) => new Uint8Array(Bun.zstdCompressSync(input)),
    }
    const decoders: Record<string, (input: Uint8Array) => string> = {
      gzip: (input) => gunzipSync(input).toString(),
      br: (input) => brotliDecompressSync(input).toString(),
      deflate: (input) => inflateSync(input).toString(),
      zstd: (input) => new TextDecoder().decode(Bun.zstdDecompressSync(input)),
    }

    let upstream: ReturnType<typeof Bun.serve>
    let front: ReturnType<typeof Bun.serve>
    let upstreamAcceptEncodings: Array<string | null>

    beforeEach(() => {
      upstreamAcceptEncodings = []
      upstream = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          upstreamAcceptEncodings.push(req.headers.get('accept-encoding'))
          const url = new URL(req.url)
          const encoding = url.searchParams.get('encoding')
          if (url.pathname === '/_next/static/not-modified.css')
            return new Response(null, { status: 304, headers: { etag: '"v1"', 'content-encoding': 'gzip' } })
          if (url.pathname === '/_next/static/empty') return new Response(null, { status: 204 })
          if (url.pathname === '/_next/static/plain.css')
            return new Response(asset, { headers: { 'content-type': 'text/css' } })
          const encoded = encoders[encoding ?? 'gzip'](asset)
          const headers: Record<string, string> = { 'content-type': 'text/css', 'content-encoding': encoding ?? 'gzip' }
          if (url.pathname === '/_next/static/marked.css') headers['x-ficus-app-proxy'] = 'error'
          if (url.pathname === '/_next/static/cdn-cached.css') {
            headers['cache-control'] = 'public, max-age=31536000, immutable'
            headers['cloudflare-cdn-cache-control'] = 'max-age=31536000'
            headers['surrogate-control'] = 'max-age=31536000'
          }
          if (url.pathname === '/_next/static/streamed.css') {
            const middle = Math.floor(encoded.length / 2)
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoded.subarray(0, middle))
                  controller.enqueue(encoded.subarray(middle))
                  controller.close()
                },
              }),
              { headers }
            )
          }
          return new Response(encoded, { headers })
        },
      })
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: upstream.port! }),
        fetch,
      })
    })

    afterEach(() => {
      upstream.stop(true)
      front?.stop(true)
    })

    async function runningDeployment() {
      const squad = await createTestSquad()
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
      front = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          const path = new URL(req.url).pathname.replace(`/api/app/${localDeployment.id}/`, '')
          return proxyLocalDeploymentRequest(localDeployment.id, req, path)
        },
      })
      return localDeployment
    }

    /** A browser-like request to the proxy, keeping the raw bytes on the wire. */
    async function browserFetch(
      localDeployment: { id: string; urlPathOrHost: string },
      path: string,
      { query = '', method = 'GET', withCookie = true } = {}
    ) {
      const url = new URL(localDeploymentUrl(localDeployment, path, query))
      const token = url.searchParams.get('_ficus_token')
      if (withCookie) url.searchParams.delete('_ficus_token')
      const response = await fetch(`http://127.0.0.1:${front.port}${url.pathname}${url.search}`, {
        method,
        headers: {
          'accept-encoding': 'gzip, deflate, br, zstd',
          ...(withCookie ? { cookie: `ficus_app_${localDeployment.id}=${token}` } : {}),
        },
        decompress: false,
      })
      return { response, bytes: new Uint8Array(await response.arrayBuffer()) }
    }

    it.each(Object.keys(encoders))(
      'passes a %s-encoded asset through byte for byte with its Content-Encoding',
      async (encoding) => {
        const localDeployment = await runningDeployment()

        const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', {
          query: `encoding=${encoding}`,
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-encoding')).toBe(encoding)
        expect(bytes).toEqual(encoders[encoding](asset))
        const contentLength = response.headers.get('content-length')
        if (contentLength !== null) expect(Number(contentLength)).toBe(bytes.length)
        expect(decoders[encoding](bytes)).toBe(asset)
        // The browser's Accept-Encoding still reaches the app.
        expect(upstreamAcceptEncodings[0]).toBe('gzip, deflate, br, zstd')
      }
    )

    it('passes a streamed gzip body through intact', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/streamed.css')

      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(decoders.gzip(bytes)).toBe(asset)
    })

    it('keeps the encoded body intact on the cookie-minting (URL token) request', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', {
        query: 'encoding=br',
        withCookie: false,
      })

      expect(response.headers.get('set-cookie')).toContain(`ficus_app_${localDeployment.id}=`)
      expect(response.headers.get('content-encoding')).toBe('br')
      expect(decoders.br(bytes)).toBe(asset)
    })

    it('strips an app-forged error marker from an encoded response without touching the body', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/marked.css')

      expect(response.headers.get('x-ficus-app-proxy')).toBeNull()
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(decoders.gzip(bytes)).toBe(asset)
    })

    it('answers HEAD with the encoded headers and no body', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/app.css', { method: 'HEAD' })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(bytes.length).toBe(0)
    })

    it('passes 304 and 204 through without a body', async () => {
      const localDeployment = await runningDeployment()

      const notModified = await browserFetch(localDeployment, '_next/static/not-modified.css')
      const empty = await browserFetch(localDeployment, '_next/static/empty')

      expect(notModified.response.status).toBe(304)
      expect(notModified.response.headers.get('etag')).toBe('"v1"')
      expect(notModified.bytes.length).toBe(0)
      expect(empty.response.status).toBe(204)
      expect(empty.bytes.length).toBe(0)
    })

    it('strips Cloudflare-CDN-Cache-Control and Surrogate-Control from an encoded asset, body intact', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/cdn-cached.css')

      expect(response.status).toBe(200)
      expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull()
      expect(response.headers.get('surrogate-control')).toBeNull()
      expect(response.headers.get('cdn-cache-control')).toBe('no-store')
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(decoders.gzip(bytes)).toBe(asset)
    })

    it('leaves an uncompressed response unchanged', async () => {
      const localDeployment = await runningDeployment()

      const { response, bytes } = await browserFetch(localDeployment, '_next/static/plain.css')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('content-type')).toBe('text/css')
      expect(new TextDecoder().decode(bytes)).toBe(asset)
    })
  })
})

describe('keepOutOfSharedCaches', () => {
  const cacheControl = (value: string | null) => {
    const headers = new Headers(value === null ? {} : { 'cache-control': value })
    keepOutOfSharedCaches(headers)
    return [headers.get('cache-control'), headers.get('cdn-cache-control')]
  }

  it('turns public into private and drops what only shared caches read', () => {
    expect(cacheControl('public, max-age=31536000, immutable')).toEqual([
      'private, max-age=31536000, immutable',
      'no-store',
    ])
    expect(cacheControl('s-maxage=31536000, stale-while-revalidate')).toEqual([
      'private, stale-while-revalidate',
      'no-store',
    ])
    expect(cacheControl('Public, S-MaxAge=60, proxy-revalidate, max-age=0')).toEqual(['private, max-age=0', 'no-store'])
  })

  it('marks a response with no caching headers private (a CDN would otherwise cache .js and .css by default)', () => {
    expect(cacheControl(null)).toEqual(['private', 'no-store'])
  })

  it('strips the CDN headers Cloudflare honors over Cache-Control and CDN-Cache-Control', () => {
    const headers = new Headers({
      'cache-control': 'public, max-age=31536000, immutable',
      'cloudflare-cdn-cache-control': 'max-age=31536000',
      'surrogate-control': 'max-age=31536000',
      'content-type': 'text/css',
      etag: '"v1"',
    })
    keepOutOfSharedCaches(headers)
    expect(headers.get('cloudflare-cdn-cache-control')).toBeNull()
    expect(headers.get('surrogate-control')).toBeNull()
    expect(headers.get('cdn-cache-control')).toBe('no-store')
    expect(headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(headers.get('content-type')).toBe('text/css')
    expect(headers.get('etag')).toBe('"v1"')
  })

  it('leaves no-store alone, already private', () => {
    expect(cacheControl('no-store')).toEqual(['no-store', 'no-store'])
    expect(cacheControl('private, no-cache')).toEqual(['private, no-cache', 'no-store'])
  })
})
