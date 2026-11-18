import { userInfo } from 'node:os'

/** The pool that admits heavy box work, and the key it had before it was renamed. */
const POOL = 'heavy-work'
const FORMER_POOL = 'shared-box-intensive'

/** Runtime identity, never CI/NODE_ENV/test-mode flags, determines admission.
 * The OS account also catches an accidentally stripped VM-box environment.
 * This is an accident guard for repository tooling, not a hostile-shell boundary.
 */
export function isFicusTestRuntime(env: NodeJS.ProcessEnv, username: string): boolean {
  return Boolean(
    env.FICUS_SANDBOX_ID || env.FICUS_BOX_HOME || env.FICUS_AGENT_CONTEXT === '1' || /^box_[a-f0-9]{12}$/.test(username)
  )
}

/** Check existing native capacity immediately before DB work. Never acquire,
 * renew, subscribe, or cache a grant: a borrower must still own capacity now.
 * The server derives callerClaim from the authenticated actor, filters expired
 * claims using its DB clock, and scopes the projection to the requested squad.
 */
export function requireTestDbCapacity(env = process.env, username = userInfo().username): void {
  if (!isFicusTestRuntime(env, username)) return
  const refuse = (outcome: string, detail: string): never => {
    throw new Error(`[test-db capacity: ${outcome}] ${detail} No test database work was started.`)
  }
  if (!env.FICUS_SQUAD_ID || !env.FICUS_TOKEN || !env.FICUS_API_URL) {
    refuse('unavailable', 'Runtime squad/agent identity is missing; cannot verify native capacity.')
  }

  // `undefined` means the CLI answered that it cannot show this pool (a clean
  // nonzero exit). A stalled or killed CLI throws instead, so the deadline is
  // spent once, not once per key.
  const query = (key: string): unknown => {
    const result = Bun.spawnSync(['ficus', '--json', 'slot', 'list', key, '--squad', env.FICUS_SQUAD_ID!], {
      // Force injected-agent auth, with no saved human backend fallback.
      env: { ...env, FICUS_AGENT_CONTEXT: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
      killSignal: 'SIGKILL',
    })
    if (result.signalCode || result.exitCode === null) throw new Error('capacity query stalled')
    if (result.exitCode !== 0) return undefined
    return JSON.parse(result.stdout.toString())
  }
  // A squad that has not renamed its pool yet still answers under the former
  // key. Only a refused lookup falls back: any answer for POOL is authoritative.
  let pool: unknown
  let key = POOL
  try {
    pool = query(POOL)
    if (pool === undefined) {
      key = FORMER_POOL
      pool = query(FORMER_POOL)
    }
    if (pool === undefined) throw new Error('capacity query failed')
  } catch {
    // CLI diagnostics can contain credentials or API URLs; never relay them.
    refuse('unavailable', 'Could not verify native capacity; inspect ficus slot list before retrying.')
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  if (!record(pool) || pool.key !== key || pool.squadId !== env.FICUS_SQUAD_ID || typeof pool.enabled !== 'boolean') {
    return refuse('unavailable', 'Native capacity returned an invalid pool projection.')
  }
  if (!pool.enabled) {
    console.log('[test-db capacity: disabled] Pool is not enforced; no capacity was claimed or queued.')
    return
  }
  if (pool.callerClaim !== undefined) {
    const claim = pool.callerClaim
    if (!record(claim) || !nonempty(claim.id) || !nonempty(claim.ownerAgentId) || !nonempty(claim.expiresAt)) {
      return refuse('unavailable', 'Native capacity returned an invalid claim.')
    }
    const expires = Date.parse(claim.expiresAt)
    if (!Number.isFinite(expires)) refuse('unavailable', 'Native capacity returned an invalid claim.')
    if (expires <= Date.now()) refuse('expired', 'The native claim has expired; do not start protected work.')
    console.log('[test-db capacity: granted] Reusing the caller-owned native claim; release it after cleanup.')
    return
  }
  if (record(pool.callerWaiter) && nonempty(pool.callerWaiter.id)) {
    refuse('queued', 'YOU DO NOT OWN CAPACITY YET. Wait for the native slot grant.')
  }
  refuse('unavailable', `No live caller-owned claim. Run ficus slot claim ${key}; proceed only when granted.`)
}
