/**
 * HostSandboxManager — the `host` runtime.
 *
 * There is NO sandbox: agents run directly on the core's machine as the
 * process user. A "sandbox" is an in-memory record plus directories that
 * already exist (the core's storage paths — see hostWorkspaceLayout). This
 * manager spawns nothing long-lived: exec/streamExec run the given argv with
 * child_process, terminals are bun-pty shells, and every optional
 * ISandboxManager member that presumes a container/box (logs, toolchain, spec
 * hashing, storage reclaim) is deliberately absent so callers hit their
 * existing "not supported" guards instead of a silent no-op.
 *
 * Disk is never deleted here: agent termination archives the private dir via
 * private-archive.ts (identical to docker), and override directories belong to
 * the user.
 */

import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { spawn as ptySpawn, type IPty } from 'bun-pty'
import { WorkspaceWatcher, isSafeWatchPattern } from '@ficus/sandbox-server/watcher'
import type { ISandboxManager, SandboxOptions, SandboxRuntime, SpawnHook } from '../types'
import { getSquadIdFromSandbox } from '../types'
import { hostWorkspaceLayout, type WorkspaceLayout, type WorkspaceLayoutContext } from '../workspace-layout'
import { buildHostCommandEnv, ensureCliShim, getHostBaseEnv } from './env'
import { ensureSshFamilyShims } from './ssh-shims'
import { createHostBrowserBackend, type HostBrowserEngine } from './browser'
import { acquireSquadWatchLock, type SquadWatchLock } from './watch-lock'
import type { BrowserBackend } from '../browser-backend'
import type { WorkspaceFilesIngestInput } from '../../memory/workspace-files'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('sandbox-host')

interface HostSandboxState {
  sandboxId: string
  squadId?: string
  workRoot: string
  lifecycleGeneration?: string
}

let hostStopBeforeFenceHook: (() => Promise<void>) | undefined
export function setHostStopBeforeFenceHookForTest(hook: (() => Promise<void>) | undefined): void {
  hostStopBeforeFenceHook = hook
}

interface WatchEntry {
  watcher: WorkspaceWatcher
  root: string
  lock: SquadWatchLock
}

export interface HostSandboxManagerDeps {
  /** Base env for spawned processes (default: the cached login-shell snapshot). */
  baseEnv?: () => Record<string, string>
  /** Browser engine factory (tests inject one to observe its shutdown). */
  createBrowserEngine?: () => HostBrowserEngine
  /** Ingest sink for workspace-watch events (tests inject a spy; default lazy-imports the real service). */
  ingestWorkspaceFiles?: (squadId: string, payload: WorkspaceFilesIngestInput) => Promise<unknown>
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  // Already exited: `cancel()` racing the child's natural exit must never
  // SIGKILL a pid/process-group number the OS may since have reused.
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL') // detached: pid == process-group id
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** How often to re-check a child's own exit state while waiting for its event. */
const CHILD_SETTLE_POLL_MS = 50

/** True once the child has been reaped, whatever Bun did or did not emit. */
function childReaped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** True once we can no longer receive output — nothing is left to truncate. */
function childStreamsEnded(child: ChildProcess): boolean {
  const ended = (s: ChildProcess['stdout']) => !s || s.readableEnded || s.destroyed
  return ended(child.stdout) && ended(child.stderr)
}

/**
 * Wait for `event`, with the child's OWN state as a backstop.
 *
 * Bun 1.3.8 intermittently drops child-process completion events. Measured in a
 * hung run — the child was `true`, which exits immediately:
 *
 *     gone=true exitCode=0 signalCode=null
 *     EXIT_FIRED=false CLOSE_FIRED=false
 *     stdoutDestroyed=true stderrDestroyed=true
 *     stdoutReadableEnded=true stderrReadableEnded=true
 *
 * The process was reaped, `exitCode` was recorded, and both streams were ended
 * and destroyed — every precondition for 'exit' and 'close' held, and neither
 * fired. Roughly 1 run in 8 for the first spawn of a fresh `bun test` process;
 * a steady-state loop of 100 never lost one.
 *
 * So awaiting the event alone is unbounded: a `true` that exited 0 became an
 * opaque 5s CI timeout, and in production would hang monitor-supervisor and
 * local-deployment teardown outright. `exitCode`/`signalCode` are authoritative
 * and already populated in exactly that state, so poll them rather than guess
 * with a deadline — this reports the real status, never a fabricated one.
 *
 * Waiters for 'close' additionally require the streams to be ended, so the
 * backstop can never settle ahead of output the caller still needs. That also
 * keeps a surviving grandchild holding the pipes (see `streamExec`) from being
 * mistaken for completion.
 */
export function whenChildSettles(child: ChildProcess, event: 'exit' | 'close'): Promise<void> {
  const ready = () => childReaped(child) && (event === 'exit' || childStreamsEnded(child))
  if (ready()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearInterval(poll)
      resolve()
    }
    const poll = setInterval(() => {
      if (ready()) settle()
    }, CHILD_SETTLE_POLL_MS)
    poll.unref?.()
    child.once(event, settle)
    // A child that failed to spawn is never reaped, so `exitCode` stays null and
    // the poll can never settle it. 'error' is its only completion signal.
    child.once('error', settle)
  })
}

export class HostSandboxManager implements ISandboxManager {
  private sandboxes = new Map<string, HostSandboxState>()
  private children = new Set<ChildProcess>()
  private baseEnv: () => Record<string, string>
  private createBrowserEngine: () => HostBrowserEngine
  private shimEnsured = false
  private browserEngine: HostBrowserEngine | null = null
  private browserBackends = new Map<string, BrowserBackend>()
  private watchEntries = new Map<string, WatchEntry>()
  private ingestFn: ((squadId: string, payload: WorkspaceFilesIngestInput) => Promise<unknown>) | null

  // Deliberately ABSENT at runtime — there is no container/box here to stream
  // logs from, reconcile a managed toolchain in, or recreate. `declare` (no
  // initializer, nothing emitted) keeps the optional members visible to the
  // type checker for `HostSandboxManager`-typed call sites without ever
  // creating the property on an instance, so callers' `if (manager.xxx)`
  // "not supported" guards see true absence rather than a stubbed no-op.
  declare streamLogs?: ISandboxManager['streamLogs']
  declare reconcileToolchain?: ISandboxManager['reconcileToolchain']
  declare recreateSandbox?: ISandboxManager['recreateSandbox']

  constructor(deps: HostSandboxManagerDeps = {}) {
    this.baseEnv = deps.baseEnv ?? getHostBaseEnv
    this.createBrowserEngine = deps.createBrowserEngine ?? (() => createHostBrowserBackend())
    this.ingestFn = deps.ingestWorkspaceFiles ?? null
  }

  // --- Lifecycle ---

  async ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
    const layout = hostWorkspaceLayout({ squadId, sandboxId })
    const workRoot = squadId ? layout.workspaceMount : layout.privateMount
    mkdirSync(layout.privateMount, { recursive: true })
    mkdirSync(workRoot, { recursive: true })
    if (!this.shimEnsured) {
      ensureCliShim()
      ensureSshFamilyShims()
      this.shimEnsured = true
    }
    this.sandboxes.set(sandboxId, { sandboxId, squadId, workRoot, lifecycleGeneration: opts.lifecycleGeneration })
    return workRoot
  }

  async attachExistingSandbox(sandboxId: string, opts: SandboxOptions): Promise<boolean> {
    await this.ensureSandbox(sandboxId, opts)
    return true
  }

  async stopSandbox(sandboxId: string, options?: { lifecycleGeneration?: string | null }) {
    await hostStopBeforeFenceHook?.()
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      this.browserBackends.delete(sandboxId)
      return { kind: 'not-found' } as const
    }
    const actualLifecycleGeneration = state.lifecycleGeneration ?? null
    if (options?.lifecycleGeneration !== undefined && actualLifecycleGeneration !== options.lifecycleGeneration) {
      log.warn(
        `Refusing stale sandbox stop for ${sandboxId}: expected generation ${options.lifecycleGeneration ?? 'legacy'}, actual ${actualLifecycleGeneration ?? 'legacy'}`
      )
      return { kind: 'generation-mismatch', actualLifecycleGeneration } as const
    }
    this.sandboxes.delete(sandboxId)
    this.browserBackends.delete(sandboxId)
    // Close this sandbox's browser context now rather than waiting for the
    // engine's 15-min idle sweep. Safe when the engine never started —
    // closeSandboxContext deliberately does not launch one.
    await this.browserEngine?.closeSandboxContext(sandboxId)
    // Only the squad box owns the squad's watcher — a member-agent sandbox
    // stop must never tear down the shared squad watch.
    if (sandboxId.startsWith('squad_')) await this.stopWatch(sandboxId.slice(6))
    return { kind: 'stopped' } as const
  }

  async removeSandbox(sandboxId: string): Promise<void> {
    this.sandboxes.delete(sandboxId)
    this.browserBackends.delete(sandboxId)
    await this.browserEngine?.closeSandboxContext(sandboxId)
    if (sandboxId.startsWith('squad_')) await this.stopWatch(sandboxId.slice(6))
  }

  async cleanup(): Promise<void> {
    for (const squadId of [...this.watchEntries.keys()]) await this.stopWatch(squadId)
    for (const child of this.children) killTree(child)
    this.children.clear()
    this.sandboxes.clear()
    this.browserBackends.clear()
    // Safe to await: closing the browser fires 'disconnected', which the
    // injected onDisconnected seam turns into a warn rather than the
    // engine's default process.exit.
    const engine = this.browserEngine
    this.browserEngine = null
    if (engine) await engine.shutdown()
  }

  // --- Execution ---

  private requireSandbox(sandboxId: string): HostSandboxState {
    const state = this.sandboxes.get(sandboxId)
    if (!state) throw new Error(`No host sandbox tracked for ${sandboxId}. Ensure ensureSandbox() was called.`)
    return state
  }

  private spawnArgv(state: HostSandboxState, args: string[]): ChildProcess {
    if (args.length === 0) throw new Error('exec requires a command')
    const child = spawn(args[0]!, args.slice(1), {
      cwd: state.workRoot,
      // PWD pins the shell's logical cwd to the configured path: without it a
      // fresh bash resolves getcwd() itself, which on macOS reports the
      // `/private/...` physical path for anything under the (symlinked)
      // system tmpdir — surprising agents with a path that doesn't match what
      // was configured or displayed anywhere else.
      env: { ...buildHostCommandEnv({ squadId: state.squadId, base: this.baseEnv() }), PWD: state.workRoot },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.add(child)
    child.once('close', () => this.children.delete(child))
    return child
  }

  getSpawnHook(_sandboxId: string, _workspacePath: string): SpawnHook | null {
    return null
  }

  /** Stdout only — like docker/k8s (`docker/manager.ts` `exec` returns `result.stdout`),
   *  because callers (monitor-supervisor.ts, local-deployment-process-supervisor.ts) parse
   *  the returned buffer verbatim and a login shell's profile routinely writes to stderr. */
  async exec(sandboxId: string, args: string[]): Promise<Buffer> {
    const state = this.requireSandbox(sandboxId)
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const child = this.spawnArgv(state, args)
    child.stdout?.on('data', (c: Buffer) => outChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c))
    let spawnError: Error | null = null
    child.once('error', (err: Error) => (spawnError = err))
    await whenChildSettles(child, 'close')
    if (spawnError) throw spawnError
    const out = Buffer.concat(outChunks)
    // Read the code off the child rather than the event argument: the backstop
    // settles without one, and `exitCode` is the same value the event carries.
    if (child.exitCode === 0) return out
    const err = Buffer.concat(errChunks).toString().trim()
    throw new Error(`Command failed with exit code ${child.exitCode}: ${err || out.toString().trim()}`)
  }

  /** Untracked sandbox: 1, not a throw — matches docker's `execStatus` (`docker/manager.ts`). */
  async execStatus(sandboxId: string, args: string[]): Promise<number> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) return 1
    const child = this.spawnArgv(state, args)
    child.stdout?.resume()
    child.stderr?.resume()
    let spawnError: Error | null = null
    child.once('error', (err: Error) => (spawnError = err))
    await whenChildSettles(child, 'close')
    if (spawnError) throw spawnError
    return child.exitCode ?? 1
  }

  streamExec(
    sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr: (chunk: Buffer) => void = () => {}
  ): { cancel: () => void; cancelAndWait: () => Promise<void> } {
    const state = this.requireSandbox(sandboxId)
    const child = this.spawnArgv(state, args)
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', (err) => onStderr(Buffer.from(err.message)))
    return {
      cancel: () => killTree(child),
      cancelAndWait: async () => {
        killTree(child)
        // Wait on 'exit' (this process is gone), NOT 'close' (every inheritor of
        // our stdio pipes is gone). `sleep` and friends inherit the pipes from
        // the bash we spawned, so whenever a grandchild outlives the leader —
        // killTree's early-return guard and its child.kill() fallback both leave
        // exactly that state — 'close' never fires AT ALL. The tree-kill contract
        // belongs to killTree and is asserted by the caller's survivor check, not
        // to an event a survivor can withhold.
        //
        // Via whenChildSettles rather than a bare listener, because Bun can drop
        // 'exit' outright; its polled backstop settles from the child's own state.
        // Built here rather than at stream setup so a long-lived monitor stream
        // does not carry a 50ms poll for its entire life — an 'exit' that already
        // fired leaves `exitCode` set, which the backstop reads directly.
        await whenChildSettles(child, 'exit')
        // Release OUR read ends. A surviving grandchild holds the write ends, so
        // without this they stay pinned until GC. Cancelling already abandons
        // trailing output, so dropping what is still in the pipe is the contract.
        child.stdout?.destroy()
        child.stderr?.destroy()
      },
    }
  }

  // --- Interactive Terminal ---

  // `_workspacePath` is deliberately ignored on host: the caller (the terminal
  // route) passes the STORAGE workspace path, which is wrong whenever a squad
  // has a host-workspace override — the tracked `state.workRoot` is already
  // override-aware (set by ensureSandbox from hostWorkspaceLayout) and is the
  // one true cwd for this sandboxId.
  spawnShell(sandboxId: string, cols: number, rows: number, _workspacePath?: string): IPty | null {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      log.warn(`spawnShell: no host sandbox tracked for ${sandboxId}`)
      return null
    }
    const cwd = state.workRoot
    const env: Record<string, string> = {
      ...buildHostCommandEnv({ squadId: state.squadId, base: this.baseEnv() }),
      PWD: cwd,
    }
    const shell = env.SHELL || '/bin/bash'
    try {
      return ptySpawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (err) {
      log.warn(`spawnShell: failed to spawn pty for ${sandboxId}:`, err)
      return null
    }
  }

  // --- Workspace watch ---

  /**
   * Configure (or replace) this process's in-process workspace-file watch for
   * a squad, rooted at the override-aware squad workspace. Events feed the
   * same ingest service the sandbox-callback HTTP route uses, directly in
   * process. At most one core process per machine watches a squad (flock
   * election); a sibling owner answers `owned: false`.
   */
  async configureWatch(
    squadId: string,
    config: { include: string[]; exclude: string[] }
  ): Promise<{
    owned: boolean
    fileCount: number
    skipped: Array<{ path: string; reason: string; detail?: string }>
  }> {
    const unsafe = [...config.include, ...config.exclude].find((p) => !isSafeWatchPattern(p))
    if (unsafe) {
      throw new Error(`Unsafe watch pattern "${unsafe}": globs must stay inside the squad workspace`)
    }

    const root = hostWorkspaceLayout({ squadId }).workspaceMount
    let entry = this.watchEntries.get(squadId)
    if (entry && entry.root !== root) {
      // Host workspace override moved — the old watcher is rooted elsewhere.
      await this.stopWatch(squadId)
      entry = undefined
    }

    if (!entry) {
      const lock = await acquireSquadWatchLock(squadId)
      if (!lock) {
        log.debug(`Workspace watch for squad ${squadId} is owned by a sibling core process`)
        return { owned: false, fileCount: 0, skipped: [] }
      }
      const watcher = new WorkspaceWatcher(root, {
        rejectSymlinks: true,
        // The api/worker processes hold their own persistent handles; a host
        // watcher must never single-handedly pin the event loop (a leaked
        // watcher would hang a bare process — e.g. a test process — forever).
        persistent: false,
        sink: async (payload) => {
          if (payload.squadId !== squadId) return // cross-squad guard
          const ingest =
            this.ingestFn ??
            (this.ingestFn = async (id, p) => {
              const { ingestWorkspaceFiles } = await import('../../memory/workspace-files')
              return ingestWorkspaceFiles(id, p)
            })
          await ingest(payload.squadId, payload)
        },
      })
      entry = { watcher, root, lock }
      this.watchEntries.set(squadId, entry)
    }

    const result = await entry.watcher.start({ include: config.include, exclude: config.exclude, squadId })
    return { owned: true, ...result }
  }

  /** Stop this process's watch for a squad and release its machine-wide lock. */
  async stopWatch(squadId: string): Promise<void> {
    const entry = this.watchEntries.get(squadId)
    if (!entry) return
    this.watchEntries.delete(squadId)
    await entry.watcher.stop()
    await entry.lock.release()
  }

  getWatchStatus(squadId: string): { active: boolean; config: unknown } {
    return this.watchEntries.get(squadId)?.watcher.getStatus() ?? { active: false, config: null }
  }

  // --- Browser ---

  /**
   * There is no box to run `ficus-browser` in, so the core drives a locally
   * installed Chrome/Chromium/Edge itself — one shared engine for the
   * process, one browser context (cookie jar) per sandbox. The engine (and
   * the browser process) is built lazily on the first browser verb, so a core
   * whose agents never browse never launches anything.
   */
  getBrowserBackend(sandboxId: string): BrowserBackend | null {
    const existing = this.browserBackends.get(sandboxId)
    if (existing) return existing
    this.browserEngine ??= this.createBrowserEngine()
    const backend = this.browserEngine.forSandbox(sandboxId)
    this.browserBackends.set(sandboxId, backend)
    return backend
  }

  // --- Query ---

  hasSandbox(sandboxId: string): boolean {
    return this.sandboxes.has(sandboxId)
  }

  // `not_found` means "not ensured by THIS process" (the API and worker processes
  // each track their own in-memory sandbox map, so a fresh process reports
  // not_found for a sandboxId a sibling process ensured) — never "does not exist
  // on disk"; ensureSandbox is an idempotent mkdir, so re-ensuring recovers cheaply.
  async getSandboxStatus(sandboxId: string): Promise<{ status: string; reason?: string; devboxReady: boolean }> {
    return { status: this.sandboxes.has(sandboxId) ? 'running' : 'not_found', devboxReady: true }
  }

  toContainerPath(_sandboxId: string, hostPath: string): string {
    return hostPath
  }

  getWorkspaceLayout(ctx: WorkspaceLayoutContext): WorkspaceLayout {
    return hostWorkspaceLayout(ctx)
  }

  getSandboxRuntime(_sandboxId: string): SandboxRuntime | null {
    return 'host'
  }

  async getLocalDeploymentTarget(_sandboxId: string, port: number): Promise<{ host: string; port: number }> {
    return { host: '127.0.0.1', port }
  }

  /** Every host sandbox shares one loopback: a single machine-wide port scope. */
  async getSandboxMachineId(_sandboxId: string): Promise<string | null> {
    return 'host'
  }
}
