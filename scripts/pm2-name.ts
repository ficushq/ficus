#!/usr/bin/env bun
/**
 * Prints this checkout's pm2 app name for `api` or `worker`.
 *
 * The root pm2 scripts call it as `$(bun scripts/pm2-name.ts api)` instead of
 * expanding `${FICUS_PM2_API_NAME:-tau-api}` in the shell: `bun run` does NOT
 * export the checkout's .env into the script shell, so a shell expansion would
 * silently address the default instance's apps from a labelled checkout.
 * `bun <file>` does auto-load the cwd's .env into its own process.env, so this
 * one-line process sees FICUS_PM2_API_NAME / FICUS_PM2_WORKER_NAME.
 */
import '../apps/cli/src/boot/legacy-env'
const arg = process.argv[2]
if (arg !== 'api' && arg !== 'worker') {
  process.stderr.write(`usage: bun scripts/pm2-name.ts <api|worker>\n`)
  process.exit(2)
}
const fromEnv = arg === 'api' ? process.env.FICUS_PM2_API_NAME : process.env.FICUS_PM2_WORKER_NAME
process.stdout.write(fromEnv || (arg === 'api' ? 'tau-api' : 'tau-worker'))
