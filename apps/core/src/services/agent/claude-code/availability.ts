/**
 * Whether agents may use the user's own Claude Code (`claude`) as a model backend.
 *
 * Anthropic permits an end user to sign in to the unmodified Claude Code program with their own
 * Claude subscription; it does not permit a product to collect, store, or route requests through
 * those credentials. So Claude Code is offered only where Core runs on the user's own machine
 * (not a Ficus Cloud instance unless the platform opts that tenant in with FICUS_CLAUDE_CODE=1), as
 * an Anthropic account the owner turns on, and Core only ever
 * runs `claude` and reads its sign-in STATUS. It never reads, copies, or stores the credential,
 * and sign-in happens in Claude Code's own `claude auth login` flow.
 */
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { createLogger } from '../../../lib/infra/logger'
import { claudeCodeAccount } from './account'

const log = createLogger('claude-code')

export interface ClaudeCodeStatus {
  /** This deployment can offer Claude Code: Core runs on the user's machine, or an opted-in tenant. */
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
  /**
   * When `claude auth status` could not be read (no JSON: it crashed, printed an error, or could not
   * start): its exit code and the start of what it printed, for Settings and the log.
   */
  detail?: string
  /** Every `claude` found, newest-first choice aside, so a wrong or stale install is visible. */
  candidates?: string[]
}

/**
 * Ficus Cloud hosts Core on Ficus machines, where Claude Code is not offered unless that tenant is
 * explicitly opted in with FICUS_CLAUDE_CODE=1 (Claude Code is then installed and signed in on the
 * tenant host, for the tenant's own owner).
 */
export function claudeCodeOffered(env: Record<string, string | undefined> = process.env): boolean {
  return env.FICUS_MANAGED !== '1' || env.FICUS_CLAUDE_CODE === '1'
}

/** The first `claude` on PATH or in Claude Code's install locations. */
export function findClaudeExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  return Bun.which('claude', { PATH: claudeSearchPath(env) }) ?? undefined
}

/** Every distinct `claude` on PATH and in Claude Code's install locations. */
export function claudeExecutableCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  for (const dir of claudeSearchPath(env).split(':')) {
    if (!dir) continue
    const path = Bun.which('claude', { PATH: dir })
    if (!path) continue
    let real = path
    try {
      real = realpathSync(path)
    } catch {
      // Keep the unresolved path.
    }
    if (seen.has(real)) continue
    seen.add(real)
    found.push(path)
  }
  return found
}

/** The `claude` agents run: the newest one found by the last status check, else the first on PATH. */
export function claudeCodeExecutable(): string | undefined {
  return cached?.status.executable ?? findClaudeExecutable()
}

function versionOf(output: string): number[] | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : undefined
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** PATH plus the locations Claude Code's installers use; a desktop app does not inherit a login shell's PATH. */
function claudeSearchPath(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? ''
  return [env.PATH, `${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(':')
}

export type RunClaude = (
  executable: string,
  args: string[]
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>

const runClaude: RunClaude = async (executable, args) => {
  const child = Bun.spawn([executable, ...args], {
    stdout: 'pipe',
    // Read for diagnostics only: `auth status` never prints the credential.
    stderr: 'pipe',
    stdin: 'ignore',
    env: claudeChildEnv(),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 15_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr: timedOut ? `Timed out after 15s. ${stderr}` : stderr }
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
  // On macOS Claude Code finds its sign-in in the Keychain under $USER; without it, a signed-in
  // `claude` reports signed out. Ficus Desktop starts Core without USER, so ask the OS.
  const user = child.USER ?? child.LOGNAME ?? currentUser()
  if (user) {
    child.USER ??= user
    child.LOGNAME ??= user
  }
  return { ...child, ...extra }
}

let osUser: string | null | undefined

function currentUser(): string | undefined {
  if (osUser === undefined) osUser = loginName() ?? null
  return osUser ?? undefined
}

/**
 * The account's login name. Not `os.userInfo()` alone: Bun's reads $USER and says "unknown" without
 * it, and `claude` would then look up the Keychain sign-in of a user named "unknown".
 */
export function loginName(
  id: () => string = () => {
    const result = Bun.spawnSync(['/usr/bin/id', '-un'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    return result.exitCode === 0 ? result.stdout.toString() : ''
  },
  info: () => string = () => userInfo().username
): string | undefined {
  for (const read of [id, info]) {
    try {
      const name = read().trim()
      if (name && name !== 'unknown') return name
    } catch {
      // Try the next source.
    }
  }
  return undefined
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

/**
 * Make account selection see a current status. Selection is synchronous and reads the cache, so an
 * agent start must wait for it here while a Claude Code account is enabled: otherwise the first start
 * after boot (or within a minute of signing in) would skip the account as not signed in.
 */
export async function primeClaudeCodeStatus(
  options: { env?: Record<string, string | undefined>; run?: RunClaude } = {}
): Promise<void> {
  const env = options.env ?? process.env
  if (!claudeCodeOffered(env) || !accountEnabled()) return
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return
  try {
    cached = { at: Date.now(), status: await readStatus(env, options.run ?? runClaude, true) }
  } catch {
    // An unreadable status leaves the account unusable; selection fails over.
  }
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
  // Several installs can coexist (native installer, npm, Homebrew, the Claude desktop app), and a
  // background worker's PATH can differ from the user's shell. Run the newest.
  const candidates = claudeExecutableCandidates(env)
  if (!candidates.length) {
    log.info('Claude Code not found', { searched: claudeSearchPath(env) })
    return { offered: true, enabled, loggedIn: false, reason: 'Claude Code is not installed' }
  }
  let executable = candidates[0]!
  let version: string | undefined
  let best: number[] | undefined
  for (const candidate of candidates) {
    const parsed = versionOf((await run(candidate, ['--version']).catch(() => ({ stdout: '' }))).stdout)
    if (parsed && (!best || newer(parsed, best))) {
      best = parsed
      executable = candidate
      version = parsed.join('.')
    }
  }
  try {
    const result = await run(executable, ['auth', 'status', '--json'])
    // Only these fields are read; the status output never carries the credential itself.
    const parsed = parseStatus(result.stdout)
    if (!parsed) {
      // Signed out is still valid JSON (`loggedIn: false`, exit 1). No JSON means `claude` could not
      // say: it crashed, errored (an npm install missing `node` on this PATH), or never started.
      const detail = describeFailure(result.exitCode, result.stderr ?? '', result.stdout)
      log.warn('Could not read Claude Code sign-in status', { executable, version, candidates, detail })
      return {
        offered: true,
        enabled,
        executable,
        ...(version ? { version } : {}),
        loggedIn: false,
        reason: "Could not read Claude Code's sign-in status",
        detail,
        candidates,
      }
    }
    const loggedIn = parsed.loggedIn === true
    if (!loggedIn) log.info('Claude Code is not signed in', { executable, version, candidates })
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
      candidates,
    }
  } catch (error) {
    log.warn('Could not run Claude Code', { executable, version, candidates, error })
    return {
      offered: true,
      enabled,
      executable,
      loggedIn: false,
      reason: 'Could not run Claude Code',
      detail: error instanceof Error ? error.message : String(error),
      candidates,
    }
  }
}

/** `claude auth status --json`'s answer, or undefined when it printed no status JSON. */
function parseStatus(
  stdout: string
): { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown
    return parsed && typeof parsed === 'object' && typeof (parsed as { loggedIn?: unknown }).loggedIn === 'boolean'
      ? (parsed as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown })
      : undefined
  } catch {
    return undefined
  }
}

/** "exit 127: env: node: No such file or directory", trimmed to something a person can read. */
function describeFailure(exitCode: number, stderr: string, stdout: string): string {
  const output = (stderr.trim() || stdout.trim()).split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ')
  const clipped = output.length > 300 ? `${output.slice(0, 299)}…` : output
  return clipped ? `exit ${exitCode}: ${clipped}` : `exit ${exitCode} with no output`
}
