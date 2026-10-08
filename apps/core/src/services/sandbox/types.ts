import type { IPty } from 'bun-pty'
import type { AgentTool } from '@earendil-works/pi-agent-core'
// Type-only import (erased at runtime) — workspace-layout imports constants
// from this module, so a value import here would create a cycle.
import type { SandboxToolchainConfig, SandboxToolchainStatus } from '@ficus/shared'
import type { WorkspaceLayout, WorkspaceLayoutContext } from './workspace-layout'
import type { BrowserBackend } from './browser-backend'

/** Sandboxed tool with a stable key for allow/deny lists in agent type config. */
export type SandboxedToolWithKey = AgentTool<any> & { key: string }

/** Container workspace mount point (same for Docker and K8s sandboxes) */
export const WORKSPACE_MOUNT = '/workspace'
/** Container memory mount point base (squad memory mounts at `${MEMORY_MOUNT}/<squadId>`) */
export const MEMORY_MOUNT = '/memory'

/** Extract squad ID from sandbox ID (e.g., "squad_abc123" → "abc123") */
export function getSquadIdFromSandbox(sandboxId: string): string | null {
  if (sandboxId.startsWith('squad_')) {
    return sandboxId.slice(6)
  }
  return null
}

/**
 * Supported sandbox runtime types — the same closed set FICUS_SANDBOX_RUNTIME
 * must name (see ./runtime's SANDBOX_RUNTIME_VALUES, the runtime-side source
 * of truth; this alias exists so manager modules can type their state without
 * importing a value from a module that imports back).
 */
export type SandboxRuntime = 'docker-sysbox' | 'docker-socket' | 'k8s' | 'vm' | 'host'

/**
 * What a caller already knows about a box's liveness. `'listening'` = "its port
 * was seen listening on its machine just now", which under socket activation IS
 * the health signal — see box-manager's `EnsureBoxOpts.liveness`. Only the vm
 * lifecycle tick sets it; request-path ensures leave it undefined so they still
 * probe (and wake) the box.
 */
export type BoxLivenessHint = 'listening'

/** Per-sandboxId lookup of {@link BoxLivenessHint}, threaded through the warmups. */
export type BoxLivenessHintResolver = (sandboxId: string) => BoxLivenessHint | undefined

export interface SandboxOptions {
  /** Agent lifecycle resource incarnation; stale teardown must not touch a newer ensure. */
  lifecycleGeneration?: string
  /** Cancels only this caller while shared provisioning may continue. */
  signal?: AbortSignal
  /**
   * `vm` runtime only: the caller's liveness knowledge for this box (see
   * {@link BoxLivenessHint}). Deliberately NOT part of any spec hash — it is a
   * per-call observation, not part of the box's desired shape. Ignored by the
   * Docker and K8s runtimes.
   */
  boxLiveness?: BoxLivenessHint
  /** Host path to bind-mount as the workspace */
  workspacePath: string
  /** Extra environment variables to pass to the container */
  env?: Record<string, string>
  /** Extra volume mounts (host:container format) */
  volumes?: string[]
  /** Whether the container needs to access services on the host */
  hostAccess?: boolean
  /** Squad this sandbox belongs to (drives K8s squad subPaths and git identity) */
  squadId?: string
  /**
   * Explicit machine pin for the `vm` runtime: when set, the box is placed on
   * this machine (via box-manager placement) rather than the least-loaded shared
   * machine. Sourced from the agent/squad row's nullable `machineId`. Ignored by
   * the Docker and K8s runtimes.
   */
  machineId?: string
  /**
   * `vm` runtime only: provision an isolated VM for this box alone (own-VM dial),
   * bypassing squad-per-VM / commons sharing. Sourced from the agent/squad config
   * by the slice-6 setter; defaults to shared placement when unset. Ignored by the
   * Docker and K8s runtimes.
   */
  dedicated?: boolean
  /** Host path of the per-agent private volume (Docker only; K8s uses k8s.privateStorageKey) */
  privateVolumePath?: string
  /**
   * Docker only, policy input (NOT part of the container spec — excluded from
   * `computeDockerSpecHash`): when true, a spec-hash drift does NOT recreate the
   * container this ensure — the recreate is deferred and the drifted box reused,
   * so an in-flight turn is never torn down mid-execution. Reconciliation
   * happens on a later ensure once idle. Mirrors the k8s drift-recreate gate in
   * `ensure.ts` (`isSessionActive` / `isSquadSandboxIdle`); computed at the
   * ensure layer and passed in here. Ignored by the K8s and VM runtimes.
   */
  hasActiveSession?: boolean
  /** K8s-specific pod configuration (ignored in Docker runtime) */
  k8s?: {
    sandboxType?: 'squad' | 'agent' | 'system-manager'
    alwaysOn?: boolean
    idleTimeout?: number
    runtimeClass?: string
    /** Per-squad ephemeral-storage limit override, in GiB (falls back to the global default). */
    ephemeralStorageLimitGi?: number
    /** PVC subPath key for the per-agent /private volume (K8s only; consumed by Task 5) */
    privateStorageKey?: string
  }
}

export type SpawnHook = (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Options for streaming a sandbox's container logs. */
export interface LogStreamOptions {
  /** Number of trailing lines to include before live output. */
  tailLines?: number
  /** Follow the log stream (default true). */
  follow?: boolean
  /** Read the previous (terminated) container's logs (k8s only). */
  previous?: boolean
}

/**
 * Common interface for sandbox managers (Docker, K8s).
 * All agent tool creation and terminal management goes through this interface.
 */
export interface ManagedToolchainRequest {
  config?: SandboxToolchainConfig
  fingerprint?: string
  devboxJson?: string
  initHooks?: readonly string[]
  readiness?: readonly { id: string; command: string; expectedSubstring: string }[]
  reportStage(status: Extract<SandboxToolchainStatus, 'installing' | 'running_setup'>): Promise<void>
}

export type SandboxStopOutcome =
  | { kind: 'stopped' }
  | { kind: 'not-found' }
  | { kind: 'unverified' }
  | { kind: 'generation-mismatch'; actualLifecycleGeneration: string | null }

export interface SandboxExecOptions {
  /** Per-command environment additions; values are passed out of band, never as argv. */
  env?: Record<string, string>
}

export interface ISandboxManager {
  // --- Lifecycle ---
  ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string>
  /** Adopt a physically existing sandbox without creating or recreating it. */
  attachExistingSandbox?(sandboxId: string, opts: SandboxOptions): Promise<boolean>
  /** Reconcile Ficus's isolated managed toolchain after the physical sandbox is ready. */
  reconcileToolchain?(
    sandboxId: string,
    opts: SandboxOptions,
    request: ManagedToolchainRequest
  ): Promise<'unchanged' | 'applied' | 'cleared'>
  /**
   * `undefined` means an intentional unfenced/manual stop. `null` fences the
   * stop to an unstamped legacy resource; a string fences an exact generation.
   */
  stopSandbox(sandboxId: string, options?: { lifecycleGeneration?: string | null }): Promise<SandboxStopOutcome>
  removeSandbox(sandboxId: string): Promise<void>
  /** Permanently reclaim runtime-specific storage after its owner is non-resumable. */
  reclaimSandboxStorage?(sandboxId: string): Promise<void>
  cleanup(): Promise<void>
  /** Aggregate owner cardinalities safe for operational diagnostics. */
  getResourceDiagnostics?(): {
    portForward: { tracked: number; live: number; starting: number; admissionOwners: number }
  }

  // --- Execution ---
  getSpawnHook(sandboxId: string, workspacePath: string): SpawnHook | null
  /**
   * Run argv in the sandbox and return stdout. `options.env` adds variables to
   * this one command only and never appears in argv, so callers can hand a
   * short-lived secret to a child (for example a Git credential helper).
   */
  exec(sandboxId: string, args: string[], options?: SandboxExecOptions): Promise<Buffer>
  execStatus(sandboxId: string, args: string[]): Promise<number>
  streamExec?(
    sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr?: (chunk: Buffer) => void
  ): { cancel: () => void; cancelAndWait?: () => Promise<void> }

  /** Stream container logs. Returns a cancel handle. K8s + Docker only. */
  streamLogs?(
    sandboxId: string,
    opts: LogStreamOptions,
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void
  ): { cancel: () => void }

  /**
   * Browser driven by the CORE itself rather than by a box (host runtime).
   * Box-backed runtimes leave this absent — their browser tools go through
   * `getClientForSandbox`'s `/browser/*` routes instead.
   */
  getBrowserBackend?(sandboxId: string): BrowserBackend | null

  /**
   * Host runtime only: configure (or replace) this core process's in-process
   * workspace-file watch for a squad, rooted at the override-aware squad
   * workspace. `owned: false` means a sibling core process already owns the
   * machine-wide watch for that squad (nothing was started here).
   */
  configureWatch?(
    squadId: string,
    config: { include: string[]; exclude: string[] }
  ): Promise<{
    owned: boolean
    fileCount: number
    skipped: Array<{ path: string; reason: string; detail?: string }>
  }>
  /** Host runtime only: stop this process's watch for a squad and release its lock. */
  stopWatch?(squadId: string): Promise<void>

  // --- Interactive Terminal ---
  spawnShell(sandboxId: string, cols: number, rows: number, workspacePath?: string): IPty | null

  // --- Spec reconciliation (K8s only) ---
  /** Hash of the spec these options would produce, for drift comparison. */
  computeSpecHash?(opts: SandboxOptions): string
  /** Whether the tracked ready pod's spec is stale relative to opts (in-memory). */
  isSandboxSpecDrifted?(sandboxId: string, opts: SandboxOptions): boolean
  /** Reconcilable-spec hash of the live pod (cluster read), or null if no usable pod. */
  assertProvisionInspectionAllowed?(): Promise<void>
  getRunningSandboxSpecHash?(sandboxId: string): Promise<string | null>
  /** Recreate the sandbox so an otherwise-immutable spec change applies. Gate on idle. */
  recreateSandbox?(sandboxId: string, opts: SandboxOptions): Promise<string>

  // --- Query ---
  hasSandbox(sandboxId: string): boolean
  /** Authoritative runtime status. Missing/unknown must be treated as potentially live. */
  getSandboxStatus?(sandboxId: string): Promise<{ status: string; reason?: string }>
  toContainerPath(sandboxId: string, hostPath: string): string
  /**
   * This runtime's sandbox-side path layout for the given agent context
   * (deterministic — works without a live sandbox). k8s/docker return the
   * fixed container mounts; vm returns box-native absolute paths.
   */
  getWorkspaceLayout(ctx: WorkspaceLayoutContext): WorkspaceLayout
  getSandboxRuntime(sandboxId: string): SandboxRuntime | null
  getLocalDeploymentTarget?(sandboxId: string, port: number): Promise<{ host: string; port: number }>
  /**
   * The machine a sandbox shares a network with, when the runtime co-locates
   * sandboxes on one host. Only the VM runtime implements it; docker and k8s
   * isolate per sandbox and correctly return nothing. Drives local-deployment
   * port scoping (services/deploy/local-deployment-port-scope.ts).
   */
  getSandboxMachineId?(sandboxId: string): Promise<string | null>
}
