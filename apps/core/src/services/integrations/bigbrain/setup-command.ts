import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { bigbrainChildEnvironment } from './stdio-transport'

/** Fixed, outcome-only failure codes. Upstream stdout/stderr is never returned, logged or stored. */
export type BigbrainSetupCommandFailure =
  'executable_missing' | 'busy' | 'timeout' | 'connection_revoked' | 'no_vault' | 'failed' | 'invalid_output'

export class BigbrainSetupCommandError extends Error {
  constructor(
    readonly code: BigbrainSetupCommandFailure,
    readonly exitCode?: number
  ) {
    super(`BigBrain setup command failed: ${code}`)
    this.name = 'BigbrainSetupCommandError'
  }
}

export const SETUP_COMMAND_ARGV = Object.freeze(['mcp', 'config'] as const)
const STDOUT_LIMIT = 64 * 1024
const STDERR_LIMIT = 16 * 1024
const DEFAULT_DEADLINE_MS = 20_000
/** After the wrapper exits, how long its already-written output may take to drain. */
const CLOSE_GRACE_MS = 500
const clientId = z.string().regex(/^[a-f0-9]{8}$/)
const bounded = z.string().max(4096)
// `ConnectedClients.stdio(id)` at the pinned upstream: {mcpServers:{bigbrain:{command,args,env}}}.
const configOutput = z.object({
  mcpServers: z.object({
    bigbrain: z.object({
      command: bounded,
      args: z.array(bounded).min(3).max(16),
      env: z.record(bounded),
    }),
  }),
})

let running = false

/**
 * Run upstream `bigbrain mcp config` once: it creates or reuses BigBrain's named generic
 * "Local MCP configuration" connection (`ConnectedClients.ensure(..., "cli:config")`) for the
 * vault in `BIGBRAIN_VAULT`, and prints its stdio launch entry. The credential stays in
 * BigBrain's private store under OS HOME; only the 8-hex `--client` ID is returned.
 *
 * Fixed argv, no shell, restricted environment, private temporary cwd, own process group,
 * bounded output and deadline, one setup at a time.
 */
export async function runBigbrainSetupCommand(options: {
  executablePath: string
  vaultPath: string
  deadlineMs?: number
}): Promise<{ clientId: string }> {
  if (running) throw new BigbrainSetupCommandError('busy')
  running = true
  const cwd = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-setup-'))
  try {
    const { code, stdout, stderr } = await execute(options, cwd)
    if (code !== 0) throw new BigbrainSetupCommandError(classifyFailure(stderr), code ?? undefined)
    return { clientId: parseOutput(stdout, options.vaultPath) }
  } finally {
    running = false
    await rm(cwd, { recursive: true, force: true })
  }
}

function execute(
  options: { executablePath: string; vaultPath: string; deadlineMs?: number },
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, [...SETUP_COMMAND_ARGV], {
      cwd,
      env: bigbrainChildEnvironment(options),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let exitCode: number | null = null
    let closeGrace: ReturnType<typeof setTimeout> | undefined
    const killGroup = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    // Never wait on 'close' alone: a descendant that left the process group can hold the pipes
    // open indefinitely. Settling detaches and destroys our pipe ends, so it cannot wedge setup.
    const settle = (outcome: { error: BigbrainSetupCommandError } | { code: number | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(closeGrace)
      killGroup()
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.stdout.destroy()
      child.stderr.destroy()
      if ('error' in outcome) return reject(outcome.error)
      resolve({
        code: outcome.code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }
    const fail = (error: BigbrainSetupCommandError) => settle({ error })
    const timer = setTimeout(
      () => fail(new BigbrainSetupCommandError('timeout')),
      options.deadlineMs ?? DEFAULT_DEADLINE_MS
    )
    child.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length
      if (stdoutBytes > STDOUT_LIMIT) return fail(new BigbrainSetupCommandError('invalid_output'))
      stdout.push(data)
    })
    child.stderr.on('data', (data: Buffer) => {
      // Kept only in memory for fixed-code classification, then discarded.
      if (stderrBytes < STDERR_LIMIT) stderr.push(data.subarray(0, STDERR_LIMIT - stderrBytes))
      stderrBytes += data.length
    })
    // Swallow errors from destroyed pipe ends after settling.
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.once('error', (error: NodeJS.ErrnoException) =>
      fail(
        new BigbrainSetupCommandError(
          error.code === 'ENOENT' || error.code === 'EACCES' ? 'executable_missing' : 'failed'
        )
      )
    )
    child.once('exit', (code) => {
      exitCode = code
      // The wrapper may exit before its children: reap the owned group, then allow a short,
      // bounded drain of already-written output before settling without 'close'.
      killGroup()
      closeGrace = setTimeout(() => settle({ code: exitCode }), CLOSE_GRACE_MS)
    })
    child.once('close', (code) => settle({ code: exitCode ?? code }))
  })
}

function classifyFailure(stderr: string): BigbrainSetupCommandFailure {
  if (/Client connection was revoked/.test(stderr)) return 'connection_revoked'
  if (/no vault found/i.test(stderr)) return 'no_vault'
  return 'failed'
}

function parseOutput(stdout: string, vaultPath: string): string {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new BigbrainSetupCommandError('invalid_output')
  }
  const parsed = configOutput.safeParse(value)
  if (!parsed.success) throw new BigbrainSetupCommandError('invalid_output')
  const { args, env } = parsed.data.mcpServers.bigbrain
  const [mcp, flag, id] = args.slice(-3)
  // The entry must name exactly the vault Ficus selected, with no credential-store override.
  if (mcp !== 'mcp' || flag !== '--client' || env.BIGBRAIN_VAULT !== vaultPath || 'BIGBRAIN_TOKENS' in env)
    throw new BigbrainSetupCommandError('invalid_output')
  const result = clientId.safeParse(id)
  if (!result.success) throw new BigbrainSetupCommandError('invalid_output')
  return result.data
}
