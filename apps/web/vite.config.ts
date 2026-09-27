import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'
import { DEV_ACCESS_COOKIE, DEV_ACCESS_HEADER, requestHasDevAccess, stripDevAccessCookie } from './devAccess'
import { fnv1a } from './src/theme/fnv'

const DEV_BACKEND_CONTROL_PATH = '/__tau_dev'
const DEV_ACCESS_LOGIN_PATH = `${DEV_BACKEND_CONTROL_PATH}/login`
const LOCAL_BACKEND_LABEL = '@local'
const DEFAULT_LOCAL_API_URL = 'http://localhost:3000'
const SAFE_REMOTE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SAFE_REMOTE_POST_PATHS = new Set(['/api/auth/ws-ticket'])

interface CliBackend {
  apiUrl: string
  password: string
}

interface DevBackend {
  label: string
  apiUrl: string
  password?: string
  isProduction: boolean
}

interface MutableDevProxyState {
  selectedLabel: string
  productionWritesEnabled: boolean
  apiProxyOptions?: ProxyOptions
  wsProxyOptions?: ProxyOptions
}

function cliAuthStorePath(): string {
  return process.env.FICUS_DEV_AUTH_STORE_PATH ?? ''
}

function readCliBackends(): Record<string, CliBackend> {
  const authPath = cliAuthStorePath()
  if (!authPath) return {}
  if (!existsSync(authPath)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read Ficus CLI auth store at ${authPath}: ${(error as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object') return {}
  const rawBackends = (parsed as { backends?: unknown }).backends
  if (!rawBackends || typeof rawBackends !== 'object' || Array.isArray(rawBackends)) return {}

  const backends: Record<string, CliBackend> = {}
  for (const [label, value] of Object.entries(rawBackends)) {
    if (!value || typeof value !== 'object') continue
    const backend = value as { apiUrl?: unknown; password?: unknown }
    if (typeof backend.apiUrl !== 'string' || typeof backend.password !== 'string') continue
    try {
      const parsedUrl = new URL(backend.apiUrl.replace(/\/+$/, ''))
      if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) continue
      const apiUrl = parsedUrl.toString().replace(/\/$/, '')
      if (!isLoopbackApiUrl(apiUrl) && parsedUrl.protocol !== 'https:') continue
      backends[label] = { apiUrl, password: backend.password }
    } catch {
      // The CLI validates these when writing the store. Ignore a hand-edited bad row
      // instead of preventing all local frontend development.
    }
  }
  return backends
}

function isLoopbackApiUrl(apiUrl: string): boolean {
  const hostname = new URL(apiUrl).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function selectedDevBackend(state: MutableDevProxyState): DevBackend {
  if (state.selectedLabel === LOCAL_BACKEND_LABEL) {
    return { label: LOCAL_BACKEND_LABEL, apiUrl: DEFAULT_LOCAL_API_URL, isProduction: false }
  }

  const backend = readCliBackends()[state.selectedLabel]
  if (!backend) throw new Error(`Unknown Ficus CLI backend '${state.selectedLabel}'`)
  return {
    label: state.selectedLabel,
    ...backend,
    isProduction: !isLoopbackApiUrl(backend.apiUrl),
  }
}

function publicDevBackendState(state: MutableDevProxyState) {
  const selected = selectedDevBackend(state)
  const cliBackends = readCliBackends()
  return {
    selectedLabel: selected.label,
    apiUrl: selected.apiUrl,
    isProduction: selected.isProduction,
    productionWritesEnabled: selected.isProduction && state.productionWritesEnabled,
    backends: [
      { label: LOCAL_BACKEND_LABEL, apiUrl: DEFAULT_LOCAL_API_URL, isProduction: false },
      ...Object.entries(cliBackends).map(([label, backend]) => ({
        label,
        apiUrl: backend.apiUrl,
        isProduction: !isLoopbackApiUrl(backend.apiUrl),
      })),
    ],
  }
}

function setProxyTargets(state: MutableDevProxyState): void {
  const target = selectedDevBackend(state).apiUrl
  if (state.apiProxyOptions) state.apiProxyOptions.target = target
  if (state.wsProxyOptions) state.wsProxyOptions.target = target
}

function requestComesFromVite(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function endJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function endHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  )
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readBody(req)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return parsed as Record<string, unknown>
}

function devAccessLoginPage(invalid = false): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ficus Dev Access</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #09090b; color: #fafafa; }
      main { width: min(24rem, calc(100vw - 3rem)); }
      p { color: #a1a1aa; line-height: 1.5; }
      label { display: grid; gap: .5rem; font-weight: 600; }
      input, button { box-sizing: border-box; width: 100%; border-radius: .5rem; padding: .75rem; font: inherit; }
      input { border: 1px solid #52525b; background: #18181b; color: inherit; }
      button { margin-top: .75rem; border: 0; background: #7c3aed; color: white; font-weight: 700; cursor: pointer; }
      .error { color: #fca5a5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Ficus dev access</h1>
      <p>Enter the access token printed by <code>bun run dev:web</code>.</p>
      ${invalid ? '<p class="error" role="alert">That token is not valid.</p>' : ''}
      <form method="post" action="${DEV_ACCESS_LOGIN_PATH}">
        <label>Access token <input name="token" type="password" required autofocus autocomplete="current-password" /></label>
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`
}

function requestUsesHttps(req: IncomingMessage): boolean {
  const forwardedProto = req.headers['x-forwarded-proto']
  const firstProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim()
  return firstProto === 'https' || Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted)
}

function stripDevAccessCredential(req: IncomingMessage): void {
  delete req.headers[DEV_ACCESS_HEADER]
  const cookie = stripDevAccessCookie(req.headers.cookie)
  if (cookie) req.headers.cookie = cookie
  else delete req.headers.cookie
}

function devAccessPlugin(accessToken: string): Plugin {
  return {
    name: 'ficus-dev-access',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const hasAccess = requestHasDevAccess(req.headers, accessToken)

          if (pathname === DEV_ACCESS_LOGIN_PATH) {
            if (req.method === 'GET') {
              if (hasAccess) {
                res.statusCode = 303
                res.setHeader('Location', '/')
                return res.end()
              }
              return endHtml(res, 200, devAccessLoginPage())
            }

            if (req.method === 'POST') {
              const submittedToken = new URLSearchParams(await readBody(req)).get('token') ?? undefined
              if (!requestHasDevAccess({ [DEV_ACCESS_HEADER]: submittedToken }, accessToken)) {
                return endHtml(res, 401, devAccessLoginPage(true))
              }
              const secure = requestUsesHttps(req) ? '; Secure' : ''
              res.statusCode = 303
              res.setHeader(
                'Set-Cookie',
                `${DEV_ACCESS_COOKIE}=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Strict${secure}`
              )
              res.setHeader('Cache-Control', 'no-store')
              res.setHeader('Location', '/')
              return res.end()
            }

            return endJson(res, 405, { error: 'Method not allowed' })
          }

          if (!hasAccess) {
            const acceptsHtml = req.method === 'GET' && req.headers.accept?.includes('text/html')
            if (acceptsHtml) {
              res.statusCode = 303
              res.setHeader('Cache-Control', 'no-store')
              res.setHeader('Location', DEV_ACCESS_LOGIN_PATH)
              return res.end()
            }
            return endJson(res, 401, { error: 'Ficus dev access token required' })
          }

          stripDevAccessCredential(req)
          return next()
        } catch (error) {
          return endJson(res, 400, { error: (error as Error).message })
        }
      })

      return () => {
        const httpServer = server.httpServer
        if (!httpServer) return
        const upgradeListeners = httpServer.listeners('upgrade')
        httpServer.removeAllListeners('upgrade')
        httpServer.on('upgrade', (req, socket, head) => {
          if (!requestHasDevAccess(req.headers, accessToken)) {
            // Clients commonly reset a rejected upgrade before reading the 401.
            // Handle that expected socket error so it cannot crash the dev server.
            socket.on('error', () => {})
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            return
          }
          for (const listener of upgradeListeners) listener.call(httpServer, req, socket, head)
        })
      }
    },
  }
}

function devBackendControlPlugin(state: MutableDevProxyState): Plugin {
  return {
    name: 'ficus-dev-backend-control',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(DEV_BACKEND_CONTROL_PATH)) return next()
        if (!requestComesFromVite(req)) return endJson(res, 403, { error: 'Cross-origin dev control denied' })

        try {
          const pathname = new URL(req.url, 'http://localhost').pathname
          if (req.method === 'GET' && pathname === `${DEV_BACKEND_CONTROL_PATH}/state`) {
            return endJson(res, 200, publicDevBackendState(state))
          }

          if (req.method === 'POST' && pathname === `${DEV_BACKEND_CONTROL_PATH}/backend`) {
            const body = await readJsonBody(req)
            if (typeof body.label !== 'string') return endJson(res, 400, { error: 'Missing backend label' })
            const previousLabel = state.selectedLabel
            state.selectedLabel = body.label
            try {
              selectedDevBackend(state)
            } catch (error) {
              state.selectedLabel = previousLabel
              throw error
            }
            state.productionWritesEnabled = false
            setProxyTargets(state)
            return endJson(res, 200, publicDevBackendState(state))
          }

          if (req.method === 'POST' && pathname === `${DEV_BACKEND_CONTROL_PATH}/production-writes`) {
            const body = await readJsonBody(req)
            if (typeof body.enabled !== 'boolean') return endJson(res, 400, { error: 'Missing enabled flag' })
            const selected = selectedDevBackend(state)
            state.productionWritesEnabled = selected.isProduction && body.enabled
            return endJson(res, 200, publicDevBackendState(state))
          }

          return endJson(res, 404, { error: 'Unknown dev control endpoint' })
        } catch (error) {
          return endJson(res, 400, { error: (error as Error).message })
        }
      })
    },
  }
}

function blockRemoteProxyRequest(req: IncomingMessage, res: ServerResponse | undefined, state: MutableDevProxyState) {
  const selected = selectedDevBackend(state)
  if (!selected.isProduction) return

  if (!requestComesFromVite(req)) {
    if (!res) return false
    endJson(res, 403, { error: 'Cross-origin production proxy request denied' })
    return req.url
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (
    !state.productionWritesEnabled &&
    !SAFE_REMOTE_METHODS.has(method) &&
    !(method === 'POST' && SAFE_REMOTE_POST_PATHS.has(pathname))
  ) {
    if (!res) return false
    endJson(res, 403, {
      error: 'Production writes are disabled in the local dev UI. Enable production writes in the dev bar first.',
    })
    return req.url
  }
}

function devProxyOptions(kind: 'api' | 'ws', state: MutableDevProxyState, accessToken?: string): ProxyOptions {
  const options: ProxyOptions = {
    target: selectedDevBackend(state).apiUrl,
    changeOrigin: true,
    ws: kind === 'ws',
    bypass: (req, res) => blockRemoteProxyRequest(req, res, state),
    configure(proxy, runtimeOptions) {
      if (kind === 'api') state.apiProxyOptions = runtimeOptions
      else state.wsProxyOptions = runtimeOptions

      if (kind === 'api') {
        const productionRequests = new WeakSet<IncomingMessage>()
        proxy.on('proxyReq', (proxyReq, req) => {
          const selected = selectedDevBackend(state)
          if (!selected.isProduction) return
          productionRequests.add(req)
          proxyReq.removeHeader('cookie')
          proxyReq.removeHeader('authorization')
          if (selected.password) proxyReq.setHeader('Authorization', `Bearer ${selected.password}`)
        })
        proxy.on('proxyRes', (proxyRes, req) => {
          if (productionRequests.has(req)) delete proxyRes.headers['set-cookie']
        })
      } else {
        proxy.on('proxyReqWs', (proxyReq, req, socket) => {
          if (accessToken && !requestHasDevAccess(req.headers, accessToken)) {
            proxyReq.destroy()
            socket.destroy()
            return
          }
          stripDevAccessCredential(req)
          const selected = selectedDevBackend(state)
          if (!selected.isProduction) return
          proxyReq.removeHeader('cookie')
          proxyReq.removeHeader('authorization')
          proxyReq.setHeader('Origin', new URL(selected.apiUrl).origin)
        })
      }
    },
  }
  return options
}

/**
 * Build id baked into the SW and page bundle as __FICUS_SW_CACHE_VERSION__.
 * Must be stable for identical source (so rebuilding the same commit never
 * prompts users to update) and unique per distinct build otherwise.
 */
function resolveBuildId(): string {
  if (process.env.FICUS_BUILD_ID) return process.env.FICUS_BUILD_ID
  try {
    const git = (cmd: string) =>
      execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    const sha = git('git rev-parse --short=12 HEAD')
    const dirty = git('git status --porcelain').length > 0
    // A dirty tree can produce different bundles for the same SHA, so make each build unique.
    return dirty ? `${sha}.${Date.now()}` : sha
  } catch {
    return `${Date.now()}`
  }
}

/**
 * Hash of index.css's + builtins.css's own content (the two files that
 * define every built-in theme's own token values), baked in as
 * __TAU_BUILTIN_CSS_FINGERPRINT__ (theme/builtinFingerprint.ts). Unlike
 * resolveBuildId (which changes on every commit — right for SW cache
 * versioning, wrong here), this changes ONLY when these two files' content
 * changes, so a persisted resolved-theme snapshot (custom.ts) stays valid
 * across unrelated deploys and is invalidated exactly when it should be.
 * generate-theme-flash.ts computes the SAME hash from the SAME files for the
 * separately-bundled pre-paint script, so both agree on the value for a
 * given source tree without either needing to run inside the other's build.
 */
function computeBuiltinCssFingerprint(): string {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')
  const builtinsCss = readFileSync(path.resolve(process.cwd(), 'src/theme/builtins.css'), 'utf8')
  return fnv1a(`${indexCss}\u0000${builtinsCss}`)
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, path.resolve(process.cwd(), '../..'), ['VITE_', 'APP_'])
  const deployedBase = env.APP_BASE_PATH ? env.APP_BASE_PATH.replace(/\/?$/, '/') : '/'
  /** Local `vite` only: serve at / so proxy + client origin match; preview/build keep APP_BASE_PATH. */
  const isViteDev = command === 'serve' && mode === 'development'
  const base = isViteDev ? '/' : deployedBase
  const proxyRoot = isViteDev ? '' : deployedBase.replace(/\/?$/, '')
  const serviceWorkerCacheVersion = resolveBuildId()
  const builtinCssFingerprint = computeBuiltinCssFingerprint()
  const devAccessToken = isViteDev ? process.env.FICUS_DEV_ACCESS_TOKEN?.trim() : undefined
  const devBackendState: MutableDevProxyState = {
    selectedLabel: isViteDev ? (process.env.FICUS_DEV_BACKEND ?? LOCAL_BACKEND_LABEL) : LOCAL_BACKEND_LABEL,
    productionWritesEnabled: false,
  }
  // Fail at startup with the requested label, before Vite starts serving a UI
  // that could misleadingly appear connected to some other backend.
  if (isViteDev) selectedDevBackend(devBackendState)

  return {
    base,
    define: {
      __FICUS_SW_CACHE_VERSION__: JSON.stringify(serviceWorkerCacheVersion),
      __TAU_BUILTIN_CSS_FINGERPRINT__: JSON.stringify(builtinCssFingerprint),
      __TAU_APP_URL__: JSON.stringify(env.APP_URL || ''),
      __TAU_APP_BASE_PATH__: JSON.stringify(env.APP_BASE_PATH || ''),
      __TAU_DEV_BACKEND_BAR__: JSON.stringify(isViteDev),
    },
    plugins: [
      ...(devAccessToken ? [devAccessPlugin(devAccessToken)] : []),
      ...(isViteDev ? [devBackendControlPlugin(devBackendState)] : []),
      react(),
      // The built index.html keeps __TAU_ORIGIN__ for the server to fill in
      // (apps/core/src/lib/web-serve.ts). The dev server serves the file itself,
      // so blank it there: relative og:* values are harmless in development.
      {
        name: 'ficus-origin-placeholder',
        transformIndexHtml: {
          order: 'pre' as const,
          handler(html: string, ctx: { server?: unknown }) {
            return ctx.server ? html.replaceAll('__TAU_ORIGIN__', '') : html
          },
        },
      },
      VitePWA({
        // 'prompt' gives the app explicit control over WHEN an update is applied, so we
        // can refresh aggressively on open/resume without reloading mid-interaction.
        registerType: 'prompt',
        // Registration is done directly in lib/serviceWorker.ts; never inject a
        // second (auto-update-flavored) register script.
        injectRegister: false,
        strategies: 'injectManifest',
        injectManifest: {
          // The app chunk has been precached near this size for a while (the
          // theme token system plus ordinary main growth pushed it just past
          // 4 MiB). Keep offline behavior unchanged by allowing a little more
          // headroom instead of dropping the app chunk from the precache.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // The link-preview image is for crawlers, not the offline shell.
          globIgnores: ['**/voice/dtln/dtln.js', '**/social-preview.png'],
        },
        srcDir: 'src',
        filename: 'sw.ts',
        manifest: {
          name: 'Ficus - AI Task Management',
          short_name: 'Ficus',
          description: 'A workspace for teams of AI agents.',
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'portrait-primary',
          // Match the dark launch splash (splash.html) so install-time chrome
          // doesn't flash violet/light-gray; runtime chrome color comes from
          // the dynamic theme-color meta.
          background_color: '#04050a',
          theme_color: '#0d0e18',
          icons: [
            { src: 'icons/icon-72x72.png', sizes: '72x72', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-96x96.png', sizes: '96x96', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-128x128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-144x144.png', sizes: '144x144', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-384x384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: 'icons/icon-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          categories: ['productivity', 'utilities'],
          shortcuts: [
            {
              name: 'Feed',
              short_name: 'Feed',
              url: './',
              description: 'View the feed',
              icons: [{ src: 'icons/shortcut-feed.png', sizes: '96x96' }],
            },
            {
              name: 'Squads',
              short_name: 'Squads',
              url: './squads',
              description: 'View and manage squads',
              icons: [{ src: 'icons/shortcut-squads.png', sizes: '96x96' }],
            },
            {
              name: 'Chat',
              short_name: 'Chat',
              url: './chat',
              description: 'Chat with AI assistant',
              icons: [{ src: 'icons/shortcut-chat.png', sizes: '96x96' }],
            },
          ],
        },
        devOptions: {
          enabled: false, // set true if you want SW in dev
          type: 'module',
        },
      }),
    ],
    server: {
      port: 5173,
      allowedHosts: env.VITE_ALLOWED_HOSTS?.split(',') || [],
      proxy: {
        [`${proxyRoot}/api`]: isViteDev
          ? devProxyOptions('api', devBackendState, devAccessToken)
          : { target: DEFAULT_LOCAL_API_URL, changeOrigin: true },
        [`${proxyRoot}/ws`]: isViteDev
          ? devProxyOptions('ws', devBackendState, devAccessToken)
          : { target: DEFAULT_LOCAL_API_URL, ws: true },
      },
    },
  }
})
