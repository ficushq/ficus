import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { devProxy } from './devProxy'

/**
 * The garden is served by Core at `<APP_BASE_PATH>/garden/`, beside the web UI
 * (apps/core/src/lib/web-serve.ts). The dev server keeps the `/garden/` prefix
 * so every URL the app builds is the same shape in development and production.
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, path.resolve(process.cwd(), '../..'), ['VITE_', 'APP_', 'FICUS_'])
  const appBase = (env.APP_BASE_PATH ?? '').replace(/\/+$/, '')
  const base = command === 'serve' && mode === 'development' ? '/garden/' : `${appBase}/garden/`

  return {
    base,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: devProxy({ ...env, ...process.env }),
    },
    build: { outDir: 'dist', emptyOutDir: true },
  }
})
