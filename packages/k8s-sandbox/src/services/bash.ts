/**
 * Bash execution service.
 *
 * Runs commands inside the sandbox with optional preamble that mirrors
 * the Docker spawnHook behavior: source .tau/.env and activate devbox.
 *
 * Returns a streaming response (SSE) with stdout/stderr chunks and exit code.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getWorkspace, getTauEnvPath, rebaseLogicalRoot } from '../paths'
import { getDevboxShellEnv, refreshDevboxShellEnvIfDirty } from './devbox-env'
import vmDevboxRouting from './devbox-routing.sh' with { type: 'text' }
import { buildSandboxChildEnv } from './env'
import { readExecutorCommandIdentity } from './command-identity'
import { waitForDockerReady } from '../docker'
import {
  processSessionDriver,
  terminateOwnedSession,
  type ProcessIdentity,
  type ProcessSessionDriver,
} from './process-session'
import { BashInvocationRegistry, type BashInvocationLease, type BashInvocationRecord } from './bash-invocation-registry'

// Matches a `docker` (or `docker-compose`) invocation as a command token —
// at the start of the command or after a shell separator, optionally via sudo.
// Used to decide whether to wait for dockerd before running (see handleBash).
const DOCKER_INVOCATION = /(?:^|[\s;&|(])(?:sudo\s+)?docker(?:[-\s]|$)/

/** True if the command appears to invoke docker / docker-compose. */
export function commandUsesDocker(command: string): boolean {
  return DOCKER_INVOCATION.test(command)
}

export const DEFAULT_BASH_TIMEOUT_SECONDS = 180
export const MAX_BASH_TIMEOUT_SECONDS = 3_600

/** Internal callers may omit a timer; explicit invalid values use the public default. */
export function normalizeBashTimeoutSeconds(timeout?: number): number | undefined {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_BASH_TIMEOUT_SECONDS
  return Math.min(timeout, MAX_BASH_TIMEOUT_SECONDS)
}

interface BashRequest {
  command: string
  invocationId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutSeconds?: number
  sourceEnv?: boolean
  activateDevbox?: boolean
}

export async function reconcileBashRecord(
  record: BashInvocationRecord,
  driver: ProcessSessionDriver = processSessionDriver
): Promise<void> {
  const recordedStartToken = record.startToken ?? (record.startTicks ? `linux:${record.startTicks}` : undefined)
  if (!record.pid || !recordedStartToken) throw new Error('prior invocation ownership is ambiguous')
  const current = await driver.readIdentity(record.pid)
  if (!record.pgid || !record.sid) {
    if (!current) return
    if (current.startToken !== recordedStartToken) throw new Error('prior starting invocation identity is ambiguous')
    driver.signal(record.pid, 'SIGKILL')
    if (!(await driver.waitForExit(record.pid, 5_000))) {
      throw new Error('prior starting invocation direct child survived cleanup')
    }
    return
  }
  if (!current) {
    await terminateOwnedSession(
      { pid: record.pid, pgid: record.pgid, sid: record.sid, startToken: recordedStartToken },
      driver
    )
    return
  }
  if (current.startToken !== recordedStartToken || current.pgid !== record.pgid || current.sid !== record.sid) {
    throw new Error('prior invocation process identity is ambiguous')
  }
  await terminateOwnedSession(
    { pid: record.pid, pgid: record.pgid, sid: record.sid, startToken: recordedStartToken },
    driver
  )
}

const bashInvocationRegistry = new BashInvocationRegistry({
  runtimeDir: join(process.env.FICUS_BOX_HOME ?? process.env.HOME ?? '/tmp', '.tau/runtime/bash-invocations'),
  reconcile: reconcileBashRecord,
})

export async function cancelBashInvocation(invocationId: string, reason?: string): Promise<{ remainingPids: [] }> {
  return bashInvocationRegistry.terminate(invocationId, reason)
}

export async function reconcileBashInvocations() {
  return bashInvocationRegistry.reconcileAll()
}

export async function terminateAllBashInvocations(): Promise<void> {
  await bashInvocationRegistry.terminateAll()
}

/** Idle-exit gate: any bash invocation still starting/running/cancelling here. */
export function hasActiveBashInvocations(): boolean {
  return bashInvocationRegistry.hasActiveInvocations()
}

/**
 * Build a preamble script that mirrors the Docker spawnHook behavior:
 * 1. Source .tau/.env for secrets/environment variables
 * 2. Activate devbox if devbox.json exists in workspace
 * 3. Normalize runtime environment for Nix Python and browser tooling
 */
// Deprioritize the workload relative to the sandbox-server so a command that
// saturates the box (an in-box build/benchmark pegging every CPU, or driving the
// box OOM) can never starve the server's /healthz probes — which is what got
// healthy boxes condemned + recreated mid-work (see box-health-under-load).
// On the machine-host runtime the server is an unprivileged `--user` systemd
// unit that can't negative-nice ITSELF, so we positive-nice the WORKLOAD instead
// (both ops are allowed unprivileged: raising own niceness and raising own
// oom_score_adj). Complements the Docker runtime's root-nices-the-server shield.
// Fail-open: any box lacking renice or a writable oom_score_adj still runs.
const WORKLOAD_DEPRIORITIZE =
  'renice 19 $$ >/dev/null 2>&1 || true\n' +
  // Guard the write with `[ -w ]` so a box without /proc (or a read-only
  // oom_score_adj) never even attempts the redirect — an unopened redirect
  // target prints a shell error that `2>/dev/null` cannot suppress.
  '[ -w /proc/$$/oom_score_adj ] && echo 500 >/proc/$$/oom_score_adj 2>/dev/null || true\n'

export function buildPreamble(opts: { sourceEnv: boolean; activateDevbox: boolean }): string {
  let preamble = WORKLOAD_DEPRIORITIZE

  if (opts.sourceEnv) {
    const envPath = getTauEnvPath()
    preamble += `[ -f "${envPath}" ] && set -a && . "${envPath}" && set +a\n`
  }

  if (opts.activateDevbox) {
    // Use cached devbox shellenv output instead of running `devbox shellenv`
    // on every command. Running it live corrupts the container filesystem
    // in privileged k3d pods (causes /usr/bin to disappear).
    const shellEnv = getDevboxShellEnv()
    if (shellEnv) {
      preamble += shellEnv + '\n'
    }
  }

  if (process.env.FICUS_BOX_HOME && process.env.FICUS_DEVBOX_DIR) {
    preamble += vmDevboxRouting + '\n'
  }

  // Apply Ficus's runtime normalization after devbox activation so Nix Python
  // native wheels see Nix runtime libraries and browser tooling uses /tmp.
  preamble += '[ -f /opt/sandbox/runtime-env.sh ] && . /opt/sandbox/runtime-env.sh\n'

  return preamble
}

export interface BashAdmissionDependencies {
  processDriver: ProcessSessionDriver
  admissionTimeoutMs: number
  waitForAdmissionPoll(): Promise<void>
}

interface BashDependencies extends BashAdmissionDependencies {
  waitForDockerReady: typeof waitForDockerReady
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess
  scheduleTimeout(callback: () => void, delayMs: number): () => void
  onSpawnDecision?: (decision: 'cancelled' | 'spawn') => void
  /** Release the server request reservation once registry ownership or no-spawn cleanup is proven. */
  onAdmissionFenced?: () => void
}

const defaultBashDependencies: BashDependencies = {
  waitForDockerReady,
  processDriver: processSessionDriver,
  admissionTimeoutMs: 5_000,
  waitForAdmissionPoll: () => new Promise((resolve) => setTimeout(resolve, 10)),
  spawn,
  scheduleTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

function streamWasCancelled(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  return controller.desiredSize === null || controller.desiredSize <= 0
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid && left.pgid === right.pgid && left.sid === right.sid && left.startToken === right.startToken
  )
}

function stoppedIdentityMatches(current: ProcessIdentity | undefined, observed: ProcessIdentity): boolean {
  return Boolean(current && sameProcessIdentity(current, observed) && (current.state === 'T' || current.state === 't'))
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded deadline`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class BashAdmissionError extends Error {
  constructor(
    message: string,
    readonly ownedObservation?: ProcessIdentity
  ) {
    super(message)
  }
}

export function stoppedBashArguments(command: string): string[] {
  return ['-c', 'kill -STOP $$; exec "$@"', '--', 'bash', '-c', command]
}

export async function admitStoppedProcess(
  proc: { pid?: number },
  lease: BashInvocationLease,
  dependencies: BashAdmissionDependencies,
  exited: Promise<number | null>
): Promise<ProcessIdentity> {
  const started = Date.now()
  let pinnedStartToken: string | undefined
  let ownedObservation: ProcessIdentity | undefined
  while (Date.now() - started < dependencies.admissionTimeoutMs) {
    const observed = await dependencies.processDriver.readIdentity(proc.pid!)
    if (observed) {
      if (observed.pid !== proc.pid || observed.pid <= 1) {
        throw new BashAdmissionError('spawned bash admission PID changed', ownedObservation)
      }
      if (pinnedStartToken === undefined) {
        pinnedStartToken = observed.startToken
        ownedObservation = observed
        await lease.markStarting({ pid: observed.pid, startToken: observed.startToken })
      } else if (observed.startToken !== pinnedStartToken) {
        throw new BashAdmissionError('spawned bash admission start token changed', ownedObservation)
      }
      if (
        observed.pid === observed.pgid &&
        observed.pid === observed.sid &&
        observed.pid > 1 &&
        (observed.state === 'T' || observed.state === 't')
      ) {
        await lease.markRunning({
          pid: observed.pid,
          pgid: observed.pgid,
          sid: observed.sid,
          startToken: observed.startToken,
        })
        const confirmed = await dependencies.processDriver.readIdentity(observed.pid)
        if (!stoppedIdentityMatches(confirmed, observed)) {
          throw new BashAdmissionError('spawned bash identity changed before CONT', observed)
        }
        dependencies.processDriver.signal(-observed.pgid, 'SIGCONT')
        return observed
      }
    }
    const turn = await Promise.race([
      exited.then(() => 'exit' as const),
      dependencies.waitForAdmissionPoll().then(() => 'poll' as const),
    ])
    if (turn === 'exit') {
      throw new BashAdmissionError('spawned bash exited before stopped-session admission', ownedObservation)
    }
  }
  throw new BashAdmissionError('spawned bash stopped-session admission exceeded deadline', ownedObservation)
}

async function cleanupUnadmittedProcess(
  proc: ChildProcess,
  dependencies: BashDependencies,
  observation: ProcessIdentity | undefined,
  exited: Promise<number | null>
): Promise<void> {
  if (observation) {
    const current = await dependencies.processDriver.readIdentity(observation.pid)
    if (current && !sameProcessIdentity(current, observation)) {
      throw new Error('unadmitted bash identity changed before cleanup')
    }
    if (current) {
      if (
        observation.pid === proc.pid &&
        observation.pid === observation.pgid &&
        observation.pid === observation.sid &&
        observation.pid > 1
      )
        dependencies.processDriver.signal(-observation.pgid, 'SIGKILL')
      else proc.kill('SIGKILL')
    }
  } else proc.kill('SIGKILL')
  await bounded(exited, dependencies.admissionTimeoutMs, 'unadmitted bash join')
  if (observation?.sid && observation.sid > 1) {
    const survivors = await dependencies.processDriver.scanSessionIdentities(observation.sid)
    if (survivors.length) throw new Error('unadmitted bash session survived cleanup')
  }
}

type BashInvocationRegistryPort = Pick<BashInvocationRegistry, 'acquire' | 'terminate'>

export function handleBash(
  req: BashRequest,
  registry: BashInvocationRegistryPort = bashInvocationRegistry,
  dependencyOverrides: Partial<BashDependencies> = {}
): Response {
  const dependencies = { ...defaultBashDependencies, ...dependencyOverrides }
  // On a VM box, a logical cwd (/private, /workspace/<squadId>) is rebased onto
  // the box HOME layout; identity on k8s/docker (FICUS_BOX_HOME unset).
  const cwd = rebaseLogicalRoot(req.cwd || getWorkspace())
  const sourceEnv = req.sourceEnv !== false
  const activateDevbox = req.activateDevbox !== false

  refreshDevboxShellEnvIfDirty()
  const preamble = buildPreamble({ sourceEnv, activateDevbox })
  const fullCommand = preamble + req.command
  const invocationId = req.invocationId ?? randomUUID()
  let activeProcess: ChildProcess | undefined
  let activeLease: BashInvocationLease | undefined
  let initialized: Promise<void> = Promise.resolve()
  let admitted = false
  let cancellation: Promise<void> | undefined
  let admissionFenceSettled = false
  const settleAdmissionFence = () => {
    if (admissionFenceSettled) return
    admissionFenceSettled = true
    dependencies.onAdmissionFenced?.()
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false

      const send = (data: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Controller may be closed externally (client disconnect, idleTimeout)
          closed = true
        }
      }

      const done = () => {
        if (closed) return
        closed = true
        controller.close()
      }

      // Do not return the admission promise from start(): Web Streams defer the
      // underlying cancel callback until that promise settles, which can strand
      // the server request reservation behind an unbounded readiness wait.
      void (async () => {
        // The squad box reports pod-ready before dockerd finishes cold-start, so
        // the first docker command can land before the daemon is up. Wait for it
        // here (no-op on agent boxes); if it never comes up, fall through and let
        // docker emit its own error.
        if (commandUsesDocker(req.command)) {
          try {
            await dependencies.waitForDockerReady()
          } catch (error) {
            settleAdmissionFence()
            send({
              error: `Failed to start bash invocation: ${error instanceof Error ? error.message : String(error)}`,
              exitCode: 127,
            })
            done()
            return
          }
        }

        // Observe transport cancellation before acquiring ownership so a
        // disconnected caller can never spawn.
        if (streamWasCancelled(controller)) {
          dependencies.onSpawnDecision?.('cancelled')
          settleAdmissionFence()
          return
        }

        let proc: ChildProcess
        let lease: BashInvocationLease | undefined
        let exited: Promise<number | null> | undefined
        try {
          const commandDigest = createHash('sha256')
            .update(JSON.stringify({ command: fullCommand, cwd, sourceEnv, activateDevbox }))
            .digest('hex')
          lease = await registry.acquire(invocationId, commandDigest)
          // acquire() has populated the registry's active map. From here onward
          // that map, rather than the request reservation, blocks idle exit.
          settleAdmissionFence()
          if (streamWasCancelled(controller)) {
            await lease.complete('failed')
            dependencies.onSpawnDecision?.('cancelled')
            return
          }
          dependencies.onSpawnDecision?.('spawn')
          const commandIdentity = readExecutorCommandIdentity(process.env)
          const bashArgs = stoppedBashArguments(fullCommand)
          const childEnv = buildSandboxChildEnv(process.env, req.env)
          if (commandIdentity) {
            childEnv.HOME = commandIdentity.home
            childEnv.USER = commandIdentity.user
            childEnv.LOGNAME = commandIdentity.user
            childEnv.DOCKER_HOST = 'unix:///run/tau-docker/docker.sock'
          }
          proc = dependencies.spawn(
            commandIdentity ? 'su-exec' : 'bash',
            commandIdentity ? [commandIdentity.user, 'bash', ...bashArgs] : bashArgs,
            {
              // su-exec replaces itself, preserving the proven stopped PID.
              cwd,
              env: childEnv,
              detached: process.platform !== 'win32',
            }
          )
          activeProcess = proc
          activeLease = lease
          proc.once('error', () => {
            /* close/exited drives bounded admission cleanup and reporting */
          })
          proc.stdout?.on('data', (chunk: Buffer) => {
            send({ stdout: chunk.toString('base64') })
          })
          proc.stderr?.on('data', (chunk: Buffer) => {
            send({ stderr: chunk.toString('base64') })
          })
          exited = new Promise((resolve) => proc.once('close', resolve))
          initialized = admitStoppedProcess(proc, lease, dependencies, exited).then((identity) => {
            admitted = true
            send({
              invocation: {
                id: invocationId,
                generation: lease!.generation,
                pid: identity.pid,
                pgid: identity.pgid,
                sid: identity.sid,
                commandDigest,
                startedAt: new Date().toISOString(),
              },
            })
          })
          await initialized
        } catch (error) {
          const failures: unknown[] = [error]
          if (activeProcess && exited) {
            try {
              await cleanupUnadmittedProcess(
                activeProcess,
                dependencies,
                error instanceof BashAdmissionError ? error.ownedObservation : undefined,
                exited
              )
            } catch (cleanupError) {
              failures.push(cleanupError)
            }
          }
          if (failures.length === 1) {
            try {
              await lease?.complete('failed')
            } catch (completionError) {
              failures.push(completionError)
            }
          }
          settleAdmissionFence()
          const primary = failures[0] instanceof Error ? failures[0].message : String(failures[0])
          if (failures.length === 1) send({ error: `Failed to start bash invocation: ${primary}`, exitCode: 127 })
          else send({ error: `Bash admission cleanup could not be proven: ${primary}` })
          done()
          return
        }

        const processExited = exited!

        // Timeout handling. Settlement is delayed until the entire owned session
        // has been terminated and verified empty; a caller can therefore safely
        // retry only after receiving the terminal SSE event.
        let cancelTimer: (() => void) | undefined
        let terminating = false
        const timeoutSeconds = normalizeBashTimeoutSeconds(req.timeoutSeconds)
        if (timeoutSeconds !== undefined) {
          cancelTimer = dependencies.scheduleTimeout(() => {
            terminating = true
            void initialized
              .then(() => registry.terminate(invocationId))
              .then(async () => {
                await lease!.complete('terminated')
                send({ error: `Command timed out after ${timeoutSeconds}s`, exitCode: 124 })
                done()
              })
              .catch((error) => {
                // Deliberately omit a terminal exit code: cleanup-unproven must
                // fail closed and cannot authorize a retry generation.
                send({ error: `Command cleanup could not be proven: ${error.message}` })
                done()
              })
          }, timeoutSeconds * 1000)
        }

        void processExited.then((code) => {
          cancelTimer?.()
          refreshDevboxShellEnvIfDirty()
          if (!terminating) {
            void initialized
              .then(() => lease!.complete(code === 0 ? 'success' : 'failed'))
              .then(() => {
                send({ exitCode: code ?? 1 })
                done()
              })
              .catch((error) => {
                send({ error: `Bash invocation initialization failed: ${error.message}` })
                done()
              })
          }
        })

        proc.on('error', (err) => {
          cancelTimer?.()
          // Same root bug as the spawn catch above: a process 'error' (the common
          // async spawn failure — ENOENT etc.) closes the stream with no exitCode.
          // Carry an explicit 127 so the client sees a failure, not success.
          void initialized
            .finally(() => lease!.complete('failed'))
            .then(() => {
              send({ error: `Process error: ${err.message}`, exitCode: 127 })
              done()
            })
            .catch(() => {
              send({ error: `Process error: ${err.message}`, exitCode: 127 })
              done()
            })
        })
      })().catch((error) => {
        settleAdmissionFence()
        send({
          error: `Failed to start bash invocation: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 127,
        })
        done()
      })
    },
    cancel() {
      // Cancellation may arrive before Docker readiness, registry acquisition,
      // or process creation. Always release the transferred request reservation.
      settleAdmissionFence()
      if (!activeProcess || !activeLease) return
      if (!admitted) {
        activeProcess.kill('SIGKILL')
        cancellation ??= initialized.catch(() => undefined)
      } else {
        // The stream's cancel handler runs on client disconnect; a rejection
        // here is an unhandled rejection that KILLS the whole box server (Bun
        // treats them as fatal), which then resets every other client — the
        // 2026-08-26 crash-feedback loop. Terminate failure means cleanup is
        // unproven: leave the record for reconcile/quarantine and log.
        cancellation ??= registry
          .terminate(invocationId)
          .then(() => activeLease!.complete('terminated'))
          .catch((error) => {
            console.error(`[sandbox] cancel cleanup unproven for ${invocationId}: ${error?.message ?? error}`)
          })
      }
      return cancellation
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}
