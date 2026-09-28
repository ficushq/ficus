const path = require('path')
const BUN_PTY_LIB = path.join(
  __dirname,
  'node_modules/bun-pty/rust-pty/target/release',
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'librust_pty_arm64.dylib'
      : 'librust_pty.dylib'
    : process.platform === 'win32'
      ? 'rust_pty.dll'
      : process.arch === 'arm64'
        ? 'librust_pty_arm64.so'
        : 'librust_pty.so'
)

// API and worker run from monorepo root to load the shared .env file.
// Web runs from apps/web (vite preview doesn't need env vars).
module.exports = {
  apps: [
    {
      name: 'tau-api',
      cwd: './',
      script: 'bun',
      args: 'run apps/core/dist/index.js',
      interpreter: 'none',
      watch: false,
      env: {
        NODE_ENV: 'production',
        // PORT and WORKER_PORT come from .env (bun auto-loads it from the repo root cwd).
        // Uncomment after running `bun run build:web` to serve the web UI from tau-api on PORT.
        // FICUS_SERVE_WEB: '1',
        // System log streaming reads from PM2 by default in this deployment. Keep these
        // names aligned with the PM2 app names below if you customize them.
        FICUS_SYSTEM_LOG_PROVIDER: 'pm2',
        FICUS_PM2_API_NAME: 'tau-api',
        FICUS_PM2_WORKER_NAME: 'tau-worker',
        BUN_PTY_LIB,
        FORCE_COLOR: 1,
      },
    },
    {
      name: 'tau-worker',
      cwd: './',
      script: 'bun',
      args: 'run apps/core/dist/worker.js',
      interpreter: 'none',
      watch: false,
      env: {
        NODE_ENV: 'production',
        // PORT and WORKER_PORT come from .env (bun auto-loads it from the repo root cwd).
        MAX_CONCURRENT_AGENTS: 10,
        BUN_PTY_LIB,
        FORCE_COLOR: 1,
      },
    },
    // {
    //   name: 'tau-web',
    //   cwd: './apps/web',
    //   script: 'node_modules/.bin/vite',
    //   args: 'preview --port 5173',
    //   interpreter: 'none',
    //   watch: false,
    //   env: {
    //     NODE_ENV: 'production',
    //   },
    // },
  ],
}
