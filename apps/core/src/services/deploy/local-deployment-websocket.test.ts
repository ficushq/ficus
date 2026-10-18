import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Server, ServerWebSocket, Socket } from 'bun'
import { db, localDeployments, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { attachPeerAddress } from '../../lib/client-address'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { identityMiddleware } from '../../middleware/identity'
import { deploymentsRouter } from '../../routes/deployments'
import { configureLocalDeploymentProxyDependencies, proxyLocalDeploymentRequest } from './local-deployment-proxy'
import {
  archiveLocalDeploymentRecord,
  createLocalDeployment,
  markLocalDeploymentsStoppedForSandbox,
  stopLocalDeploymentRecord,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { coreWebSocketHandler, type WebSocketUpgradeServer } from './local-deployment-websocket'
import {
  countLocalAppWebSockets,
  resetLocalAppWebSocketRegistryForTests,
  revalidateAllLocalAppWebSockets,
  shutdownLocalAppWebSockets,
} from './local-deployment-websocket-registry'

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

/** Frames the app sends on `flood`: more than Bun buffers toward one socket (16 MiB). */
const FLOOD_FRAMES = 48
const FLOOD_FRAME_BYTES = 1024 * 1024

/**
 * The app: records each handshake, greets on open, echoes every frame, closes
 * on request, and on `flood` sends {@link FLOOD_FRAMES} numbered 1 MiB frames,
 * honoring its own backpressure (a well-behaved app waits for drain).
 */
function startApp() {
  const handshakes: Handshake[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const sockets = new Set<ServerWebSocket<unknown>>()
  const flooding = new Map<ServerWebSocket<unknown>, number>()
  const flood = (ws: ServerWebSocket<unknown>) => {
    let next = flooding.get(ws) ?? 0
    while (next < FLOOD_FRAMES) {
      const frame = new Uint8Array(FLOOD_FRAME_BYTES).fill(next)
      const status = ws.send(frame)
      if (status === 0) throw new Error('the app itself dropped a frame')
      next++
      if (status === -1) break
    }
    flooding.set(ws, next)
  }
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
        if (message === 'flood') return flood(ws)
        if (message === 'too-big') return void ws.send(new Uint8Array(16 * 1024 * 1024 + 1))
        ws.send(typeof message === 'string' ? `echo:${message}` : message)
      },
      drain(ws) {
        if (flooding.has(ws)) flood(ws)
      },
      close(ws, code, reason) {
        sockets.delete(ws)
        closes.push({ code, reason })
      },
      maxPayloadLength: 32 * 1024 * 1024,
    },
  })
  return { server, handshakes, closes }
}

/**
 * An app that completes the WebSocket handshake and then goes silent: it
 * answers no ping (a half-open socket), and with `stopReading` it stops reading
 * altogether (an app too slow to take what the browser sends).
 */
function startSilentApp(options: { stopReading?: boolean } = {}) {
  const sockets: Socket<undefined>[] = []
  let ended = 0
  const listener = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => void sockets.push(socket),
      data(socket, data) {
        const key = /sec-websocket-key:\s*(\S+)/i.exec(data.toString())?.[1]
        if (!key) return
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        )
        if (options.stopReading) socket.pause()
      },
      close: () => void ended++,
    },
  })
  return {
    port: listener.port,
    ended: () => ended,
    stop() {
      for (const socket of sockets) socket.terminate()
      listener.stop(true)
    },
  }
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
    websocket: coreWebSocketHandler,
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
    resetLocalAppWebSocketRegistryForTests()
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
    return { id: localDeployment.id, token, appHost, squadId: row.id, sandboxId: localDeployment.sandboxId }
  }

  /** A relayed socket on the path mount, open and greeted by the app. */
  async function openRelayedSocket(id: string, token: string) {
    const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`), { headers: { origin: TENANT_ORIGIN } })
    await client.opened
    await client.nextMessages(1)
    return client
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

  it('applies the HTTP Authorization rules to the upgrade: the app bearer only on its own origin, never a Ficus credential', async () => {
    const appBearer = 'Bearer app-socket-token'
    const { id, token, appHost } = await runningDeployment()
    const appOrigin = (authorization: string) =>
      browser(coreUrl(id, 'socket', `_ficus_token=${token}`), {
        headers: { host: 'noah.ficus.sh', 'x-forwarded-host': appHost, origin: `https://${appHost}`, authorization },
      })
    const pathMount = () =>
      browser(coreUrl(id, 'socket', `_ficus_token=${token}`), {
        headers: { host: 'noah.ficus.sh', origin: TENANT_ORIGIN, authorization: appBearer },
      })
    // One at a time, so the app records the handshakes in this order.
    for (const open of [
      () => appOrigin(appBearer),
      () => appOrigin('Bearer ficus_sess_x'),
      () => appOrigin(`Bearer ${token}`),
      pathMount,
    ]) {
      const client = open()
      await client.opened
      await client.nextMessages(1)
    }

    expect(app.handshakes.map(({ headers }) => headers.authorization)).toEqual([
      appBearer,
      undefined,
      undefined,
      undefined,
    ])
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

  describe('closing sockets when access ends', () => {
    it('closes an open socket with 1001 when the deployment is stopped', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)
      expect(countLocalAppWebSockets(id)).toBe(1)

      await stopLocalDeploymentRecord(id)

      expect((await client.closed).code).toBe(1001)
      await waitFor(() => app.closes.length > 0)
      expect(countLocalAppWebSockets(id)).toBe(0)
    })

    it('closes an open socket with 1001 when the deployment is archived', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      await archiveLocalDeploymentRecord(id)

      expect((await client.closed).code).toBe(1001)
    })

    it("closes an open socket when its sandbox's deployments are marked stopped", async () => {
      const { id, token, sandboxId } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      await markLocalDeploymentsStoppedForSandbox(sandboxId)

      expect((await client.closed).code).toBe(1001)
    })

    it('closes an open socket with 1008 when the token rotates or is revoked', async () => {
      const { id, token } = await runningDeployment()
      const rotated = await openRelayedSocket(id, token)
      await db.update(localDeployments).set({ browserAccessToken: 'rotated-token' }).where(eq(localDeployments.id, id))
      // Every service write announces itself this way; a write that does not is caught by the sweep below.
      eventEmitter.emit('sandboxLocalDeployment.updated', { localDeploymentId: id, squadId: 'x', status: 'running' })
      expect((await rotated.closed).code).toBe(1008)

      const revoked = await openRelayedSocket(id, 'rotated-token')
      await db.update(localDeployments).set({ browserAccessToken: null }).where(eq(localDeployments.id, id))
      await revalidateAllLocalAppWebSockets()
      expect((await revoked.closed).code).toBe(1008)
    })

    it('closes an open socket with 1008 when the visibility changes', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      await db.update(localDeployments).set({ visibility: 'public' }).where(eq(localDeployments.id, id))
      await revalidateAllLocalAppWebSockets()

      const closed = await client.closed
      expect(closed.code).toBe(1008)
      expect(closed.reason).toBe('Access to the app changed')
    })

    it('closes an open socket when its squad is deleted (no event; the sweep finds it)', async () => {
      const { id, token, squadId } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      await db.delete(squads).where(eq(squads.id, squadId))
      await revalidateAllLocalAppWebSockets()

      expect((await client.closed).code).toBe(1001)
    })

    it('keeps sockets whose access is unchanged', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      await updateLocalDeploymentRecord(id, { restartCount: 1 })
      await revalidateAllLocalAppWebSockets()
      client.socket.send('still-here')

      expect((await client.nextMessages(2))[1]).toBe('echo:still-here')
      expect(client.socket.readyState).toBe(WebSocket.OPEN)
    })
  })

  it('refuses one socket more than the per-deployment cap with a marked 429', async () => {
    const { id, token } = await runningDeployment()
    configureLocalDeploymentProxyDependencies({
      resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.server.port! }),
      webSocketMaxSocketsPerDeployment: 2,
    })
    const first = await openRelayedSocket(id, token)
    await openRelayedSocket(id, token)

    const refused = await proxyLocalDeploymentRequest(
      id,
      upgradeRequest(coreUrl(id, 'socket', `_ficus_token=${token}`)),
      'socket',
      neverUpgrades
    )
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(app.handshakes).toHaveLength(2)

    // A closed socket frees its slot.
    first.socket.close()
    await waitFor(() => countLocalAppWebSockets(id) === 1)
    await openRelayedSocket(id, token)
  })

  it('closes relayed sockets with 1012 on shutdown and refuses new upgrades', async () => {
    const { id, token } = await runningDeployment()
    const client = await openRelayedSocket(id, token)

    await shutdownLocalAppWebSockets(20)

    const closed = await client.closed
    expect(closed.code).toBe(1012)
    expect(closed.reason).toBe('Ficus is restarting')
    await waitFor(() => app.closes.length > 0)
    const refused = await proxyLocalDeploymentRequest(
      id,
      upgradeRequest(coreUrl(id, 'socket', `_ficus_token=${token}`)),
      'socket',
      neverUpgrades
    )
    expect(refused.status).toBe(503)
  })

  describe('heartbeat', () => {
    it('closes both sides with 1011 when the app stops answering pings', async () => {
      const { id, token } = await runningDeployment()
      const silent = startSilentApp()
      try {
        configureLocalDeploymentProxyDependencies({
          resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: silent.port }),
          webSocketPingIntervalMs: 50,
        })
        const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`), { headers: { origin: TENANT_ORIGIN } })
        await client.opened

        const closed = await client.closed
        expect(closed.code).toBe(1011)
        expect(closed.reason).toBe('The local app stopped responding')
        await waitFor(() => silent.ended() === 1)
        expect(countLocalAppWebSockets(id)).toBe(0)
      } finally {
        silent.stop()
      }
    })

    it('keeps a socket open while the app answers pings', async () => {
      const { id, token } = await runningDeployment()
      configureLocalDeploymentProxyDependencies({
        resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: app.server.port! }),
        webSocketPingIntervalMs: 20,
      })
      const client = await openRelayedSocket(id, token)

      await Bun.sleep(150)

      expect(client.socket.readyState).toBe(WebSocket.OPEN)
      client.socket.send('after-pings')
      expect((await client.nextMessages(2))[1]).toBe('echo:after-pings')
    })
  })

  describe('backpressure', () => {
    it('pauses the app while the browser is not reading and delivers every frame once it reads again', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      // A browser that stops reading: more than Bun's 16 MiB per-socket buffer piles up toward it.
      ;(client.socket as WebSocket & { pause(): void }).pause()
      client.socket.send('flood')
      await Bun.sleep(500)
      expect(client.socket.readyState).toBe(WebSocket.OPEN)
      ;(client.socket as WebSocket & { resume(): void }).resume()

      const received = await Promise.race([
        client.nextMessages(1 + FLOOD_FRAMES),
        client.closed.then((event) => Promise.reject(new Error(`closed with ${event.code}`))),
      ])
      const frames = received.slice(1).map((frame) => new Uint8Array(frame as ArrayBuffer))
      expect(frames.map((frame) => frame.byteLength)).toEqual(Array(FLOOD_FRAMES).fill(FLOOD_FRAME_BYTES))
      expect(frames.map((frame) => frame[0])).toEqual([...Array(FLOOD_FRAMES).keys()])
      expect(client.socket.readyState).toBe(WebSocket.OPEN)
    }, 20_000)

    it('closes with 1013 instead of buffering without bound when the app stops reading', async () => {
      const { id, token } = await runningDeployment()
      const stuck = startSilentApp({ stopReading: true })
      try {
        configureLocalDeploymentProxyDependencies({
          resolveLocalDeploymentTarget: async () => ({ host: '127.0.0.1', port: stuck.port }),
        })
        const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}`), { headers: { origin: TENANT_ORIGIN } })
        await client.opened

        const frame = new Uint8Array(1024 * 1024)
        for (let sent = 0; sent < 40 && client.socket.readyState === WebSocket.OPEN; sent++) {
          client.socket.send(frame)
          await Bun.sleep(5)
        }

        const closed = await client.closed
        expect(closed.code).toBe(1013)
        expect(closed.reason).toBe('The local app is not reading fast enough')
      } finally {
        stuck.stop()
      }
    }, 20_000)

    it('closes with 1009 rather than relaying a frame over the payload limit', async () => {
      const { id, token } = await runningDeployment()
      const client = await openRelayedSocket(id, token)

      client.socket.send('too-big')

      expect((await client.closed).code).toBe(1009)
    }, 20_000)
  })

  it('logs opens, refusals and closes without the credential, cookies, query string or frames', async () => {
    const previousLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'debug'
    const lines: string[] = []
    const capture = (...args: unknown[]) => void lines.push(args.map((arg) => JSON.stringify(arg) ?? '').join(' '))
    const spies = [spyOn(console, 'log'), spyOn(console, 'warn'), spyOn(console, 'error')].map((spy) =>
      spy.mockImplementation(capture)
    )
    try {
      const { id, token } = await runningDeployment()
      const client = browser(coreUrl(id, 'socket', `_ficus_token=${token}&q=query-secret`), {
        headers: { origin: TENANT_ORIGIN, cookie: 'ficus_session=cookie-secret' },
      })
      await client.opened
      await client.nextMessages(1)
      client.socket.send('frame-secret')
      await client.nextMessages(2)
      client.socket.close(4001, 'reason-secret')
      await waitFor(() => countLocalAppWebSockets(id) === 0)
      const forbidden = browser(coreUrl(id, 'socket', `_ficus_token=${token}&q=query-secret`), {
        headers: { origin: 'https://mallory.ficus.sh', cookie: 'ficus_session=cookie-secret' },
      })
      await expect(forbidden.opened).rejects.toThrow('handshake failed')

      const relayLines = lines.filter((line) => line.includes('Local app WebSocket'))
      expect(relayLines.some((line) => line.includes('opened') && line.includes(id))).toBe(true)
      expect(relayLines.some((line) => line.includes('closed') && line.includes('4001'))).toBe(true)
      expect(relayLines.some((line) => line.includes('refused') && line.includes('forbidden-origin'))).toBe(true)
      for (const secret of [token, 'query-secret', 'cookie-secret', 'frame-secret', 'reason-secret']) {
        expect(lines.join('\n')).not.toContain(secret)
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
      if (previousLevel === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previousLevel
    }
  })
})
