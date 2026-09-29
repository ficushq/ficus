import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { devProxy, devWriteGuard, resolveDevBackend } from './devProxy'

/**
 * The farm is served by Core at `<APP_BASE_PATH>/farm/`, beside the web UI
 * (apps/core/src/lib/web-serve.ts). The dev server keeps the `/farm/` prefix
 * so every URL the app builds is the same shape in development and production.
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, path.resolve(process.cwd(), '../..'), ['VITE_', 'APP_', 'FICUS_'])
  const appBase = (env.APP_BASE_PATH ?? '').replace(/\/+$/, '')
  const base = command === 'serve' && mode === 'development' ? '/farm/' : `${appBase}/farm/`

  const isDev = command === 'serve'
  const backend = isDev ? resolveDevBackend({ ...env, ...process.env }) : null
  if (backend?.bearer) {
    console.log(`Farm dev backend: ${backend.label} (${backend.target})${backend.writes ? '' : ', read-only'}`)
  }

  return {
    base,
    plugins: [react(), ...(backend ? [devWriteGuard(backend)] : [])],
    server: {
      host: '127.0.0.1',
      // FICUS_FARM_PORT runs a second dev server (e.g. against another backend) beside the first.
      port: Number(process.env.FICUS_FARM_PORT) || 5174,
      strictPort: true,
      // Extra hostnames to answer to, e.g. a `tailscale serve` name (same variable the web dev server reads).
      allowedHosts: env.VITE_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [],
      proxy: backend ? devProxy({ ...env, ...process.env }, backend) : undefined,
    },
    build: { outDir: 'dist', emptyOutDir: true },
  }
})
