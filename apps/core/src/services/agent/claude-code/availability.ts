/**
 * Whether agents may use the user's own Claude Code (`claude`) as a model backend.
 *
 * Anthropic permits an end user to sign in to the unmodified Claude Code program with their own
 * Claude subscription; it does not permit a product to collect, store, or route requests through
 * those credentials. So Claude Code is offered only where Core runs on the user's own machine
 * (never a Ficus Cloud instance), as an Anthropic account the owner turns on, and Core only ever
 * runs `claude` and reads its sign-in STATUS. It never reads, copies, or stores the credential,
 * and sign-in happens in Claude Code's own `claude auth login` flow.
 */
import { createLogger } from '../../../lib/infra/logger'
import { claudeCodeAccount } from './account'

const log = createLogger('claude-code')

export interface ClaudeCodeStatus {
  /** This deployment can offer Claude Code: Core runs on the user's machine, not Ficus Cloud. */
  offered: boolean
  /** The owner turned Claude Code on: its Anthropic account exists and is enabled. */
  enabled: boolean
  /** Path of the `claude` executable, when found. */
  executable?: string
  version?: string
  loggedIn: boolean
  /** How `claude` is signed in: 'claude.ai' for a subscription. */
  authMethod?: string
  subscriptionType?: string
  /** Why agents cannot use it right now, for Settings. */
  reason?: string
}

/** Ficus Cloud hosts Core on Ficus machines; Claude Code there is not offered. */
export function claudeCodeOffered(env: Record<string, string | undefined> = process.env): boolean {
  return env.FICUS_MANAGED !== '1'
}

/** The `claude` executable: the first on PATH or in Claude Code's install locations. */
export function findClaudeExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  return Bun.which('claude', { PATH: claudeSearchPath(env) }) ?? undefined
}

/** PATH plus the locations Claude Code's installers use; a desktop app does not inherit a login shell's PATH. */
function claudeSearchPath(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? ''
  return [env.PATH, `${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(':')
}

export type RunClaude = (executable: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>

const runClaude: RunClaude = async (executable, args) => {
  const child = Bun.spawn([executable, ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
    env: claudeChildEnv(),
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { exitCode, stdout }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The environment `claude` runs with. Never Core's own: that carries Core's secrets, and an
 * ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN there would silently switch Claude
 * Code off the user's subscription.
 */
export function claudeChildEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {}
): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'CLAUDE_CONFIG_DIR']
  const child: Record<string, string> = { PATH: claudeSearchPath(env) }
  for (const name of keep) if (env[name]) child[name] = env[name]!
  return { ...child, ...extra }
}

let cached: { at: number; status: ClaudeCodeStatus } | undefined
const STATUS_TTL_MS = 60_000

type StatusOptions = {
  refresh?: boolean
  env?: Record<string, string | undefined>
  run?: RunClaude
  enabled?: boolean
}

/** Current Claude Code status. Cached briefly: model selection asks on every agent start. */
export async function getClaudeCodeStatus(options: StatusOptions = {}): Promise<ClaudeCodeStatus> {
  const injected = options.env !== undefined || options.run !== undefined || options.enabled !== undefined
  if (!options.refresh && !injected && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status
  const status = await readStatus(
    options.env ?? process.env,
    options.run ?? runClaude,
    options.enabled ?? accountEnabled()
  )
  if (!injected) cached = { at: Date.now(), status }
  return status
}

function accountEnabled(): boolean {
  try {
    return claudeCodeAccount()?.enabled === true
  } catch {
    // No account store yet (early startup): the status still reports sign-in.
    return false
  }
}

/** Whether `claude` can serve a turn now: offered here, installed and signed in. */
export async function claudeCodeUsable(): Promise<boolean> {
  const status = await getClaudeCodeStatus()
  return status.offered && status.loggedIn
}

/**
 * The same, synchronously from the last status, for account selection. A stale status is refreshed
 * in the background; until the first check completes, Claude Code counts as not ready.
 */
export function claudeCodeReady(): boolean {
  if (!claudeCodeOffered()) return false
  if (!cached || Date.now() - cached.at >= STATUS_TTL_MS) void getClaudeCodeStatus().catch(() => {})
  return cached?.status.loggedIn === true
}

/** Forget the cached status, so the next read runs `claude` again. */
export function invalidateClaudeCodeStatus() {
  cached = undefined
}

export function setClaudeCodeStatusForTests(status: ClaudeCodeStatus | undefined) {
  cached = status ? { at: Date.now(), status } : undefined
}

async function readStatus(
  env: Record<string, string | undefined>,
  run: RunClaude,
  enabled: boolean
): Promise<ClaudeCodeStatus> {
  if (!claudeCodeOffered(env))
    return { offered: false, enabled: false, loggedIn: false, reason: 'Not available on Ficus Cloud' }
  const executable = findClaudeExecutable(env)
  if (!executable) return { offered: true, enabled, loggedIn: false, reason: 'Claude Code is not installed' }
  try {
    const version = (await run(executable, ['--version'])).stdout.trim().split(/\s+/)[0]
    const result = await run(executable, ['auth', 'status', '--json'])
    // Only these fields are read; the status output never carries the credential itself.
    const parsed = JSON.parse(result.stdout || '{}') as {
      loggedIn?: unknown
      authMethod?: unknown
      subscriptionType?: unknown
    }
    const loggedIn = parsed.loggedIn === true
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
    const subscriptionType = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined
    const reason = !loggedIn ? 'Claude Code is not signed in' : !enabled ? 'Turned off' : undefined
    return {
      offered: true,
      enabled,
      executable,
      ...(version ? { version } : {}),
      loggedIn,
      ...(authMethod ? { authMethod } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(reason ? { reason } : {}),
    }
  } catch (error) {
    log.warn('Could not read Claude Code status', error)
    return { offered: true, enabled, executable, loggedIn: false, reason: 'Could not run Claude Code' }
  }
}
