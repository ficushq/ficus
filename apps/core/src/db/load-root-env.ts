import { existsSync } from 'fs'
import { join } from 'path'
import dotenv from 'dotenv'

/**
 * Load the repo-root `.env` into `process.env` for STANDALONE entrypoints
 * (`bun run src/db/run-migrations.ts` and siblings) that run outside the
 * systemd services.
 *
 * Why this exists: the long-running services get their environment from
 * systemd's `EnvironmentFile=`, so they never need this. But the setup
 * toolkit invokes standalone scripts as `(cd apps/core && bun run …)` with a
 * bare environment, expecting the rendered root `.env` to supply
 * `DATABASE_URL` — and bun only auto-loads `.env` from the CURRENT working
 * directory, not from a workspace member's parent. The old
 * `drizzle-kit migrate` path loaded the root file explicitly in
 * drizzle.config.ts; when run-migrations.ts replaced it, that load was
 * silently dropped and tenant provisioning broke fleet-wide (2026-08-13).
 *
 * Semantics, deliberately:
 *  - NEVER overrides a variable that is already set — an operator's explicit
 *    `DATABASE_URL=… bun run db:migrate` must always win over the file
 *    (dotenv's default; `override` is not passed).
 *  - A missing file is a no-op, not an error: dev machines and CI inject the
 *    environment directly and often have no root `.env` at all.
 *  - Returns which keys the file supplied (post-precedence), so a caller or
 *    test can distinguish "loaded from file" from "already present".
 */
function loadRootEnvInto(rootDir: string, environment: Record<string, string | undefined>): string[] {
  const envPath = join(rootDir, '.env')
  if (!existsSync(envPath)) return []
  const fileEnvironment: Record<string, string | undefined> = {}
  const result = dotenv.config({ path: envPath, quiet: true, processEnv: fileEnvironment })
  if (result.error || !result.parsed) return []
  const supplied: string[] = []
  for (const [key, value] of Object.entries(fileEnvironment)) {
    if (value === undefined || environment[key] !== undefined) continue
    environment[key] = value
    supplied.push(key)
  }
  return supplied
}

export function loadRootEnvForStandaloneScript(rootDir: string): string[] {
  return loadRootEnvInto(rootDir, process.env)
}

/**
 * Resolve the root file's DATABASE_URL in isolation. This uses the exact same
 * dotenv loading path as standalone scripts without allowing an explicitly
 * supplied process value to hide which database the root file identifies.
 */
export function resolveRootEnvDatabaseUrl(rootDir: string): string | undefined {
  const rootEnvironment: Record<string, string | undefined> = {}
  loadRootEnvInto(rootDir, rootEnvironment)
  return rootEnvironment.DATABASE_URL
}
