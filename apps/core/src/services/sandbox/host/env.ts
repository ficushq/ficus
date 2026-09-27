/**
 * Host runtime environment.
 *
 * Agent shells on the host runtime must never inherit the worker's process
 * env (DATABASE_URL, provider keys, signing secrets live there). The base env
 * is instead a snapshot of the process user's LOGIN shell taken from a fixed
 * identity-only seed, so the user's PATH and profile exports (brew, nvm, go,
 * ssh-agent…) are present and nothing from the worker is.
 */

import { randomBytes, randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from '@ficus/shared/legacy-env'
import { getHomeDir } from '../../../lib/utils/home'
import { getCliHostPath } from '../../../lib/utils/cli-help'
import { getSquadSshPath } from '../../squad/ssh'
import { getSquadWorkspacePath } from '../../squad/workspace'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('sandbox-host')

export const SEED_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const
/**
 * Keys whose value must always come from the seed, never from the login shell
 * snapshot: some distros/CI runners' login profiles (e.g. /etc/profile.d) re-export
 * HOME (and friends) themselves, which would otherwise clobber the seed with the
 * shell's own idea of the user rather than the core process's. TERM/LANG/LC_ALL/TZ
 * are locale/terminal presentation, not identity, so the profile may still set them.
 */
export const IDENTITY_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
] as const satisfies readonly (typeof SEED_ENV_KEYS)[number][]
export const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

function pick(source: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

export function seedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SEED_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Only real shell identifiers can be env keys; anything else is banner/noise that survived sentinel slicing. */
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse `env -0` output (NUL-separated `KEY=value` records; values may contain `=` and newlines). */
export function parseNulSeparatedEnv(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const record of output.split('\0')) {
    if (!record) continue
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    const key = record.slice(0, eq)
    if (!VALID_ENV_KEY.test(key)) continue
    out[key] = record.slice(eq + 1)
  }
  return out
}

/**
 * Sentinel printed (with a trailing NUL) immediately before the env dump, so a
 * profile/MOTD banner that writes to stdout on login can never corrupt the
 * first parsed record — we slice everything up to and including the last
 * occurrence of `sentinel + NUL` before parsing.
 */
const ENV_SENTINEL = '__TAU_ENV__'
// `env -0` is GNU + macOS; fall back to newline-separated `env` if -0 is unsupported. The
// leading printf's `\0` is a literal backslash-zero here — it's interpreted as a NUL escape
// by the login shell's `printf`, not by this JS string.
const LOGIN_ENV_SCRIPT = `printf '${ENV_SENTINEL}\\0'; env -0 2>/dev/null || env`

function snapshotLoginEnvDetailed(
  opts: {
    seed?: Record<string, string>
    shell?: string
    spawnSync?: typeof Bun.spawnSync
    timeoutMs?: number
  } = {}
): { env: Record<string, string>; ok: boolean } {
  const seed = opts.seed ?? seedEnv()
  const shell = opts.shell ?? seed.SHELL ?? '/bin/bash'
  const spawnSync = opts.spawnSync ?? Bun.spawnSync
  try {
    const result = spawnSync([shell, '-l', '-c', LOGIN_ENV_SCRIPT], {
      env: seed,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: opts.timeoutMs ?? 10_000,
    })
    if (result.exitCode !== 0) throw new Error(`login shell exited ${result.exitCode}: ${result.stderr.toString()}`)
    const raw = result.stdout.toString()
    const marker = `${ENV_SENTINEL}\0`
    const idx = raw.lastIndexOf(marker)
    if (idx === -1)
      throw new Error('login shell output missing env sentinel (a startup banner may have corrupted the dump)')
    const dump = raw.slice(idx + marker.length)
    const parsed = dump.includes('\0') ? parseNulSeparatedEnv(dump) : parseNulSeparatedEnv(dump.replace(/\n/g, '\0'))
    if (!parsed.PATH) parsed.PATH = FALLBACK_PATH
    // The login-shell snapshot contributes PATH and profile exports, but IDENTITY
    // keys must always win over whatever the profile set — see IDENTITY_KEYS above.
    return { env: { ...parsed, ...pick(seed, IDENTITY_KEYS) }, ok: true }
  } catch (err) {
    log.warn(`Host runtime: login-shell env snapshot failed (${shell}); using seed + fallback PATH:`, err)
    return { env: { ...seed, PATH: FALLBACK_PATH }, ok: false }
  }
}

export function snapshotLoginEnv(
  opts: {
    seed?: Record<string, string>
    shell?: string
    spawnSync?: typeof Bun.spawnSync
    timeoutMs?: number
  } = {}
): Record<string, string> {
  return snapshotLoginEnvDetailed(opts).env
}

let cachedBaseEnv: Record<string, string> | null = null

/** Minimal surface of a spawnSync result actually consumed here, so tests can inject a fake without matching Bun.spawnSync's full overloaded generic signature. */
type SpawnSyncLike = (
  cmd: string[],
  options?: Record<string, unknown>
) => { exitCode: number; stdout: { toString(): string }; stderr: { toString(): string } }

let spawnSyncOverride: SpawnSyncLike | null = null

/** Test-only: force the spawnSync implementation used by getHostBaseEnv()'s login-shell snapshot. */
export function setSpawnSyncOverrideForTests(fn: SpawnSyncLike | null): void {
  spawnSyncOverride = fn
}

/**
 * The base env for every host-runtime bash/exec/terminal. Snapshotted once per
 * process — but a failed snapshot (bad shell, sentinel missing, non-zero exit)
 * is never cached, so the next call retries instead of being stuck on
 * `seed + FALLBACK_PATH` for the process lifetime.
 */
export function getHostBaseEnv(): Record<string, string> {
  if (!cachedBaseEnv) {
    const { env, ok } = snapshotLoginEnvDetailed(
      spawnSyncOverride ? { spawnSync: spawnSyncOverride as unknown as typeof Bun.spawnSync } : {}
    )
    if (!ok) return env
    cachedBaseEnv = env
  }
  return { ...cachedBaseEnv }
}

export function resetHostBaseEnvCache(): void {
  cachedBaseEnv = null
}

export function hostBinDir(): string {
  return join(getHomeDir(), 'host', 'bin')
}

/** POSIX single-quote a string for safe interpolation into a shell command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Write `<HOME_DIR>/host/bin/ficus`, a shim that runs the built CLI with the
 * same bun binary the core runs under (both absolute paths). Returns the shim
 * path, or null (and logs) when the CLI build is absent. It writes that one
 * file only: any other file in the directory, such as a wrapper an older Core
 * left there, is never created, refreshed or deleted.
 */
export function ensureCliShim(opts: { cliHostPath?: string; bunPath?: string } = {}): string | null {
  const cliHostPath = opts.cliHostPath ?? getCliHostPath()
  if (!existsSync(cliHostPath)) {
    log.warn(
      `Host runtime: ficus CLI build not found at ${cliHostPath}; agents will not have \`ficus\` on PATH (bun run build:cli)`
    )
    return null
  }
  const bunPath = opts.bunPath ?? process.execPath
  const dir = hostBinDir()
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'ficus')
  // Atomic replace: `ficus` is on every agent's PATH, so a concurrent exec must
  // never observe the truncated/partial file a plain overwrite exposes. Write a
  // scratch file in the SAME directory (same filesystem, so the rename is
  // atomic), chmod it before it becomes visible, then rename over `ficus`.
  const tmpShim = join(dir, `.ficus.tmp-${randomUUID()}`)
  writeFileSync(tmpShim, `#!/bin/sh\nexec ${shellQuote(bunPath)} ${shellQuote(cliHostPath)} "$@"\n`)
  chmodSync(tmpShim, 0o755)
  renameSync(tmpShim, shim)
  return shim
}

export function resolveHostApiUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? '3000'}`
}

const AGENT_SANDBOX_PREFIX = 'agent_'

/**
 * Agent ids are UUIDs minted by core, but this one is interpolated into a
 * filesystem path and exported into a shell, so it is validated rather than
 * trusted. Anything else is treated as "no agent id" (anonymous store, no agent
 * context) instead of being silently mangled into a neighbouring path.
 */
const VALID_AGENT_ID = /^[A-Za-z0-9_-]+$/

export function normalizeAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined
  if (!VALID_AGENT_ID.test(agentId)) {
    log.warn(`Host runtime: ignoring malformed agent id ${JSON.stringify(agentId)} for the agent CLI auth store`)
    return undefined
  }
  return agentId
}

/**
 * Fallback agent id for entry points that are only given a sandbox id: an agent
 * light box is `agent_<agentId>` (see `agentWorkspaceSandboxId()`). Squad boxes
 * and system-manager boxes (`system_manager_<ownerUserId>`) carry no agent id —
 * the real id must be threaded from the runner, which is why this is only a
 * fallback.
 */
export function agentIdFromSandboxId(sandboxId?: string): string | undefined {
  if (!sandboxId?.startsWith(AGENT_SANDBOX_PREFIX)) return undefined
  return normalizeAgentId(sandboxId.slice(AGENT_SANDBOX_PREFIX.length))
}

/**
 * The `tau` CLI auth store for an agent shell. Per agent, and NEVER the
 * operator's `~/.tau/cli/auth.json`: host agents run as the operator with the
 * operator's $HOME, so without this an agent's `tau` falls back to the human's
 * active backend and acts as the human, against whatever instance the human
 * logged into. The file is deliberately not created — a missing store reads as
 * empty.
 */
export function hostCliAuthStorePath(agentId?: string): string {
  return join(getHomeDir(), 'host', 'cli-auth', `${normalizeAgentId(agentId) ?? 'anonymous'}.json`)
}

/** Env names the preamble restores the injected identity from; see {@link buildHostPreamble}. */
export const IDENTITY_ALIAS_KEYS = [
  'FICUS_IDENTITY_API_URL',
  'FICUS_IDENTITY_TOKEN',
  'FICUS_IDENTITY_AUTH_STORE',
  'FICUS_IDENTITY_AGENT_ID',
] as const

/**
 * Every identity name the preamble owns after the squad env file is sourced:
 * each is either re-exported from the runtime's own value or unset, so a
 * `.tau/.env` can neither replace nor supply one.
 */
export const IDENTITY_ENV_KEYS = [
  'FICUS_API_URL',
  'FICUS_TOKEN',
  'FICUS_AUTH_STORE',
  'FICUS_AGENT_CONTEXT',
  'FICUS_AGENT_ID',
  // Never granted to an agent shell, so it is always in the unset list. The CLI
  // still accepts FICUS_PASSWORD as a human credential (`tau auth login`), so a
  // stale squad env — or an operator's own shell profile — would otherwise hand
  // the instance's admin password to every agent.
  'FICUS_PASSWORD',
] as const

/**
 * One release (Ficus rename): the legacy spelling of a `FICUS_` name. Older `tau`
 * CLIs, user scripts and ssh shims written by an older Core read these.
 */
function legacyName(key: string): string {
  return `${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}`
}

/** Runtime-injected names that are also emitted under their legacy `TAU_` spelling this release. */
const LEGACY_ALIASED_KEYS = [
  'FICUS_API_URL',
  'FICUS_TOKEN',
  'FICUS_AUTH_STORE',
  'FICUS_AGENT_CONTEXT',
  'FICUS_AGENT_ID',
  'FICUS_SQUAD_SSH_DIR',
] as const

/** Identity of the shell being built: which agent it is and which instance/credential it uses. */
export interface HostIdentityOptions {
  tauToken?: string
  agentId?: string
}

/** Per-command env: base login env + tau vars + shim PATH (+ squad ssh config). */
export function buildHostCommandEnv(
  opts: HostIdentityOptions & {
    squadId?: string
    base?: Record<string, string>
  }
): Record<string, string> {
  const base = opts.base ?? getHostBaseEnv()
  const env: Record<string, string> = { ...base }
  env.PATH = `${hostBinDir()}:${base.PATH ?? FALLBACK_PATH}`
  env.FICUS_API_URL = resolveHostApiUrl()
  if (process.env.APP_URL) env.APP_URL = process.env.APP_URL
  // An INJECTED TOKEN is what makes a shell an agent's. Operator-driven shells
  // (web terminals, `exec`, the manager's spawns) get no token, and must keep
  // the operator's own CLI auth store and resolution — overriding those would
  // only break the human's `tau` without protecting anything.
  const agentId = normalizeAgentId(opts.agentId)
  if (opts.tauToken) {
    env.FICUS_TOKEN = opts.tauToken
    env.FICUS_AUTH_STORE = hostCliAuthStorePath(agentId)
    env.FICUS_AGENT_CONTEXT = '1'
    if (agentId) env.FICUS_AGENT_ID = agentId
  }
  // Aliases the preamble restores the identity from after the squad env file is
  // sourced. They travel in the process env, never in the command string, and
  // mirror exactly the names that were set above.
  env.FICUS_IDENTITY_API_URL = env.FICUS_API_URL
  if (env.FICUS_TOKEN) env.FICUS_IDENTITY_TOKEN = env.FICUS_TOKEN
  if (env.FICUS_AUTH_STORE) env.FICUS_IDENTITY_AUTH_STORE = env.FICUS_AUTH_STORE
  if (env.FICUS_AGENT_ID) env.FICUS_IDENTITY_AGENT_ID = env.FICUS_AGENT_ID
  if (opts.squadId) {
    const sshDir = getSquadSshPath(opts.squadId)
    const sshConfig = join(sshDir, 'config')
    if (existsSync(sshConfig)) {
      // Host-runtime SSH-family shims (ssh-shims.ts) read this to resolve the
      // squad's managed config + known_hosts; see docs/wiki/host-runtime.md § Environment.
      env.FICUS_SQUAD_SSH_DIR = sshDir
      // The squad's known_hosts must be named explicitly: on host there is no
      // `~/.ssh` mount, so ssh would otherwise consult (and append learned host
      // keys to) the OPERATOR's own known_hosts and ignore the squad's.
      const knownHosts = join(sshDir, 'known_hosts')
      const knownHostsOpt = existsSync(knownHosts) ? ` -o UserKnownHostsFile=${shellQuote(knownHosts)}` : ''
      env.GIT_SSH_COMMAND = `ssh -F ${shellQuote(sshConfig)}${knownHostsOpt}`
    }
  }
  // Dual-emit, overwriting whatever the operator's login env carried under the
  // legacy name, so an older `tau` CLI resolves the same instance and identity.
  for (const key of LEGACY_ALIASED_KEYS) if (env[key] !== undefined) env[legacyName(key)] = env[key]
  return env
}

/**
 * Shell preamble for agent bash on the host runtime: snapshot the injected
 * identity into shell-local names, source the squad's `.tau/.env` from the
 * STORAGE workspace (never from an override directory, so secrets are never
 * written into a user's own repo), then re-assert the identity from the
 * snapshots. Solo sandboxes source nothing but still get the re-assertion.
 *
 * Every step is load-bearing:
 *
 * - `set -a && . envfile` runs INSIDE this shell, after the process env exists,
 *   so a `FICUS_API_URL`/`FICUS_TOKEN`/`FICUS_AUTH_STORE` in the squad env would
 *   otherwise replace the agent's identity and let it act as another identity
 *   against another instance.
 * - The snapshots are taken BEFORE the source line because the `FICUS_IDENTITY_*`
 *   aliases are ordinary variables: a squad env that sets THOSE would poison an
 *   export that read them afterwards.
 * - The snapshot names carry a per-command random suffix, so a squad env cannot
 *   name them in advance either. The threat model is the ACCIDENT — a stale or
 *   mistaken squad env variable — not a squad env written to defeat this: host
 *   mode has no isolation, so a deliberate agent reads the operator's auth store
 *   directly regardless.
 * - Identity names this shell is not given are UNSET after sourcing, so a stale
 *   squad env cannot hand a credential to a shell that was given none.
 * - `PATH` is re-asserted with the shim dir first, so a squad env cannot route
 *   `tau` to another binary (e.g. an older globally installed CLI) — while
 *   keeping whatever the squad env added, which stays a supported thing to do.
 * - Values travel in the process env, never in this string: the command string
 *   becomes argv, which is world-readable through /proc on Linux.
 *   `opts.tauToken` only decides WHETHER a `FICUS_TOKEN` assignment is emitted;
 *   its value never reaches the output.
 */
export function buildHostPreamble(opts: HostIdentityOptions & { squadId?: string } = {}): string {
  const agentId = normalizeAgentId(opts.agentId)
  // Fresh per command: the sourced file cannot assign a name it cannot predict.
  const local = (name: string) => `__tau_${randomBytes(3).toString('hex')}_${name}`
  const urlVar = local('url')
  const binVar = local('bin')
  const tokenVar = local('tok')
  const storeVar = local('store')
  const agentVar = local('agent')

  const set = new Map<string, string>([['FICUS_API_URL', `$${urlVar}`]])
  if (opts.tauToken) {
    set.set('FICUS_TOKEN', `$${tokenVar}`)
    set.set('FICUS_AUTH_STORE', `$${storeVar}`)
    set.set('FICUS_AGENT_CONTEXT', '1')
    if (agentId) set.set('FICUS_AGENT_ID', `$${agentVar}`)
  }

  const locals = [urlVar, binVar]
  const snapshots = [`${urlVar}="$FICUS_IDENTITY_API_URL"`, `${binVar}=${shellQuote(hostBinDir())}`]
  if (opts.tauToken) {
    snapshots.push(`${tokenVar}="$FICUS_IDENTITY_TOKEN"`, `${storeVar}="$FICUS_IDENTITY_AUTH_STORE"`)
    locals.push(tokenVar, storeVar)
    if (agentId) {
      snapshots.push(`${agentVar}="$FICUS_IDENTITY_AGENT_ID"`)
      locals.push(agentVar)
    }
  }
  const lines = [snapshots.join('; ')]

  if (opts.squadId) {
    const envPath = join(getSquadWorkspacePath(opts.squadId), '.tau', '.env')
    // A brace group, not an `&&` chain: a sourced file whose last command exits
    // non-zero would short-circuit an `&& set +a` and leave `allexport` on for
    // the agent's entire command.
    lines.push(`[ -f "${envPath}" ] && { set -a; . "${envPath}"; set +a; }`)
  }

  lines.push(`export ${[...set].map(([key, value]) => `${key}="${value}"`).join(' ')}`)
  const unmanaged = IDENTITY_ENV_KEYS.filter((key) => !set.has(key))
  if (unmanaged.length > 0) lines.push(`unset ${unmanaged.join(' ')}`)
  // One release (Ficus rename): re-assert the legacy spellings from the restored
  // values and unset the legacy spelling of every name this shell was not given,
  // so neither an older CLI nor the new CLI's TAU_→FICUS_ bridge picks up a
  // squad env's TAU_TOKEN or TAU_PASSWORD.
  lines.push(`export ${[...set.keys()].map((key) => `${legacyName(key)}="$${key}"`).join(' ')}`)
  if (unmanaged.length > 0) lines.push(`unset ${unmanaged.map(legacyName).join(' ')}`)
  lines.push(`export PATH="$${binVar}:$PATH"`)
  lines.push(`unset ${locals.join(' ')} ${IDENTITY_ALIAS_KEYS.join(' ')}`)
  return `${lines.join('\n')}\n`
}
