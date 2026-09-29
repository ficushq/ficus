import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { materializePrivateKey } from './keys'
import type { Machine } from './queries'

/**
 * One-shot SSH command execution for machines.
 *
 * Every invocation authenticates with the machine's private key materialized
 * to a 0600 scratch file (via {@link materializePrivateKey}) and cleaned up
 * immediately after — never ssh-agent (`IdentitiesOnly=yes` guarantees only the
 * supplied `-i` key is offered). Host key trust is TOFU
 * (`StrictHostKeyChecking=accept-new`) recorded in a machines-scoped
 * `known_hosts`, and connections are bounded (`ConnectTimeout`, keepalives)
 * plus an overall wall-clock `timeoutMs` that kills the child on expiry so a
 * black-holed host can never hang a caller (notably the BYO-SSH provider's
 * liveness probe) indefinitely.
 */

/** Overall default wall-clock bound for a one-shot command (caller-overridable). */
const DEFAULT_TIMEOUT_MS = 30_000

export class SshTimeoutError extends Error {}

export interface SshResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SshRunner {
  run(machine: Machine, command: string, opts?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<SshResult>
}

/** `<HOME_DIR>/machines` — parent for scratch keys, known_hosts, control sockets. */
function machinesDir(): string {
  return join(getHomeDir(), 'machines')
}

function knownHostsPath(): string {
  return join(machinesDir(), 'known_hosts')
}

export function sshTarget(machine: Machine): string {
  return `${machine.sshUser}@${machine.sshHost}`
}

/**
 * The standard SSH options every connecting invocation (one-shot runs and
 * ControlMaster masters) must carry, per the machines Global Constraints, plus
 * the materialized identity file. `-O` control commands (check/forward/exit)
 * connect over the local control socket and do not need these.
 */
export function sshConnectionArgs(machine: Machine, identityPath: string): string[] {
  return [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${knownHostsPath()}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'IdentitiesOnly=yes',
    // Never consult an ssh-agent: Ficus always presents its own materialized key
    // via -i, and a reachable-but-unhelpful agent (e.g. 1Password on a dev host)
    // otherwise negotiates on every connection — measured 60s of agent stalling
    // per ControlMaster establishment against a live exe.dev VM (2026-07-13),
    // blowing the tunnel manager's 15s master timeout. IdentitiesOnly already
    // means the agent's keys are never used; this stops it being consulted at all.
    '-o',
    'IdentityAgent=none',
    '-i',
    identityPath,
    '-p',
    String(machine.sshPort),
  ]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the remote command that installs a stdin-streamed file at `remotePath`
 * with octal `mode`. The path is single-quoted (safe against shell
 * metacharacters); the mode is validated as a 3–4 digit octal string. Exported
 * so its quote/validation behavior is unit-testable without a live runner.
 */
export function buildPushFileCommand(remotePath: string, mode: string): string {
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`invalid file mode: ${mode}`)
  }
  return `install -m ${mode} /dev/stdin ${shellQuote(remotePath)}`
}

async function runWithTimeout(
  proc: {
    stdout: unknown
    stderr: unknown
    exited: Promise<number>
    kill: (signal?: number | NodeJS.Signals) => void
  },
  timeoutMs: number
): Promise<SshResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // best-effort
      }
      reject(new SshTimeoutError(`ssh command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  const work = (async (): Promise<SshResult> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as BodyInit).text(),
      new Response(proc.stderr as BodyInit).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  })()

  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createSshRunner(deps?: { spawn?: typeof Bun.spawn; defaultTimeoutMs?: number }): SshRunner {
  const spawn = deps?.spawn ?? Bun.spawn
  const defaultTimeoutMs = deps?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async run(machine, command, opts): Promise<SshResult> {
      const identity = await materializePrivateKey(machine)
      try {
        // Ensure the parent dir exists so ssh can create/append known_hosts.
        await mkdir(machinesDir(), { recursive: true })

        const args = ['ssh', ...sshConnectionArgs(machine, identity.path), sshTarget(machine), command]

        let stdin: unknown = 'ignore'
        if (opts?.stdin !== undefined) {
          stdin = typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : opts.stdin
        }

        const proc = spawn(args, {
          stdin: stdin as never,
          stdout: 'pipe',
          stderr: 'pipe',
        })

        return await runWithTimeout(proc, opts?.timeoutMs ?? defaultTimeoutMs)
      } finally {
        identity.cleanup()
      }
    },
  }
}

/** Process-wide default runner used by {@link sshExec} and {@link sshPushFile}. */
export const defaultSshRunner: SshRunner = createSshRunner()

// ---------------------------------------------------------------------------
// Host→host streaming (box state archives)
// ---------------------------------------------------------------------------

/** One end of a {@link SshStreamer} transfer. */
export interface SshStreamEndpoint {
  machine: Machine
  /** Remote command. The SOURCE writes the payload to stdout; the DESTINATION
   *  reads it from stdin. Neither may end in a PIPE — a pipeline's exit status
   *  is its LAST element's, which would mask a producing/consuming failure. */
  command: string
}

/** Per-end outcome of a stream. Both ends are reported independently and
 *  neither is allowed to stand in for the other (see {@link SshStreamer}). */
export interface SshStreamEndResult {
  exitCode: number
  stderr: string
}

export interface SshStreamResult {
  /** Bytes observed passing from source stdout to destination stdin. */
  bytes: number
  source: SshStreamEndResult
  dest: SshStreamEndResult
}

/**
 * Pipe one machine's stdout straight into another machine's stdin, with the
 * payload never held whole in this process (constant memory regardless of
 * size) and never staged on either host's disk.
 *
 * ## Fail-closed contract (the reason both ends are reported separately)
 * A truncated transfer must never be indistinguishable from a complete one.
 * The destination's exit status ALONE cannot provide that: a `tar` fed a
 * prefix that happens to end on a member boundary extracts it happily and
 * exits 0 (verified — bsdtar does exactly this). So the source's own exit
 * status is the primary signal, the destination's is the second, and callers
 * are required to check BOTH plus the byte count. A timeout kills both
 * children and REJECTS (never resolves with a partial count).
 */
export interface SshStreamer {
  stream(source: SshStreamEndpoint, dest: SshStreamEndpoint, opts?: { timeoutMs?: number }): Promise<SshStreamResult>
}

/** Minimal spawned-child surface the streamer drives (Bun.spawn satisfies it). */
interface StreamChild {
  stdout: unknown
  stderr: unknown
  exited: Promise<number>
  kill: (signal?: number | NodeJS.Signals) => void
}

export function createSshStreamer(deps?: { spawn?: typeof Bun.spawn; defaultTimeoutMs?: number }): SshStreamer {
  const spawn = deps?.spawn ?? Bun.spawn
  const defaultTimeoutMs = deps?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async stream(source, dest, opts): Promise<SshStreamResult> {
      const [sourceIdentity, destIdentity] = await Promise.all([
        materializePrivateKey(source.machine),
        materializePrivateKey(dest.machine),
      ])
      let timer: ReturnType<typeof setTimeout> | undefined
      let sourceProc: StreamChild | undefined
      let destProc: StreamChild | undefined
      try {
        await mkdir(machinesDir(), { recursive: true })

        sourceProc = spawn(
          ['ssh', ...sshConnectionArgs(source.machine, sourceIdentity.path), sshTarget(source.machine), source.command],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
        ) as unknown as StreamChild

        // Count bytes IN the pipe rather than by buffering: pipeThrough keeps
        // the reader's backpressure intact end to end, so a payload orders of
        // magnitude larger than any pipe buffer flows through at flat memory.
        let bytes = 0
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength
            controller.enqueue(chunk)
          },
        })
        const payload = (sourceProc.stdout as ReadableStream<Uint8Array>).pipeThrough(counter)

        destProc = spawn(
          ['ssh', ...sshConnectionArgs(dest.machine, destIdentity.path), sshTarget(dest.machine), dest.command],
          { stdin: payload as never, stdout: 'pipe', stderr: 'pipe' }
        ) as unknown as StreamChild

        const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            for (const proc of [sourceProc, destProc]) {
              try {
                proc?.kill('SIGKILL')
              } catch {
                // best-effort
              }
            }
            reject(new SshTimeoutError(`ssh stream timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        })

        const work = (async (): Promise<SshStreamResult> => {
          // The destination's stdout is drained (not ignored) so a chatty
          // remote script can never wedge on a full pipe buffer mid-transfer.
          const [sourceStderr, destStderr, , sourceExit, destExit] = await Promise.all([
            new Response(sourceProc!.stderr as BodyInit).text(),
            new Response(destProc!.stderr as BodyInit).text(),
            new Response(destProc!.stdout as BodyInit).text(),
            sourceProc!.exited,
            destProc!.exited,
          ])
          return {
            bytes,
            source: { exitCode: sourceExit, stderr: sourceStderr },
            dest: { exitCode: destExit, stderr: destStderr },
          }
        })()

        return await Promise.race([work, timeout])
      } catch (err) {
        // Kill whatever was spawned before rethrowing. The timeout path already
        // kills both, but a throw ANYWHERE else — most importantly the
        // DESTINATION spawn failing synchronously (EMFILE, a missing ssh
        // binary), with the source already running — would otherwise leave a
        // `sudo tar -c` grinding over a multi-GB workspace on a remote host
        // while the migration clears its fence and moves on. Killing an
        // already-exited child is a harmless no-op, so this needs no
        // discrimination about which end died.
        for (const proc of [sourceProc, destProc]) {
          try {
            proc?.kill('SIGKILL')
          } catch {
            // best-effort
          }
        }
        throw err
      } finally {
        if (timer) clearTimeout(timer)
        sourceIdentity.cleanup()
        destIdentity.cleanup()
      }
    },
  }
}

/** Process-wide default streamer (the migration transport). */
export const defaultSshStreamer: SshStreamer = createSshStreamer()

/**
 * Convenience one-shot exec over {@link defaultSshRunner}. Shape matches
 * `MachineExecFn` so it can back the BYO-SSH provider adapter.
 */
export async function sshExec(
  machine: Machine,
  command: string,
  opts?: { stdin?: string | Uint8Array; timeoutMs?: number }
): Promise<SshResult> {
  return defaultSshRunner.run(machine, command, opts)
}

/**
 * Push a file to the machine by streaming `content` over stdin into
 * `install -m <mode> /dev/stdin <path>`. The remote path is single-quoted so
 * it is safe against shell metacharacters; `mode` is validated as an octal
 * string. Default mode is `0644` (owner-writable, world-readable); callers that
 * need an executable or private file pass `mode` explicitly.
 */
export async function sshPushFile(
  machine: Machine,
  content: string | Uint8Array,
  remotePath: string,
  opts?: { mode?: string }
): Promise<void> {
  const command = buildPushFileCommand(remotePath, opts?.mode ?? '0644')
  const result = await defaultSshRunner.run(machine, command, { stdin: content })
  if (result.exitCode !== 0) {
    throw new Error(`sshPushFile to ${remotePath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}
