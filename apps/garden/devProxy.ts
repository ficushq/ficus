import type { ProxyOptions } from 'vite'

/** Local Core API the garden dev server proxies to (`FICUS_API_URL` overrides). */
export function devApiTarget(env: Record<string, string | undefined>): string {
  return (env.FICUS_API_URL || 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * The origin Core already trusts for browser WebSocket handshakes. Outside
 * production Core only auto-allows the web dev server (localhost:5173), and the
 * garden dev server runs on another port, so its `/ws` upgrade is re-sent with
 * that origin. The garden dev server binds to loopback only.
 */
export function devTrustedOrigin(env: Record<string, string | undefined>): string {
  return (env.FICUS_WEB_ORIGIN?.split(',')[0] || 'http://localhost:5173').replace(/\/$/, '')
}

export function devProxy(env: Record<string, string | undefined>): Record<string, ProxyOptions> {
  const target = devApiTarget(env)
  const origin = devTrustedOrigin(env)
  return {
    '/api': { target, changeOrigin: true },
    '/ws': {
      target,
      ws: true,
      changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('Origin', origin))
      },
    },
  }
}
