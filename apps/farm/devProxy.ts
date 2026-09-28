import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ProxyOptions } from 'vite'

type Env = Record<string, string | undefined>

/**
 * Where `bun run dev:farm` sends /api and /ws.
 *
 * - Default: local Core on :3000 with the browser's own session cookie (sign
 *   in once on the web app; cookies ignore the port).
 * - `FICUS_FARM_BACKEND=<label>`: a backend from the CLI auth store
 *   (the CLI's own path, or `FICUS_DEV_AUTH_STORE_PATH`), authenticated with its device token the
 *   way `dev:web` does for remote backends. Such backends are READ-ONLY
 *   unless `FICUS_FARM_ALLOW_WRITES=1`, so pointing the farm at a real
 *   instance can't approve, answer or message anything by accident.
 *   `FICUS_API_URL` overrides the stored URL (e.g. the loopback port).
 */
export interface DevBackend {
  label: string
  target: string
  bearer?: string
  writes: boolean
}

export function resolveDevBackend(env: Env): DevBackend {
  const label = env.FICUS_FARM_BACKEND?.trim()
  if (!label) {
    return { label: 'local', target: trimSlash(env.FICUS_API_URL || 'http://localhost:3000'), writes: true }
  }
  const storePath = cliAuthStorePath(env)
  if (!existsSync(storePath)) {
    throw new Error(`FICUS_FARM_BACKEND=${label}: no CLI auth store at ${storePath} (set FICUS_DEV_AUTH_STORE_PATH)`)
  }
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    backends?: Record<string, { apiUrl?: unknown; password?: unknown }>
  }
  const backend = store.backends?.[label]
  if (!backend || typeof backend.apiUrl !== 'string' || typeof backend.password !== 'string') {
    throw new Error(`No CLI backend named "${label}" in the auth store`)
  }
  return {
    label,
    target: trimSlash(env.FICUS_API_URL || backend.apiUrl),
    bearer: backend.password,
    writes: env.FICUS_FARM_ALLOW_WRITES === '1',
  }
}

/** Same resolution as the CLI (apps/cli/src/auth-store.ts): FICUS_AUTH_STORE, else ~/.tau/cli/auth.json. */
export function cliAuthStorePath(env: Env): string {
  const explicit = env.FICUS_DEV_AUTH_STORE_PATH || env.FICUS_AUTH_STORE
  const path = explicit || join(homedir(), '.tau', 'cli', 'auth.json')
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** The origin Core already trusts for browser WebSocket handshakes (cookie mode only). */
export function devTrustedOrigin(env: Env): string {
  return trimSlash(env.FICUS_WEB_ORIGIN?.split(',')[0] || 'http://localhost:5173')
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** The one write read-only mode still allows: minting a socket ticket, so live updates work. */
const READ_ONLY_ALLOWED_WRITES = new Set(['/api/auth/ws-ticket'])

export function isBlockedWrite(backend: DevBackend, method: string | undefined, url: string | undefined): boolean {
  if (backend.writes) return false
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return false
  const path = (url ?? '').split('?')[0]
  return path.startsWith('/api') && !READ_ONLY_ALLOWED_WRITES.has(path)
}

/** Refuses writes before they reach the proxy when the backend is read-only. */
export function devWriteGuard(backend: DevBackend): Plugin {
  return {
    name: 'farm-dev-write-guard',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!isBlockedWrite(backend, req.method, req.url)) return next()
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            error: `The farm dev server is read-only against "${backend.label}". Set FICUS_FARM_ALLOW_WRITES=1 to allow changes.`,
          })
        )
      })
    },
  }
}

export function devProxy(env: Env, backend: DevBackend = resolveDevBackend(env)): Record<string, ProxyOptions> {
  const { target, bearer } = backend
  const origin = devTrustedOrigin(env)
  return {
    '/api': {
      target,
      changeOrigin: true,
      configure(proxy) {
        if (!bearer) return
        proxy.on('proxyReq', (proxyReq) => {
          // A bearer request carrying no Origin is a CLI-style client to Core's CSRF check.
          proxyReq.removeHeader('cookie')
          proxyReq.removeHeader('origin')
          proxyReq.removeHeader('referer')
          proxyReq.setHeader('Authorization', `Bearer ${bearer}`)
        })
        proxy.on('proxyRes', (proxyRes) => {
          delete proxyRes.headers['set-cookie']
        })
      },
    },
    '/ws': {
      target,
      ws: true,
      changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReqWs', (proxyReq) => {
          if (bearer) {
            proxyReq.removeHeader('cookie')
            proxyReq.removeHeader('origin')
          } else {
            proxyReq.setHeader('Origin', origin)
          }
        })
      },
    },
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
