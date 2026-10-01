import type { ServerWebSocket } from 'bun'
import type { WSContext, WSEvents } from 'hono/ws'
import { createLogger } from '../../lib/infra/logger'
import { isAllowedWsOrigin, normalizeOrigin } from '../auth/web-origins'
import { localDeploymentProxyError } from './local-deployment-proxy-response'

const log = createLogger('local-deployment-websocket')

/** How long the app gets to answer the upgrade (the Platform bridge's connect timeout). */
export const LOCAL_APP_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000

/**
 * The slice of Bun's server a WebSocket upgrade needs. Core's Bun.serve hands it
 * to Hono as `c.env` (index.ts); its shared `websocket` handler from `hono/bun`
 * dispatches every socket to the `events` in its data, which is the shape used
 * here, so the relay needs no handler of its own in index.ts.
 */
export interface WebSocketUpgradeServer {
  upgrade(request: Request, options: { headers?: HeadersInit; data: { events: WSEvents } }): boolean
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
 * could. So a browser handshake must come from the origin the app is served on:
 * its own origin, or on the path mount a Ficus web origin (the path mount shares
 * it). A missing Origin is a non-browser client, which holds the credential itself.
 */
export function isAllowedLocalAppWebSocketOrigin(origin: string | null, appHost: string | null): boolean {
  if (!origin) return true
  if (appHost) return normalizeOrigin(origin) === `https://${appHost}`
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

/** Opens the app's socket, or null when it refused or never answered. */
function connectUpstream(
  url: URL,
  headers: Headers,
  protocols: string[],
  timeoutMs: number
): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    // Bun's client takes request headers, Host included (the app sees its own host).
    const socket = new WebSocket(url, { headers, protocols } as unknown as string[])
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
 */
export async function proxyLocalAppWebSocket(input: {
  server: WebSocketUpgradeServer
  request: Request
  targetUrl: URL
  headers: Headers
  connectTimeoutMs?: number
}): Promise<Response> {
  const { server, request, targetUrl, headers } = input
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  for (const name of HANDSHAKE_HEADERS) headers.delete(name)
  const upstreamUrl = new URL(targetUrl)
  upstreamUrl.protocol = 'ws:'

  const socket = await connectUpstream(
    upstreamUrl,
    headers,
    protocols,
    input.connectTimeoutMs ?? LOCAL_APP_WEBSOCKET_CONNECT_TIMEOUT_MS
  )
  if (!socket) return localDeploymentProxyError('The local app did not accept the WebSocket upgrade', 502)

  // Frames and a close from the app before the browser's side is open are held for it.
  let browser: WSContext<ServerWebSocket> | null = null
  const early: Array<string | ArrayBuffer> = []
  let earlyClose: CloseEvent | null = null
  const closeBrowser = (ws: WSContext<ServerWebSocket>, event: CloseEvent) => {
    if (sendableCloseCode(event.code)) ws.close(event.code, event.reason)
    else if (event.code === 1005) ws.close()
    else ws.close(1011, 'The local app closed the connection')
  }
  socket.addEventListener('message', (event) => {
    if (browser) browser.send(event.data as string | ArrayBuffer)
    else early.push(event.data as string | ArrayBuffer)
  })
  socket.addEventListener('close', (event) => {
    if (browser) closeBrowser(browser, event)
    else earlyClose = event
  })

  const events: WSEvents<ServerWebSocket> = {
    onOpen(_event, ws) {
      browser = ws
      for (const data of early.splice(0)) ws.send(data)
      if (earlyClose) closeBrowser(ws, earlyClose)
    },
    onMessage(event, _ws) {
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data as string | ArrayBuffer)
    },
    onClose(event, _ws) {
      browser = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(clientCloseCode(event.code), event.reason)
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
  log.warn('Local app WebSocket upgrade failed after the app accepted it')
  return localDeploymentProxyError('WebSocket upgrade failed', 400)
}
