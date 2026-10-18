import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { websocket as honoWebSocketHandler } from 'hono/bun'
import type { WSEvents } from 'hono/ws'
import { createLogger } from '../../lib/infra/logger'
import { isAllowedWsOrigin, normalizeOrigin } from '../auth/web-origins'
import { localDeploymentProxyError } from './local-deployment-proxy-response'
import {
  countLocalAppWebSockets,
  registerLocalAppWebSocket,
  unregisterLocalAppWebSocket,
  type LocalAppWebSocketCloseCategory,
  type LocalAppWebSocketRelay,
} from './local-deployment-websocket-registry'

const log = createLogger('local-deployment-websocket')

/** How long the app gets to answer the upgrade (the Platform bridge's connect timeout). */
export const LOCAL_APP_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000

/**
 * Seconds a browser socket may go without a frame or a pong before Bun closes
 * it. Bun pings the browser on its own (`sendPings`), so a live browser never
 * reaches it; a vanished one is closed within this window.
 */
export const LOCAL_APP_WEBSOCKET_IDLE_TIMEOUT_SECONDS = 120

/** Largest single frame a browser may send through Core, and the largest relayed from an app (16 MiB). */
export const LOCAL_APP_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

/**
 * Bytes Core holds for one direction of one relayed socket before it treats
 * the reader as stuck (16 MiB). Toward the browser, Bun queues up to this and
 * the relay pauses reading from the app until the browser drains; toward the
 * app, the client socket cannot hold the browser back, so going past it closes
 * the socket with 1013 rather than buffering without bound.
 */
export const LOCAL_APP_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * How often Core pings the app's side of a relayed socket. A ping still
 * unanswered at the next interval (no pong and no frame) means a half-open app
 * socket: both sides close, the browser's with 1011.
 */
export const LOCAL_APP_WEBSOCKET_PING_INTERVAL_MS = 30_000

/**
 * Open relayed sockets one deployment may hold at once (browser tabs times the
 * sockets each opens; dev-server HMR uses one or two per tab). One more is
 * refused with a marked 429.
 */
export const LOCAL_APP_WEBSOCKET_MAX_SOCKETS_PER_DEPLOYMENT = 50

/** Hono's socket events plus `onDrain`, which the relay needs for backpressure and Hono does not forward. */
export type RelayWebSocketEvents = WSEvents<ServerWebSocket> & { onDrain?(): void }

/**
 * Core's Bun.serve `websocket` option (index.ts): Hono's shared handler, which
 * dispatches each socket to the `events` in its data, plus `drain` and the
 * limits above passed explicitly. Bun applies them to every WebSocket on the
 * server; the values are Bun's own defaults except where they are documented
 * otherwise, so Core's other sockets behave as before.
 */
export const coreWebSocketHandler: WebSocketHandler<{ events: RelayWebSocketEvents }> = {
  ...(honoWebSocketHandler as unknown as WebSocketHandler<{ events: RelayWebSocketEvents }>),
  drain(ws) {
    ws.data.events.onDrain?.()
  },
  idleTimeout: LOCAL_APP_WEBSOCKET_IDLE_TIMEOUT_SECONDS,
  maxPayloadLength: LOCAL_APP_WEBSOCKET_MAX_PAYLOAD_BYTES,
  backpressureLimit: LOCAL_APP_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES,
  closeOnBackpressureLimit: false,
  sendPings: true,
}

/**
 * The slice of Bun's server a WebSocket upgrade needs. Core's Bun.serve hands it
 * to Hono as `c.env` (index.ts); {@link coreWebSocketHandler} dispatches every
 * socket to the `events` in its data.
 */
export interface WebSocketUpgradeServer {
  upgrade(request: Request, options: { headers?: HeadersInit; data: { events: WSEvents } }): boolean
}

/** Why an upgrade was refused, as logged (never the request's URL, headers or credential). */
export type LocalAppWebSocketRefusal =
  | 'not-found'
  | 'unsupported-visibility'
  | 'unauthorized'
  | 'forbidden-origin'
  | 'no-upgrade-server'
  | 'at-capacity'
  | 'shutting-down'
  | 'app-refused'
  | 'upgrade-failed'

/** Debug log for a refused upgrade: deployment, status and category only. */
export function logLocalAppWebSocketRefusal(
  localDeploymentId: string,
  status: number,
  category: LocalAppWebSocketRefusal
): void {
  log.debug('Local app WebSocket refused', { localDeploymentId, status, category })
}

/** Handshake headers each hop negotiates for itself (Bun's client and server write their own). */
const HANDSHAKE_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'sec-websocket-protocol',
]

function headerTokens(request: Request, name: string): string[] {
  return (request.headers.get(name) ?? '').toLowerCase().split(/[\s,]+/)
}

/**
 * A WebSocket handshake (RFC 6455 4.1: a GET with `Upgrade: websocket` that
 * `Connection` names). Anything else, a stray Upgrade header included, stays an
 * ordinary proxied request with its hop-by-hop headers stripped.
 */
export function isWebSocketUpgradeRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    headerTokens(request, 'upgrade').includes('websocket') &&
    headerTokens(request, 'connection').includes('upgrade')
  )
}

/**
 * Whether the handshake's Origin may open a socket to this app. A WebSocket is
 * not gated by CORS, and the app credential rides as a SameSite=Lax cookie that
 * the browser also sends from any same-SITE page: every other app on the apps
 * domain and every other tenant on the Ficus domain (neither is a public suffix).
 * An ordinary HTTP request from such a page cannot read the answer; a socket
 * could. So a browser handshake must come from an origin the app is served on:
 * on a per-app origin one of the app's own hosts (its id host, and its alias
 * host while it has one), or on the path mount a Ficus web origin (the path
 * mount shares it). A missing Origin is a non-browser client, which holds the
 * credential itself.
 */
export function isAllowedLocalAppWebSocketOrigin(origin: string | null, appHosts: readonly string[] | null): boolean {
  if (!origin) return true
  if (appHosts) {
    const normalized = normalizeOrigin(origin)
    return appHosts.some((appHost) => normalized === `https://${appHost}`)
  }
  return isAllowedWsOrigin(origin)
}

/** A close code a server may send (RFC 6455 7.4); 1005/1006/1015 only describe a close. */
function sendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
}

/** A close code a client may send: the WebSocket API accepts only 1000 and 3000-4999. */
function clientCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

/** Bun's WebSocket client, which adds flow control and pings to the browser API. */
type BunClientWebSocket = WebSocket & {
  pause(): void
  resume(): void
  ping(): void
  terminate(): void
}

/** Opens the app's socket, or null when it refused or never answered. */
function connectUpstream(
  url: URL,
  headers: Headers,
  protocols: string[],
  timeoutMs: number
): Promise<BunClientWebSocket | null> {
  return new Promise((resolve) => {
    // Bun's client takes request headers, Host included (the app sees its own host).
    const socket = new WebSocket(url, { headers, protocols } as unknown as string[]) as BunClientWebSocket
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => {
      socket.close()
      resolve(null)
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function frameBytes(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

/** The refusal an upgrade gets when its relay was closed while the app was still answering. */
const REFUSAL_FOR_CLOSE: Record<number, [number, LocalAppWebSocketRefusal]> = {
  1001: [404, 'not-found'],
  1008: [403, 'unauthorized'],
  1012: [503, 'shutting-down'],
}

/** How a close Core starts reaches the app: a close handshake, or none for an app that stopped answering. */
type UpstreamClose = 'close' | 'terminate'

/**
 * Relay a WebSocket upgrade to the app. The caller has already authorized the
 * request and computed the headers the app may see (cookies, host, client
 * address: the same rules as HTTP); only the handshake's own headers are
 * rebuilt here.
 *
 * The app's socket opens first, so a refusal is answered as a refused upgrade
 * (a marked 502) instead of an accepted socket that closes at once, and the
 * subprotocol the app chose is the one the browser gets: a browser that offered
 * subprotocols fails a handshake that names none.
 *
 * While open, the relay:
 * - is registered under its deployment (local-deployment-websocket-registry.ts),
 *   which closes it when the access that authorized it ends; one more than
 *   {@link LOCAL_APP_WEBSOCKET_MAX_SOCKETS_PER_DEPLOYMENT} is refused (429);
 * - never drops a frame silently: toward the browser it stops reading from the
 *   app while Bun reports backpressure and resumes on drain, and closes both
 *   sides with 1013 if Bun still refuses a frame; toward the app (whose client
 *   socket cannot hold the browser back) it closes with 1013 once
 *   {@link LOCAL_APP_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES} is queued;
 * - pings the app every {@link LOCAL_APP_WEBSOCKET_PING_INTERVAL_MS} and closes
 *   both sides (1011 to the browser) when a ping is still unanswered at the next.
 *
 * Logged at debug: open, refusal and close, with the deployment id, close code
 * and a fixed category; never the URL, headers, credential, a close reason or a frame.
 */
export async function proxyLocalAppWebSocket(input: {
  server: WebSocketUpgradeServer
  request: Request
  targetUrl: URL
  headers: Headers
  /** The deployment and the credential that authorized this upgrade (re-checked while the socket is open). */
  access: { localDeploymentId: string; token: string }
  connectTimeoutMs?: number
  pingIntervalMs?: number
  maxSocketsPerDeployment?: number
}): Promise<Response> {
  const { server, request, targetUrl, headers } = input
  const { localDeploymentId, token } = input.access
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  for (const name of HANDSHAKE_HEADERS) headers.delete(name)
  const upstreamUrl = new URL(targetUrl)
  upstreamUrl.protocol = 'ws:'

  let upstream: BunClientWebSocket | null = null
  let browser: ServerWebSocket | null = null
  /** A close Core started (revocation, backpressure, heartbeat, shutdown), applied to whichever sides exist. */
  let closing: { code: number; reason: string; category: LocalAppWebSocketCloseCategory } | null = null
  let finished = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let upstreamPaused = false
  let backpressured = false
  let awaitingPong = false

  const finish = (code: number, category: LocalAppWebSocketCloseCategory) => {
    if (finished) return
    finished = true
    if (heartbeat) clearInterval(heartbeat)
    const open = unregisterLocalAppWebSocket(relay)
    log.debug('Local app WebSocket closed', { localDeploymentId, code, category, open })
  }

  const closeBoth = (
    code: number,
    reason: string,
    category: LocalAppWebSocketCloseCategory,
    upstreamClose: UpstreamClose = 'close'
  ) => {
    if (closing || finished) return
    closing = { code, reason, category }
    if (browser && browser.readyState === WebSocket.OPEN) browser.close(code, reason)
    if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
      if (upstreamClose === 'terminate') upstream.terminate()
      else upstream.close(clientCloseCode(code), reason)
    }
    // With the app's side open but the browser's not yet, onOpen applies the close and finishes.
    if (browser || !upstream) finish(code, category)
  }

  const relay: LocalAppWebSocketRelay = { localDeploymentId, token, close: closeBoth }
  const registration = registerLocalAppWebSocket(
    relay,
    input.maxSocketsPerDeployment ?? LOCAL_APP_WEBSOCKET_MAX_SOCKETS_PER_DEPLOYMENT
  )
  if (registration === 'at-capacity') {
    logLocalAppWebSocketRefusal(localDeploymentId, 429, 'at-capacity')
    return localDeploymentProxyError('Too many open WebSocket connections to this app', 429)
  }
  if (registration === 'shutting-down') {
    logLocalAppWebSocketRefusal(localDeploymentId, 503, 'shutting-down')
    return localDeploymentProxyError('Ficus is restarting', 503)
  }

  const socket = await connectUpstream(
    upstreamUrl,
    headers,
    protocols,
    input.connectTimeoutMs ?? LOCAL_APP_WEBSOCKET_CONNECT_TIMEOUT_MS
  )
  if (!socket) {
    finished = true
    unregisterLocalAppWebSocket(relay)
    logLocalAppWebSocketRefusal(localDeploymentId, 502, 'app-refused')
    return localDeploymentProxyError('The local app did not accept the WebSocket upgrade', 502)
  }
  upstream = socket
  // Access ended (or Core began shutting down) while the app was answering.
  const closedWhileConnecting = closing as { code: number } | null
  if (closedWhileConnecting) {
    socket.close()
    const [status, category] = REFUSAL_FOR_CLOSE[closedWhileConnecting.code] ?? [503, 'shutting-down']
    logLocalAppWebSocketRefusal(localDeploymentId, status, category)
    return localDeploymentProxyError('The app is no longer available', status)
  }
  // Nothing is read from the app until the browser's side is open to take it.
  socket.pause()
  upstreamPaused = true

  /** Forward one app frame; false when the relay closed instead. */
  const toBrowser = (ws: ServerWebSocket, data: string | ArrayBuffer): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false
    if (frameBytes(data) > LOCAL_APP_WEBSOCKET_MAX_PAYLOAD_BYTES) {
      closeBoth(1009, 'Message too big', 'message-too-big')
      return false
    }
    const status = ws.send(data)
    if (status === 0) {
      closeBoth(1013, 'The browser is not reading fast enough', 'browser-backpressure')
      return false
    }
    if (status === -1) {
      backpressured = true
      if (!upstreamPaused) {
        socket.pause()
        upstreamPaused = true
      }
    }
    return true
  }

  // Frames and a close from the app before the browser's side is open are held for it
  // (bounded: reading is paused until then, so only frames already read can arrive).
  const early: Array<string | ArrayBuffer> = []
  let earlyClose: CloseEvent | null = null
  const closeBrowserFromApp = (ws: ServerWebSocket, event: CloseEvent) => {
    if (sendableCloseCode(event.code)) ws.close(event.code, event.reason)
    else if (event.code === 1005) ws.close()
    else ws.close(1011, 'The local app closed the connection')
    finish(event.code, 'app-closed')
  }
  socket.addEventListener('message', (event) => {
    awaitingPong = false
    if (browser) toBrowser(browser, event.data as string | ArrayBuffer)
    else early.push(event.data as string | ArrayBuffer)
  })
  socket.addEventListener('pong', () => {
    awaitingPong = false
  })
  socket.addEventListener('close', (event) => {
    if (closing) return
    if (browser) closeBrowserFromApp(browser, event)
    else earlyClose = event
  })

  const pingIntervalMs = input.pingIntervalMs ?? LOCAL_APP_WEBSOCKET_PING_INTERVAL_MS
  const events: RelayWebSocketEvents = {
    onOpen(_event, ws) {
      const raw = ws.raw!
      browser = raw
      if (closing) {
        raw.close(closing.code, closing.reason)
        return finish(closing.code, closing.category)
      }
      log.debug('Local app WebSocket opened', { localDeploymentId, open: countLocalAppWebSockets(localDeploymentId) })
      for (const data of early.splice(0)) if (!toBrowser(raw, data)) return
      if (earlyClose) return closeBrowserFromApp(raw, earlyClose)
      if (!backpressured) {
        socket.resume()
        upstreamPaused = false
      }
      heartbeat = setInterval(() => {
        // While paused for the browser a pong cannot be read; the browser side has Bun's own pings.
        if (upstreamPaused) return
        if (awaitingPong) return closeBoth(1011, 'The local app stopped responding', 'app-heartbeat', 'terminate')
        awaitingPong = true
        socket.ping()
      }, pingIntervalMs)
    },
    onMessage(event, _ws) {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(event.data as string | ArrayBuffer)
      if (socket.bufferedAmount > LOCAL_APP_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES) {
        closeBoth(1013, 'The local app is not reading fast enough', 'app-backpressure')
      }
    },
    onClose(event, _ws) {
      browser = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(clientCloseCode(event.code), event.reason)
      }
      finish(event.code, closing?.category ?? 'browser-closed')
    },
    onDrain() {
      backpressured = false
      if (upstreamPaused && !closing) {
        socket.resume()
        upstreamPaused = false
      }
    },
  }
  const upgradeHeaders = new Headers()
  if (socket.protocol) upgradeHeaders.set('sec-websocket-protocol', socket.protocol)
  if (server.upgrade(request, { headers: upgradeHeaders, data: { events: events as WSEvents } })) {
    // Bun answers 101 itself; the returned response is discarded (as with Hono's helper).
    return new Response(null)
  }
  socket.close()
  finished = true
  unregisterLocalAppWebSocket(relay)
  logLocalAppWebSocketRefusal(localDeploymentId, 400, 'upgrade-failed')
  log.warn('Local app WebSocket upgrade failed after the app accepted it')
  return localDeploymentProxyError('WebSocket upgrade failed', 400)
}
