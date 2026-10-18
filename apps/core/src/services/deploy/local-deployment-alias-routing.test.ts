import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Server } from 'bun'
import { db, localDeploymentAliasReleases, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { attachPeerAddress } from '../../lib/client-address'
import { identityMiddleware } from '../../middleware/identity'
import { deploymentsRouter } from '../../routes/deployments'
import { LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS, LocalDeploymentAliasError } from './local-deployment-alias'
import { resolveLocalDeploymentRouteParameter } from './local-deployment-auth'
import { configureLocalDeploymentProxyDependencies } from './local-deployment-proxy'
import {
  archiveLocalDeploymentRecord,
  createLocalDeployment,
  getLocalDeployment,
  setLocalDeploymentAlias,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { coreWebSocketHandler } from './local-deployment-websocket'
import { resetLocalAppWebSocketRegistryForTests } from './local-deployment-websocket-registry'

/**
 * Local app aliases end to end: the service (claim, uniqueness, cooldown) and
 * Core's real serving chain for /api/app/* (identity middleware, the deployments
 * router, Bun.serve with the shared WebSocket handler) in front of a real app,
 * with requests shaped as the hosted Platform bridge sends them: from a trusted
 * (loopback) peer, the credential in the query, X-Forwarded-Host naming the app
 * host the browser used.
 */

const APPS_DOMAIN = 'ficus.garden'
const TENANT_ORIGIN = 'https://noah.ficus.sh'
const ENV_KEYS = ['FICUS_APPS_DOMAIN', 'APP_URL', 'FICUS_WEB_ORIGIN', 'WEBAUTHN_ORIGIN'] as const

const aliasHost = (alias: string) => `noah--${alias}.${APPS_DOMAIN}`
const idHost = (id: string) => `noah--${id.replaceAll('-', '').slice(0, 12)}.${APPS_DOMAIN}`

interface SeenRequest {
  method: string
  path: string
  host: string | null
  body: string
}

function startApp() {
  const seen: SeenRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, bun) {
      const url = new URL(request.url)
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        host: request.headers.get('host'),
        body: await request.text(),
      })
      if (bun.upgrade(request, { data: undefined })) return undefined
      return new Response('from app')
    },
    websocket: {
      open(ws) {
        ws.send('hello from app')
      },
      message() {},
    },
  })
  return { server, seen }
}

function startCore() {
  const routes = new Hono()
  routes.use('*', identityMiddleware)
  routes.route('/api', deploymentsRouter)
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      attachPeerAddress(request, server.requestIP(request)?.address)
      return routes.fetch(request, server)
    },
    websocket: coreWebSocketHandler,
  })
}

describe('local app aliases', () => {
  let testPrefix: string
  let previousEnv: Record<string, string | undefined>
  let app: ReturnType<typeof startApp>
  let core: Server<unknown>
  const openSockets: WebSocket[] = []

  beforeEach(() => {
    testPrefix = `local-app-alias-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    process.env.FICUS_APPS_DOMAIN = APPS_DOMAIN
    process.env.APP_URL = TENANT_ORIGIN
    process.env.FICUS_WEB_ORIGIN = TENANT_ORIGIN
    delete process.env.WEBAUTHN_ORIGIN
    app = startApp()
    core = startCore()
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.server.port! }),
    })
  })

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.close()
    configureLocalDeploymentProxyDependencies()
    resetLocalAppWebSocketRegistryForTests()
    await core.stop(true)
    await app.server.stop(true)
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(localDeploymentAliasReleases).where(like(localDeploymentAliasReleases.alias, `${uniquePart()}-%`))
  })

  /** Aliases are instance-wide: each test run uses its own so parallel runs never collide. */
  let aliasSuffix = ''
  function uniquePart(): string {
    if (!aliasSuffix) aliasSuffix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    return aliasSuffix
  }
  function alias(name: string): string {
    return `${uniquePart()}-${name}`
  }

  async function runningApp(options: { alias?: string } = {}) {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad-${Math.random().toString(36).slice(2, 6)}`, purpose: 'Alias test squad' })
      .returning()
    const localDeployment = await createLocalDeployment(new Squad(row), {
      name: 'web',
      port: 5173,
      mode: 'attached',
      ...(options.alias ? { alias: options.alias } : {}),
    })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    const token = new URL(localDeployment.urlPathOrHost, 'http://ficus.test').searchParams.get('_ficus_token')!
    return { localDeployment, id: localDeployment.id, token }
  }

  function bridgeRequest(
    routeParameter: string,
    forwardedHost: string,
    pathAndQuery: string,
    token: string | null,
    init: RequestInit = {}
  ) {
    const url = new URL(`http://127.0.0.1:${core.port}/api/app/${routeParameter}/${pathAndQuery.replace(/^\//, '')}`)
    // Appended raw, as the bridge sends it: searchParams.set would re-encode the whole query.
    if (token !== null) url.search = `${url.search ? `${url.search}&` : '?'}_ficus_token=${encodeURIComponent(token)}`
    return fetch(url, {
      redirect: 'manual',
      ...init,
      headers: { host: 'noah.ficus.sh', 'x-forwarded-host': forwardedHost, ...(init.headers ?? {}) },
    })
  }

  describe('claiming an alias', () => {
    it('links the app by its alias host once it has one, and by its id host again once cleared', async () => {
      const { id, token } = await runningApp()
      const name = alias('dashboard')

      const aliased = await setLocalDeploymentAlias(id, name)
      expect(aliased.alias).toBe(name)
      expect(aliased.urlPathOrHost).toBe(`https://${aliasHost(name)}/?_ficus_token=${encodeURIComponent(token)}`)

      const cleared = await setLocalDeploymentAlias(id, null)
      expect(cleared.alias).toBeNull()
      expect(cleared.urlPathOrHost).toBe(`https://${idHost(id)}/?_ficus_token=${encodeURIComponent(token)}`)
    })

    it('takes an alias at create time and stores it normalized', async () => {
      const name = alias('board')
      const { localDeployment } = await runningApp({ alias: `  ${name.toUpperCase()} ` })
      expect(localDeployment.alias).toBe(name)
      expect(new URL(localDeployment.urlPathOrHost).host).toBe(aliasHost(name))
    })

    it('refuses an alias another app holds, at create time and later', async () => {
      const name = alias('taken')
      await runningApp({ alias: name })
      const other = await runningApp()

      await expect(setLocalDeploymentAlias(other.id, name)).rejects.toMatchObject({ kind: 'conflict' })
      await expect(runningApp({ alias: name })).rejects.toBeInstanceOf(LocalDeploymentAliasError)
      expect((await getLocalDeployment(other.id))!.alias).toBeNull()
    })

    it('lets exactly one of two concurrent claims win', async () => {
      const name = alias('race')
      const [a, b] = await Promise.all([runningApp(), runningApp()])
      const results = await Promise.allSettled([
        setLocalDeploymentAlias(a.id, name),
        setLocalDeploymentAlias(b.id, name),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      expect(rejected.reason).toMatchObject({ kind: 'conflict' })
    })

    it('refuses invalid and reserved aliases', async () => {
      const { id } = await runningApp()
      for (const bad of ['my--app', 'api', 'www', '0123456789ab', '-x', 'dash_board', 'xn--abc']) {
        await expect(setLocalDeploymentAlias(id, bad)).rejects.toMatchObject({ kind: 'invalid' })
      }
    })

    it('holds a freed alias for the cooldown against every other app, but not the app that freed it', async () => {
      const name = alias('cool')
      const owner = await runningApp({ alias: name })
      const other = await runningApp()

      // Renamed away: the old name is cooling down.
      await setLocalDeploymentAlias(owner.id, alias('renamed'))
      await expect(setLocalDeploymentAlias(other.id, name)).rejects.toMatchObject({ kind: 'conflict' })
      await expect(runningApp({ alias: name })).rejects.toMatchObject({ kind: 'conflict' })
      // The app that freed it may take it back.
      expect((await setLocalDeploymentAlias(owner.id, name)).alias).toBe(name)

      // Cleared, then archived: still held.
      await setLocalDeploymentAlias(owner.id, null)
      await expect(setLocalDeploymentAlias(other.id, name)).rejects.toMatchObject({ kind: 'conflict' })
      await setLocalDeploymentAlias(owner.id, name)
      const archived = await archiveLocalDeploymentRecord(owner.id)
      expect(archived.alias).toBeNull()
      await expect(setLocalDeploymentAlias(other.id, name)).rejects.toMatchObject({ kind: 'conflict' })

      // Past the cooldown it is free for anyone.
      await db
        .update(localDeploymentAliasReleases)
        .set({ releasedAt: new Date(Date.now() - LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS - 60_000) })
        .where(eq(localDeploymentAliasReleases.alias, name))
      expect((await setLocalDeploymentAlias(other.id, name)).alias).toBe(name)
    })

    it('needs per-app hosts: refused without FICUS_APPS_DOMAIN, and an existing alias has no routing effect', async () => {
      const name = alias('nodomain')
      const { id, token } = await runningApp({ alias: name })
      delete process.env.FICUS_APPS_DOMAIN

      await expect(setLocalDeploymentAlias(id, alias('other'))).rejects.toMatchObject({ kind: 'unavailable' })
      await expect(runningApp({ alias: alias('fresh') })).rejects.toMatchObject({ kind: 'unavailable' })
      const current = (await getLocalDeployment(id))!
      expect(current.urlPathOrHost).toBe(`/api/app/${id}/?_ficus_token=${encodeURIComponent(token)}`)
      // The alias route does not exist, and the path mount serves the app directly.
      expect((await bridgeRequest(`~${name}`, aliasHost(name), '/', token)).status).toBe(401)
      const direct = await fetch(`http://127.0.0.1:${core.port}/api/app/${id}/page?_ficus_token=${token}`, {
        redirect: 'manual',
      })
      expect(direct.status).toBe(200)
      // Clearing still works.
      expect((await setLocalDeploymentAlias(id, null)).alias).toBeNull()
    })
  })

  describe('serving', () => {
    it('routes the alias host to the app, which sees its alias host', async () => {
      const name = alias('dashboard')
      const { token } = await runningApp({ alias: name })

      const response = await bridgeRequest(`~${name}`, aliasHost(name), '/reports?range=7d', token)

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('from app')
      expect(app.seen).toEqual([{ method: 'GET', path: '/reports?range=7d', host: aliasHost(name), body: '' }])
    })

    it('resolves an alias route only for a trusted peer naming exactly that alias host', async () => {
      const name = alias('strict')
      const { id, token } = await runningApp({ alias: name })
      const request = (headers: Record<string, string>, peer = '127.0.0.1') => {
        const r = new Request(`${TENANT_ORIGIN}/api/app/~${name}/?_ficus_token=${token}`, { headers })
        attachPeerAddress(r, peer)
        return r
      }

      expect(
        (await resolveLocalDeploymentRouteParameter(request({ 'x-forwarded-host': aliasHost(name) }), `~${name}`))?.id
      ).toBe(id)
      expect(
        await resolveLocalDeploymentRouteParameter(
          request({ 'x-forwarded-host': aliasHost(name) }, '203.0.113.9'),
          `~${name}`
        )
      ).toBeNull()
      expect(
        await resolveLocalDeploymentRouteParameter(request({ 'x-forwarded-host': idHost(id) }), `~${name}`)
      ).toBeNull()
      expect(await resolveLocalDeploymentRouteParameter(request({}), `~${name}`)).toBeNull()
      expect(
        await resolveLocalDeploymentRouteParameter(
          request({ 'x-forwarded-host': `noah--${name}.evil.example` }),
          `~${name}`
        )
      ).toBeNull()
      // Through Core's chain: the Ficus-host path mount has no alias route.
      expect((await bridgeRequest(`~${name}`, 'noah.ficus.sh', '/', token)).status).toBe(401)
      expect(app.seen).toHaveLength(0)
    })

    it('stops resolving the alias host once the alias is cleared or moved', async () => {
      const name = alias('moving')
      const { id, token } = await runningApp({ alias: name })
      await setLocalDeploymentAlias(id, null)

      expect((await bridgeRequest(`~${name}`, aliasHost(name), '/', token)).status).toBe(401)
      expect(app.seen).toHaveLength(0)
    })

    it('applies the same access checks on the alias host: a wrong or missing credential is refused', async () => {
      const name = alias('locked')
      await runningApp({ alias: name })
      const other = await runningApp()

      expect((await bridgeRequest(`~${name}`, aliasHost(name), '/', null)).status).toBe(401)
      expect((await bridgeRequest(`~${name}`, aliasHost(name), '/', 'wrong')).status).toBe(401)
      // Another app's valid credential is not this app's.
      expect((await bridgeRequest(`~${name}`, aliasHost(name), '/', other.token)).status).toBe(401)
      expect(app.seen).toHaveLength(0)
    })

    it('redirects the id host to the alias host with path and query, 307, uncached, credential only to the alias host', async () => {
      const name = alias('redirect')
      const { id, token } = await runningApp({ alias: name })

      const response = await bridgeRequest(id, idHost(id), '/a/b%20c?q=1&q=2&next=%2Fx', token)

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location')!)
      expect(location.origin).toBe(`https://${aliasHost(name)}`)
      expect(location.pathname).toBe('/a/b%20c')
      // The query keeps its exact encoding; only the credential is replaced.
      expect(location.search).toBe(`?q=1&q=2&next=%2Fx&_ficus_token=${encodeURIComponent(token)}`)
      expect(location.searchParams.getAll('q')).toEqual(['1', '2'])
      expect(location.searchParams.get('next')).toBe('/x')
      expect(location.searchParams.getAll('_ficus_token')).toEqual([token])
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.getSetCookie()).toEqual([])
      expect(app.seen).toHaveLength(0)
    })

    it('lands a token-gated entry on the id host signed in on the alias host', async () => {
      const name = alias('entry')
      const { id, token } = await runningApp({ alias: name })

      // The visitor opens the id-host link; the bridge forwards it with the credential.
      const redirect = await bridgeRequest(id, idHost(id), '/welcome', token)
      expect(redirect.status).toBe(307)
      const location = new URL(redirect.headers.get('location')!)
      // The bridge on the alias host takes the credential from the URL (setting its
      // own cookie for that host) and forwards the request to the alias route.
      const carried = location.searchParams.get('_ficus_token')
      expect(carried).toBe(token)
      location.searchParams.delete('_ficus_token')
      const landed = await bridgeRequest(`~${name}`, location.host, `${location.pathname}${location.search}`, carried)

      expect(landed.status).toBe(200)
      expect(app.seen.map((seen) => [seen.path, seen.host])).toEqual([['/welcome', aliasHost(name)]])
    })

    it('keeps the method and body on a redirected POST, and sends no credential with it', async () => {
      const name = alias('post')
      const { id, token } = await runningApp({ alias: name })

      const response = await bridgeRequest(id, idHost(id), '/api/items?x=a%20b&_tau_token=legacy', token, {
        method: 'POST',
        body: '{"a":1}',
      })

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location')!)
      expect(`${location.origin}${location.pathname}${location.search}`).toBe(
        `https://${aliasHost(name)}/api/items?x=a%20b`
      )
      expect(app.seen).toHaveLength(0)
    })

    it('refuses an unauthenticated id-host request instead of revealing the alias', async () => {
      const name = alias('secret')
      const { id } = await runningApp({ alias: name })

      const response = await bridgeRequest(id, idHost(id), '/', 'wrong')

      expect(response.status).toBe(401)
      expect(response.headers.get('location')).toBeNull()
    })

    it('serves the id host directly when the app has no alias, and again after it is cleared', async () => {
      const { id, token } = await runningApp()
      expect((await bridgeRequest(id, idHost(id), '/one', token)).status).toBe(200)

      await setLocalDeploymentAlias(id, alias('brief'))
      expect((await bridgeRequest(id, idHost(id), '/two', token)).status).toBe(307)

      await setLocalDeploymentAlias(id, null)
      expect((await bridgeRequest(id, idHost(id), '/three', token)).status).toBe(200)
      expect(app.seen.map((seen) => seen.path)).toEqual(['/one', '/three'])
    })

    it('does not redirect the path mount', async () => {
      const name = alias('pathmount')
      const { id, token } = await runningApp({ alias: name })
      const response = await fetch(`http://127.0.0.1:${core.port}/api/app/${id}/page?_ficus_token=${token}`, {
        redirect: 'manual',
        headers: { host: 'noah.ficus.sh' },
      })
      expect(response.status).toBe(200)
    })
  })

  describe('WebSockets', () => {
    function socketUrl(routeParameter: string, token: string): string {
      return `ws://127.0.0.1:${core.port}/api/app/${routeParameter}/socket?_ficus_token=${encodeURIComponent(token)}`
    }

    /** Resolves true when the socket opens and the app greets it, false when the handshake is refused. */
    function connects(url: string, headers: Record<string, string>): Promise<boolean> {
      return new Promise((resolve) => {
        const socket = new WebSocket(url, { headers } as unknown as string[])
        openSockets.push(socket)
        socket.addEventListener('message', () => resolve(true))
        socket.addEventListener('error', () => resolve(false))
        socket.addEventListener('close', () => resolve(false))
      })
    }

    it('accepts upgrades on the alias host from the app origins, and refuses every other origin', async () => {
      const name = alias('ws')
      const { id, token } = await runningApp({ alias: name })
      const other = await runningApp({ alias: alias('ws-other') })
      const onAlias = (origin: string) =>
        connects(socketUrl(`~${name}`, token), { host: 'noah.ficus.sh', 'x-forwarded-host': aliasHost(name), origin })

      expect(await onAlias(`https://${aliasHost(name)}`)).toBe(true)
      expect(await onAlias(`https://${idHost(id)}`)).toBe(true)
      expect(await onAlias(`https://${aliasHost(other.localDeployment.alias!)}`)).toBe(false)
      expect(await onAlias(`https://${idHost(other.id)}`)).toBe(false)
      expect(await onAlias(TENANT_ORIGIN)).toBe(false)
      expect(await onAlias(`http://${aliasHost(name)}`)).toBe(false)
    })

    it('serves upgrades on the id host of an aliased app instead of redirecting them, with the same origin check', async () => {
      const name = alias('ws-id')
      const { id, token } = await runningApp({ alias: name })
      const onId = (origin: string) =>
        connects(socketUrl(id, token), { host: 'noah.ficus.sh', 'x-forwarded-host': idHost(id), origin })

      expect(await onId(`https://${aliasHost(name)}`)).toBe(true)
      expect(await onId(`https://${idHost(id)}`)).toBe(true)
      expect(await onId(`https://noah--${alias('nobody')}.${APPS_DOMAIN}`)).toBe(false)
      expect(await onId(TENANT_ORIGIN)).toBe(false)
    })

    it('accepts only the id host origin once the alias is cleared', async () => {
      const name = alias('ws-cleared')
      const { id, token } = await runningApp({ alias: name })
      await setLocalDeploymentAlias(id, null)
      const onId = (origin: string) =>
        connects(socketUrl(id, token), { host: 'noah.ficus.sh', 'x-forwarded-host': idHost(id), origin })

      expect(await onId(`https://${idHost(id)}`)).toBe(true)
      expect(await onId(`https://${aliasHost(name)}`)).toBe(false)
    })
  })
})
