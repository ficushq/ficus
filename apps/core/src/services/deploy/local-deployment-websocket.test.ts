import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import type { Server, ServerWebSocket } from 'bun'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { attachPeerAddress } from '../../lib/client-address'
import { identityMiddleware } from '../../middleware/identity'
import { deploymentsRouter } from '../../routes/deployments'
import { configureLocalDeploymentProxyDependencies, proxyLocalDeploymentRequest } from './local-deployment-proxy'
import { createLocalDeployment, updateLocalDeploymentRecord } from './local-deployment-service'
import type { WebSocketUpgradeServer } from './local-deployment-websocket'

/**
 * WebSocket upgrades through the local-app proxy, over real sockets: a real app
 * WebSocket server behind Core's own chain (identity middleware, the
 * /api/app/:id/* route, Bun.serve with Hono's shared websocket handler).
 */

const APPS_DOMAIN = 'ficus.garden'
const TENANT_ORIGIN = 'https://noah.ficus.sh'
const ENV_KEYS = ['FICUS_APPS_DOMAIN', 'APP_URL', 'FICUS_WEB_ORIGIN', 'WEBAUTHN_ORIGIN'] as const

interface Handshake {
  url: string
  headers: Record<string, string>
}

/** The app: records each handshake, greets on open, echoes every frame, closes on request. */
function startApp() {
  const handshakes: Handshake[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const sockets = new Set<ServerWebSocket<unknown>>()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, bun) {
      const handshake = { url: request.url, headers: Object.fromEntries(request.headers) }
      if (new URL(request.url).pathname === '/refuse') return new Response('not here', { status: 404 })
      handshakes.push(handshake)
      const protocol = request.headers.get('sec-websocket-protocol')?.includes('vite-hmr') ? 'vite-hmr' : undefined
      const headers = new Headers()
      if (protocol) headers.set('sec-websocket-protocol', protocol)
      if (bun.upgrade(request, { data: undefined, headers })) return undefined
      return new Response('plain http', { status: 200 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send('hello from app')
      },
      message(ws, message) {
        if (message === 'close-please') return ws.close(4002, 'app says bye')
        ws.send(typeof message === 'string' ? `echo:${message}` : message)
      },
      close(ws, code, reason) {
        sockets.delete(ws)
        closes.push({ code, reason })
      },
    },
  })
  return { server, handshakes, closes }
}

/** Core's serving chain for /api/app/:id/*, as index.ts wires it. */
function startCore() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/api', deploymentsRouter)
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      attachPeerAddress(request, server.requestIP(request)?.address)
      return app.fetch(request, server)
    },
    websocket,
  })
}

/** A browser-side socket that collects what it receives and how it closed. */
function openBrowserSocket(url: string, options: { headers?: Record<string, string>; protocols?: string[] } = {}) {
  const socket = new WebSocket(url, options as unknown as string[])
  socket.binaryType = 'arraybuffer'
  const received: Array<string | ArrayBuffer> = []
  const waiters: Array<() => void> = []
  socket.addEventListener('message', (event) => {
    received.push(event.data as string | ArrayBuffer)
    for (const wake of waiters.splice(0)) wake()
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('handshake failed')))
  })
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', (event) => resolve(event)))
  async function nextMessages(count: number): Promise<Array<string | ArrayBuffer>> {
    while (received.length < count) await new Promise<void>((wake) => waiters.push(wake))
    return received.slice(0, count)
  }
  return { socket, opened, closed, received, nextMessages }
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(5)
}

describe('local app WebSocket upgrades', () => {
  let testPrefix: string
  let previousEnv: Record<string, string | undefined>
  let app: ReturnType<typeof startApp>
  let core: Server<unknown>
  const openSockets: WebSocket[] = []

  beforeEach(() => {
    testPrefix = `local-app-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    await core.stop(true)
    await app.server.stop(true)
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function runningDeployment() {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-squad`, purpose: 'Local app WebSocket proxy test squad' })
      .returning()
    const localDeployment = await createLocalDeployment(new Squad(row), { name: 'web', port: 5173, mode: 'attached' })
    await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })
    const token = new URL(`http://ficus.test${localDeployment.urlPathOrHost}`).searchParams.get('_ficus_token')!
    const appHost = `noah--${localDeployment.id.replaceAll('-', '').slice(0, 12)}.${APPS_DOMAIN}`
    return { id: localDeployment.id, token, appHost }
  }

  function coreUrl(id: string, path: string, query = ''): string {
    return `ws://127.0.0.1:${core.port}/api/app/${id}/${path}${query ? `?${query}` : ''}`
  }

  function browser(url: string, options: { headers?: Record<string, string>; protocols?: string[] } = {}) {
    const opened = openBrowserSocket(url, options)
    openSockets.push(opened.socket)
    return opened
  }

  /** An upgrade request as Core receives it, for the refusals that answer before any socket exists. */
  function upgradeRequest(url: string, headers: Record<string, string> = {}): Request {
    const request = new Request(url.replace(/^ws/, 'http'), {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    })
    attachPeerAddress(request, '127.0.0.1')
    return request
  }

  const neverUpgrades: WebSocketUpgradeServer = {
    upgrade: () => {
      throw new Error('a refused upgrade must not reach the server')
    },
  }

  it('relays frames both ways on the path mount, with the same header rules as HTTP', async () => {
    const { id, token } = await runningDeployment()
    const client = browser(coreUrl(id, '_next/webpack-hmr', `_ficus_token=${token}&page=%2F`), {
      headers: {
        host: 'noah.ficus.sh',
        origin: TENANT_ORIGIN,
        cookie: `ficus_session=session-secret; ficus_app_${id}=${token}; app-plain=1`,
        authorization: 'Bearer ficus-secret',
        'x-real-ip': '6.6.6.6',
      },
    })
    await client.opened

    expect(await client.nextMessages(1)).toEqual(['hello from app'])
    client.socket.send('ping')
    const binary = new Uint8Array(70_000).map((_, index) => index % 251)
    client.socket.send(binary)
    const [, echoed, echoedBinary] = await client.nextMessages(3)
    expect(echoed).toBe('echo:ping')
    expect(new Uint8Array(echoedBinary as ArrayBuffer)).toEqual(binary)

    expect(app.handshakes).toHaveLength(1)
    const { url, headers } = app.handshakes[0]!
    // The credential never reaches the app, in the query or anywhere else.
    expect(new URL(url).pathname).toBe('/_next/webpack-hmr')
    expect(new URL(url).search).toBe('?page=%2F')
    expect(JSON.stringify(headers)).not.toContain(token)
    expect(JSON.stringify(headers)).not.toContain('secret')
    // Path mount: the shared Ficus origin, so no cookie at all, and the Ficus host.
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers.host).toBe('noah.ficus.sh')
    expect(headers['x-forwarded-host']).toBe('noah.ficus.sh')
    // One X-Forwarded-For that Core resolved (the socket peer here); forged address headers are dropped.
    expect(headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(headers['x-real-ip']).toBeUndefined()
    expect(headers.origin).toBe(TENANT_ORIGIN)
  })

  it('accepts the path-scoped access cookie alone as the credential', async () => {
    const { id, token } = await runningDeployment()
    const client = browser(coreUrl(id, 'socket'), {
      headers: { host: 'noah.ficus.sh', origin: TENANT_ORIGIN, cookie: `ficus_app_${id}=${token}` },
    })
    await client.opened

    expect(await client.nextMessages(1)).toEqual(['hello from app'])
    expect(app.handshakes[0]!.headers.cookie).toBeUndefined()
  })

  it("gives the app its cookies and host on the per-app origin, and the app's subprotocol to the browser", async () => {
    const { id, token, appHost } = await runningDeployment()
    const client = browser(coreUrl(id, 'hmr', `_ficus_token=${token}`), {
      headers: {
        host: 'noah.ficus.sh',
        'x-forwarded-host': appHost,
        origin: `https://${appHost}`,
        cookie: `ficus_session=session-secret; __Host-ficus_app=bridge-secret; ficus_app_${id}=access-secret; app-session=a1; theme=dark`,
      },
      protocols: ['vite-hmr', 'vite-ping'],
    })
    await client.opened

    expect(client.socket.protocol).toBe('vite-hmr')
    expect(await client.nextMessages(1)).toEqual(['hello from app'])
    const { headers } = app.handshakes[0]!
    expect(headers.cookie).toBe('app-session=a1; theme=dark')
    expect(headers.host).toBe(appHost)
    expect(headers['x-forwarded-host']).toBe(appHost)
    expect(headers['x-forwarded-proto']).toBe('https')
    expect(headers['sec-websocket-protocol']).toBe('vite-hmr, vite-ping')
    expect(JSON.stringify(headers)).not.toContain('secret')
    expect(JSON.stringify(headers)).not.toContain(token)
  })

  it('propagates a close from the browser to the app, code and reason included', async () => {
    const { id, token } = await runningDeployment()
    const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`), { headers: { origin: TENANT_ORIGIN } })
    await client.opened
    await client.nextMessages(1)

    client.socket.close(4001, 'browser says bye')

    await waitFor(() => app.closes.length > 0)
    expect(app.closes).toEqual([{ code: 4001, reason: 'browser says bye' }])
  })

  it('propagates a close from the app to the browser, code and reason included', async () => {
    const { id, token } = await runningDeployment()
    const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`), { headers: { origin: TENANT_ORIGIN } })
    await client.opened
    await client.nextMessages(1)

    client.socket.send('close-please')
    const closed = await client.closed

    expect(closed.code).toBe(4002)
    expect(closed.reason).toBe('app says bye')
  })

  it('refuses the upgrade without a credential or with a wrong one, before reaching the app', async () => {
    const { id } = await runningDeployment()
    const missing = browser(coreUrl(id, 'socket'), {
      headers: { origin: TENANT_ORIGIN, cookie: 'ficus_session=session-secret' },
      // A Ficus bearer token is not an app credential either.
    })
    const wrong = browser(coreUrl(id, 'socket', '_ficus_token=wrong'), {
      headers: { origin: TENANT_ORIGIN, authorization: 'Bearer anything' },
    })

    await expect(missing.opened).rejects.toThrow('handshake failed')
    await expect(wrong.opened).rejects.toThrow('handshake failed')
    const refused = await proxyLocalDeploymentRequest(
      id,
      upgradeRequest(coreUrl(id, 'socket'), { origin: TENANT_ORIGIN }),
      'socket',
      neverUpgrades
    )
    expect(refused.status).toBe(401)
    expect(refused.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(app.handshakes).toHaveLength(0)
  })

  it('refuses a browser handshake from any origin other than the one the app is served on', async () => {
    const { id, token, appHost } = await runningDeployment()
    const otherApp = 'https://mallory--0123456789ab.ficus.garden'
    const perApp = { host: 'noah.ficus.sh', 'x-forwarded-host': appHost }

    const refusals = await Promise.all([
      // Another app on the apps domain is same-site: its page would send the Lax credential cookie.
      proxyLocalDeploymentRequest(
        id,
        upgradeRequest(coreUrl(id, 's', `_ficus_token=${token}`), { ...perApp, origin: otherApp }),
        's',
        neverUpgrades
      ),
      // The Ficus origin is not the app's origin on the per-app host.
      proxyLocalDeploymentRequest(
        id,
        upgradeRequest(coreUrl(id, 's', `_ficus_token=${token}`), { ...perApp, origin: TENANT_ORIGIN }),
        's',
        neverUpgrades
      ),
      // Another tenant on the Ficus domain, on the path mount.
      proxyLocalDeploymentRequest(
        id,
        upgradeRequest(coreUrl(id, 's', `_ficus_token=${token}`), { origin: 'https://mallory.ficus.sh' }),
        's',
        neverUpgrades
      ),
    ])

    expect(refusals.map((response) => response.status)).toEqual([403, 403, 403])
    expect(refusals.every((response) => response.headers.get('x-ficus-app-proxy') === 'error')).toBe(true)
    expect(app.handshakes).toHaveLength(0)
    // No Origin is a non-browser client holding the credential itself: allowed.
    const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`))
    await client.opened
  })

  it('answers a marked 502 when the app refuses the upgrade or never answers', async () => {
    const { id, token } = await runningDeployment()
    const refused = await proxyLocalDeploymentRequest(
      id,
      upgradeRequest(coreUrl(id, 'refuse', `_ficus_token=${token}`)),
      'refuse',
      neverUpgrades
    )
    expect(refused.status).toBe(502)
    expect(refused.headers.get('x-ficus-app-proxy')).toBe('error')

    // An app port that accepts TCP but never answers the handshake.
    const accepted: Array<{ end(): void }> = []
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { open: (socket) => void accepted.push(socket), data() {} },
    })
    try {
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: silent.port }),
        webSocketConnectTimeoutMs: 200,
      })
      const timedOut = await proxyLocalDeploymentRequest(
        id,
        upgradeRequest(coreUrl(id, 'socket', `_ficus_token=${token}`)),
        'socket',
        neverUpgrades
      )
      expect(timedOut.status).toBe(502)
      expect(accepted).toHaveLength(1)
    } finally {
      for (const socket of accepted) socket.end()
      silent.stop(true)
    }
  })

  it('keeps plain HTTP on the same route a plain proxied request', async () => {
    const { id, token } = await runningDeployment()
    const response = await fetch(`http://127.0.0.1:${core.port}/api/app/${id}/page?_ficus_token=${token}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('plain http')
    expect(app.handshakes).toHaveLength(1)
    expect(app.handshakes[0]!.headers.upgrade).toBeUndefined()
  })
})
