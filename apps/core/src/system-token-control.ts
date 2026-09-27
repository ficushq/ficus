#!/usr/bin/env bun
/**
 * Root-only system-token control, bundled as `dist/system-token-control.js` so
 * it exists on an artifact install. The control plane runs it over SSH as root,
 * without sudo, from the Core install directory, where Bun loads Core's
 * root-only `.env` (the database URL):
 *
 *   FICUS_STC_ACTION=reissue-platform-orchestrator bun current/apps/core/dist/system-token-control.js
 *
 * Contract (the control plane's `reissue_system_token` job parses it):
 * - stdout is exactly `FICUS_SYSTEM_TOKEN=<raw>\nFICUS_SYSTEM_TOKEN_REVOKED=<n>\n`
 *   and nothing else; every log line goes to stderr, and the raw token is never
 *   logged, passed in argv or placed in the environment
 * - exit 0 ok, 2 usage (unknown or missing action, any argument), 1 failure
 *   (including a non-root caller of the shipped bundle)
 * - every run is a full re-issue: it mints one new `platform-orchestrator` token
 *   and revokes every other live one, so a retry after a lost reply supersedes
 *   the earlier run and leaves exactly one live token (the last one printed)
 *
 * There is no HTTP route to this. It reads only `FICUS_*` names (no legacy-env
 * bridge): only the control plane calls it, and only on migrated hosts.
 */
import { SYSTEM_TOKEN_PREFIX } from './services/auth/token-prefixes'

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export const REISSUE_PLATFORM_ORCHESTRATOR = 'reissue-platform-orchestrator'
const USAGE = `usage: FICUS_STC_ACTION=${REISSUE_PLATFORM_ORCHESTRATOR} bun system-token-control.js (no arguments)`

export class SystemTokenControlUsageError extends Error {}

export function parseSystemTokenControlRequest(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): { action: typeof REISSUE_PLATFORM_ORCHESTRATOR } {
  if (argv.length > 0) throw new SystemTokenControlUsageError(`${USAGE}: unexpected argument`)
  const action = env.FICUS_STC_ACTION
  if (action !== REISSUE_PLATFORM_ORCHESTRATOR) {
    throw new SystemTokenControlUsageError(
      action ? `${USAGE}: unknown FICUS_STC_ACTION ${JSON.stringify(action)}` : `${USAGE}: FICUS_STC_ACTION is not set`
    )
  }
  return { action }
}

/**
 * Why this process must not run, or null. The shipped bundle (`.js`) runs only
 * for root. This is defence in depth, not the security boundary: the boundary is
 * the database credential, which only root can read on a tenant host (anyone who
 * has it could insert a token row directly). The TypeScript source is ungated so
 * tests and dev checkouts can run it; artifacts ship no `src/`.
 */
export function rootRefusal(entryPath: string, euid: number | undefined): string | null {
  if (entryPath.endsWith('.ts')) return null
  if (euid === 0) return null
  return `system-token-control must run as root (effective uid ${euid ?? 'unknown'})`
}

const TOKEN_PATTERN = new RegExp(`^${SYSTEM_TOKEN_PREFIX}[A-Za-z0-9_-]+$`)

export function formatReissueOutput(result: { token: string; revoked: number }): string {
  if (!TOKEN_PATTERN.test(result.token)) throw new Error('re-issued token has an unexpected shape')
  if (!Number.isSafeInteger(result.revoked) || result.revoked < 0) throw new Error('invalid revoked count')
  return `FICUS_SYSTEM_TOKEN=${result.token}\nFICUS_SYSTEM_TOKEN_REVOKED=${result.revoked}\n`
}

/**
 * Point every logging path at stderr, so the only bytes on stdout are the
 * markers (written straight to fd 1 through `Bun.stdout`). Runs before any
 * module that logs is loaded.
 */
function routeLogsToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
}

async function main(): Promise<number> {
  routeLogsToStderr()
  const refusal = rootRefusal(import.meta.path, process.geteuid?.())
  if (refusal) {
    console.error(refusal)
    return EXIT_FAILURE
  }
  try {
    parseSystemTokenControlRequest(process.env, process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    return EXIT_USAGE
  }
  // Loaded only after the request validates: the database connects as it loads.
  const { reissuePlatformOrchestratorToken } = await import('./services/auth/system-tokens')
  const result = await reissuePlatformOrchestratorToken()
  await Bun.write(Bun.stdout, formatReissueOutput(result))
  return EXIT_OK
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(EXIT_FAILURE)
    })
}
