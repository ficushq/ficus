/**
 * Executor auth — optional shared-token gate for the sandbox server.
 *
 * On the VM runtime, boxes are per-sandbox unix users co-located on a shared
 * machine, and the executor server used to be reachable by ANY local user on
 * that machine (bind 0.0.0.0, no auth): a co-tenant box could connect to
 * 127.0.0.1:<port> of a sibling box and execute /bash AS that box user. The
 * box-manager now bakes a per-box `EXECUTOR_AUTH_TOKEN` into the box's 0600
 * `server.env` (siblings cannot read it) and core's SandboxClient presents it
 * as a bearer token on every request.
 *
 * Enforcement is CONDITIONAL on the env var being present:
 *  - k8s pods never set EXECUTOR_AUTH_TOKEN → behavior is unchanged there
 *    (pod networking + NetworkPolicy is that runtime's boundary), and
 *  - a VM box whose server.env predates the token keeps working until its next
 *    re-provision delivers one (safe rollout, no ordering deadlock).
 *
 * `GET /healthz` is deliberately exempt: readiness probes (box-manager health
 * poll, SandboxClient.waitForReady) run unauthenticated, and health exposes no
 * execution or file surface.
 */

import { timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'

export function loadExecutorAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): string | undefined {
  const literal = env.EXECUTOR_AUTH_TOKEN
  const file = env.EXECUTOR_AUTH_TOKEN_FILE
  if (literal && file) throw new Error('Executor auth token sources are ambiguous')
  if (!file) return literal || undefined
  let value: string
  try {
    value = readFile(file).trimEnd()
  } catch (cause) {
    throw new Error('Unable to read executor auth token file', { cause })
  }
  if (!value || value.length > 4096) throw new Error('Invalid executor auth token file')
  return value
}

/** Extract the bearer token from a request's Authorization header, if any. */
export function extractBearerToken(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/**
 * Whether a request may pass the auth gate.
 *
 * - `expectedToken` unset/empty → ALWAYS authorized (enforcement off; the k8s
 *   runtime and legacy VM boxes whose server.env carries no token).
 * - `expectedToken` set → the request must carry `Authorization: Bearer
 *   <token>` with a token that matches byte-for-byte (constant-time compare).
 */
export function isAuthorized(headers: Headers, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true
  const provided = extractBearerToken(headers)
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expectedToken)
  return a.length === b.length && timingSafeEqual(a, b)
}
