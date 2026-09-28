/**
 * VmSandboxManager
 *
 * Implements {@link ISandboxManager} for the `vm` runtime: sandboxes run as
 * per-sandbox unix "boxes" (a `box_<hash>` user + a per-box sandbox-server) on
 * registered machines, reached over slice-1 SSH ControlMaster tunnels. This
 * class is a thin adapter that maps the sandbox-manager contract onto Task 2's
 * box orchestration (`box-manager.ts`) plus the existing k8s `SandboxClient`
 * (HTTP/WS) spoken to the box over its tunnel endpoint.
 *
 * It deliberately mirrors {@link K8sSandboxManager}'s method-to-client mapping
 * (bash/shell arg + return shapes, touch-on-exec bookkeeping, in-memory sandbox
 * tracking) so the two runtimes are behaviourally interchangeable to callers
 * (routes, tools, ensure). Where k8s reads a live cluster, the vm path reads the
 * box-manager (DB row + tunnel health + /healthz).
 *
 * ## What differs from k8s (documented seams)
 *  - `FICUS_API_URL`: the box reaches Core over an SSH reverse tunnel by default
 *    (`resolveBoxApiUrl(machine)`; a direct `APP_URL` is only its degraded
 *    fallback when the tunnel can't be established).
 *  - Spec drift: the running spec hash is baked into the box env
 *    (`FICUS_BOX_SPEC_HASH`) and mirrored in memory. Unlike k8s (which reads the
 *    live pod annotation), the in-memory mirror is empty after a Core restart,
 *    so the first drift check for a box this process never ensured returns
 *    `null` and the box is simply re-ensured — acceptable, and the box-manager
 *    fast-path makes that re-ensure a no-op when the box is already healthy.
 *  - `streamLogs` has no vm backing (a box has no separate "container log"
 *    stream; agent output flows through exec/streamExec), so it is deliberately
 *    NOT implemented: the contract marks it optional and the logs WS guards on
 *    its absence, closing with a clear "not supported" instead of the silent
 *    empty stream a defined no-op used to produce. `getSpawnHook` is null (HTTP
 *    tools, exactly like k8s).
 */

import { createHash } from 'crypto'
import { relative } from 'path'
import type { IPty } from 'bun-pty'
import type { SandboxPressure } from '@ficus/shared'
import {
  getSquadIdFromSandbox,
  type ISandboxManager,
  type SandboxOptions,
  type SandboxRuntime,
  type SpawnHook,
  type ManagedToolchainRequest,
} from '../types'
import {
  BashOutcomeUnknownError,
  SandboxClient,
  SandboxTransportError,
  classifySandboxTransportError,
  type BashResponse,
} from '../k8s/http-client'
import { HttpPtyWrapper } from '../k8s/pty-wrapper'
import { DEFAULT_IDLE_TIMEOUT_MS } from '../k8s/constants'
import { vmBoxAlwaysOnDefault } from './idle'
import {
  clearVmSetupPendingInvocation,
  deleteVmSetupState,
  ensureVmSetupFingerprint,
  getVmSetupState,
  markVmSetupDegraded,
  markVmSetupPending,
  markVmSetupRepairNeeded,
  mergeVmSetupObservedReasons,
  markVmSetupReady,
  markVmSetupReconciling,
  projectVmSetupState,
  restoreVmSetupAfterRequiredAssets,
  setVmSetupPendingInvocation,
  withVmSetupLease,
  type VmSetupState,
  type VmSetupReadiness,
  type VmSetupReasonCode,
} from './setup-state'
import { reconcileVmSetup } from './setup-reconciler'
import { runIdempotentSandboxOperation } from './retry'
import { reconcileRemoteToolchain } from '../toolchain/remote-adapter'
import { buildBashrcContent } from '../bashrc'
import { vmWorkspaceLayout, type WorkspaceLayout, type WorkspaceLayoutContext } from '../workspace-layout'
import { createLogger } from '../../../lib/infra/logger'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { InflightDeduper } from '../../../lib/infra/inflight'
import {
  boxUnixUser,
  computeProvisioningMarker,
  ensureBox as ensureBoxReal,
  removeBox as removeBoxReal,
  stopBox as stopBoxReal,
  boxChainHealth as boxChainHealthReal,
  type BoxChainHealth,
  type BoxEnv,
  type BoxStopResult,
  type BoxStatusWithChain,
  type EnsureBoxOpts,
} from '../../machines/box-manager'
import { resolvePlacement, type PlacementRequest } from '../../machines/placement'
import {
  getMachine as getMachineReal,
  getMachineBox as getMachineBoxReal,
  MachineNotReadyError,
  touchMachineBoxActivity,
  type Machine,
  type MachineBox,
} from '../../machines/queries'
import { machineTunnels, type ForwardRefreshResult } from '../../machines/tunnel-manager'
import {
  createBoxStepTimer,
  formatBoxReadyLine as formatBoxReadyLineReal,
  type BoxReadyContext,
  type BoxStepTimings,
} from '../../machines/box-timing'
import {
  resolveBoxApiTransport as resolveBoxApiTransportReal,
  resolveBoxApiUrl as resolveBoxApiUrlReal,
  type BoxApiTransportResult,
  stableSetupInvocationId,
  type SetupBashFence,
  syncBoxFiles as syncBoxFilesReal,
} from './file-sync'
import { currentBundleVersionCached } from '../../machines/server-bundle'
import {
  computeDevboxInstallInvocationId,
  computeDevboxSeedHash,
  seedBoxDevbox as seedBoxDevboxReal,
} from '../../machines/devbox-seed'
import { gitIdentityEnv, resolveGitHubIdentity as resolveGitHubIdentityReal } from '../github-identity'
import { beginSandboxSetupWork, trackSandboxSetupWork } from '../setup-progress'
import { getSecretStore } from '../../secrets'
import { effectiveMachineScripts, type PrebuiltReadOpts } from '../../machines/machine-prebuilt'

const log = createLogger('vm-sandbox')

// The box's SandboxClient can be spoken to as soon as box-manager's ensureBox
// returns (it has already polled /healthz), so no extra readiness wait is done.

/** Role of a box, mirroring `EnsureBoxOpts['role']` / pod-spec's `sandboxType`. */
type BoxRole = EnsureBoxOpts['role']

/** The vm runtime discriminant (now a first-class member of `SandboxRuntime`). */
const VM_RUNTIME: SandboxRuntime = 'vm'

/**
 * Minimum spacing between persisted activity heartbeats per box. Activity is
 * touched on every exec/shell, so the row write is throttled to a coarse
 * cadence — the idle reaper compares against multi-minute timeouts, for which
 * 30s granularity is ample.
 */
const ACTIVITY_PERSIST_INTERVAL_MS = 30_000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function shellCommandFromArgs(args: string[]): string {
  return args.map(shellQuote).join(' ')
}

/** A box user's HOME (Ubuntu `useradd --create-home` default), mirroring box-manager. */
function boxHome(sandboxId: string): string {
  return `/home/${boxUnixUser(sandboxId)}`
}

/**
 * The box-side working root, mirroring box-manager's `WORKSPACE_PATH` derivation
 * and workspace-layout.ts semantics: squad boxes work in `~/workspace` (the
 * shared squad workspace), agent/system-manager boxes in `~/.private`.
 */
function boxWorkRoot(sandboxId: string, role: BoxRole): string {
  const home = boxHome(sandboxId)
  return role === 'squad' ? `${home}/workspace` : `${home}/.private`
}

/** Derive a box role from the sandboxId prefix (squad_/system_manager_/agent_). */
export function safeVmRecoveryDiagnostic(error: unknown): { failureClass: string; phase?: string } {
  if (error instanceof BashOutcomeUnknownError) return { failureClass: error.failureClass, phase: 'bash' }
  const transport = error instanceof SandboxTransportError ? error : classifySandboxTransportError(error)
  return transport
    ? { failureClass: transport.kind, ...(transport.phase ? { phase: transport.phase } : {}) }
    : { failureClass: 'unknown' }
}

export function computeVmSetupFingerprint(input: {
  specHash: string
  devboxSeedHash: string
  bashrcContent: string
  gitCredentialsRequired: boolean
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }))
    .digest('hex')
}

function roleFromSandboxId(sandboxId: string): BoxRole {
  if (sandboxId.startsWith('squad_')) return 'squad'
  if (sandboxId.startsWith('system_manager_')) return 'system-manager'
  return 'agent'
}

/**
 * Resolve the effective role: the sandboxId PREFIX is authoritative.
 *
 * Every durable box id carries its role (`squad_` / `system_manager_` /
 * `agent_`), and the three BoxRole values map 1:1 onto those prefixes, so
 * `opts.k8s.sandboxType` adds no information — it only creates divergence
 * when callers disagree. They did: ensureWorkspaceSandbox (the per-turn
 * runner path) hardcodes 'agent' for every non-squad box while the vm
 * lifecycle recovery ensures the same `system_manager_<userId>` box as
 * 'system-manager', so the box flip-flopped identity — role, FICUS_SANDBOX_ROLE
 * (light vs heavy runtime), spec hash, and therefore the provisioning
 * marker — depending on which caller ensured it last, restarting its systemd
 * unit on each flip. A caller-provided sandboxType that disagrees with the
 * prefix is logged and ignored.
 */
function resolveRole(sandboxId: string, opts?: SandboxOptions): BoxRole {
  const role = roleFromSandboxId(sandboxId)
  const requested = opts?.k8s?.sandboxType
  if (requested && requested !== role) {
    log.warn(`Ignoring caller sandboxType '${requested}' for ${sandboxId}: id prefix determines role '${role}'`)
  }
  return role
}

/** State tracked per active box (in-memory; mirrors K8sSandboxState). */
interface VmSandboxState {
  sandboxId: string
  machineId: string
  role: BoxRole
  endpoint: string
  client: SandboxClient
  /** The box auth token this client was built with; a rotation must not be reused. */
  authToken: string | undefined
  /** Core-side host workspace path (used by toContainerPath rebasing). */
  workspacePath: string
  /** Box-side working root (exec/shell cwd). */
  workRoot: string
  /** API URL baked into this box's env (re-injected into shell sessions). */
  apiUrl: string
  /** Last exec/shell activity (epoch ms). Slice 4's keepalive consumes this. */
  lastActivityAt: number
  /**
   * When the activity heartbeat was last persisted to the box's row (epoch ms).
   * {@link VmSandboxManager.touch} writes the row at most every
   * {@link ACTIVITY_PERSIST_INTERVAL_MS} so per-exec touches stay cheap.
   */
  lastPersistedActivityAt: number
  /**
   * Idle timeout in ms after which an inactive box is parked (from
   * `opts.k8s.idleTimeout`, else {@link DEFAULT_IDLE_TIMEOUT_MS}). Consumed by
   * slice 4's idle reaper via {@link getLifecycleState}.
   */
  idleTimeoutMs: number
  /** When true, the box is never parked for inactivity (from `opts.k8s.alwaysOn`). */
  alwaysOn: boolean
  /** Reconcilable spec hash baked into the box env at ensure time. */
  specHash: string
  /** Original ensure options retained for due best-effort setup repair. */
  options: SandboxOptions
}

/** Idle-policy view of a tracked box, consumed by slice 4's idle reaper. */
export type VmSetupRetireOutcome =
  | { kind: 'retired' }
  | { kind: 'unverified' }
  | { kind: 'generation-mismatch'; actualLifecycleGeneration: string | null }

export interface VmLifecycleState {
  lastActivityAt: number
  idleTimeoutMs: number
  alwaysOn: boolean
  status: string
}

/** All external effects the manager drives, injectable for tests; each defaults to production. */
export interface VmSandboxManagerDeps {
  ensureBox(opts: EnsureBoxOpts): Promise<{
    machine: Machine
    box: MachineBox
    endpoint: string
    /** box-manager's own timing breakdown (artifacts/provision/start, or health on the fast path) — folded into the ensure's "Box ready" summary line. */
    timings?: BoxStepTimings
    /** See box-timing.ts's `BoxReadyContext.priorBoxesOnMachine`. */
    priorBoxesOnMachine?: number
  }>
  stopBox(sandboxId: string): Promise<BoxStopResult>
  removeBox(sandboxId: string, opts: { archivePrivate?: boolean; timeoutMs?: number }): Promise<void>
  /** Live box status + the {@link BoxChainHealth} breakdown the VM chain-health UI surfaces. */
  boxChainHealth(sandboxId: string): Promise<BoxStatusWithChain>
  /**
   * Release THIS process's local forwards to a machine on shutdown — never the
   * shared ControlMaster itself. The master (one control socket per machine) is
   * shared by BOTH core processes (api + worker adopt the same socket) and
   * carries the reverse forward whose remote port boxes baked into FICUS_API_URL,
   * so an `-O exit` here would sever the OTHER process's forwards and every
   * box's callback URL; ensureBox's healthy fast-path never re-pushes
   * server.env, leaving the boxes' CLI pointed at a dead port until a full
   * re-provision. Genuine machine teardown (delete/park) still goes through
   * `machineTunnels.closeMachine`.
   */
  releaseMachineForwards(machineId: string): Promise<void>
  /** The box's DB row — the cross-process source of truth for attach-on-miss. */
  getMachineBox(sandboxId: string): Promise<MachineBox | null>
  /** A machine row by id (attach-on-miss resolves the box's host machine). */
  getMachine(machineId: string): Promise<Machine | null>
  /** Ensure the machine's shared ControlMaster (adopts a live socket). */
  ensureMaster(machine: Machine): Promise<void>
  /** Local-forward a remote box port over the master; returns the local port. */
  addForward(machine: Machine, remotePort: number): Promise<number>
  /** Atomically replace one exact local forward without disturbing sibling boxes. */
  refreshForward(machine: Machine, remotePort: number): Promise<number>
  refreshForwardDetailed?(machine: Machine, remotePort: number): Promise<ForwardRefreshResult>
  /**
   * Drop THIS process's tunnel forward for a (machine, box-port) pair. Keyed by
   * ids because the trigger is a `box.status` event (which carries no hydrated
   * Machine row). No-op when this process holds no such forward.
   */
  removeForward(machineId: string, remotePort: number): Promise<void>
  /** Persist the coarse cross-process activity heartbeat (caller throttles). */
  persistBoxActivity(sandboxId: string, atMs: number): Promise<void>
  /** Build a SandboxClient for a box endpoint (`host:port`, no scheme). The
   *  box's per-box executor auth token (machine_boxes.authToken) is presented
   *  as a bearer header on every request; undefined for legacy boxes whose row
   *  predates the token (their server does not enforce yet). */
  createClient(endpoint: string, authToken?: string): SandboxClient
  resolveGitHubIdentity(squadId?: string | null): Promise<{
    gitUserName?: string
    gitUserEmail?: string
  }>
  getSecret(key: string): string | undefined
  /** Current sandbox-server bundle version (process-stable; folded into the spec hash). */
  getBundleVersion(): Promise<string>
  /** Current box-provision script version (folded into the spec hash). */
  getBoxProvisionVersion(): string
  /** Public core URL for the box's `APP_URL` (Task 4 seam). */
  getAppUrl(): string | undefined
  /**
   * The box's callback URL — an SSH reverse tunnel to `machine` by DEFAULT
   * (it rides the same SSH connection Core uses to reach the box, so it works
   * whenever the box works), with a direct `APP_URL` only as the degraded
   * fallback when the tunnel can't be established. See file-sync.ts's
   * `resolveBoxApiUrl` for the full rationale.
   */
  resolveBoxApiUrl(machine: Machine): Promise<string>
  resolveBoxApiTransport?(machine: Machine): Promise<BoxApiTransportResult>
  /**
   * Resolve the machine a box will live on, ONCE per ensure, via the full
   * role/scope-aware {@link resolvePlacement} policy (design §7 + B2): every box
   * best-fit unit-packs onto the shared exe VM pool (provisioning when nothing
   * fits), a dedicated VM when requested, an explicit pin when supplied, and the
   * legacy least-loaded shared machine on BYO-only (no cloud provider) deployments.
   * A live recorded box still sticks to its ready machine (resolvePlacement's sticky
   * step). The resolved machine is both handed to `ensureBox` (as its `machineId`)
   * and used to build the box's callback URL, so the reverse tunnel and the box
   * always target the SAME machine — no second, potentially divergent placement.
   */
  resolveMachine(req: PlacementRequest): Promise<Machine>
  /** Push the k8s-PVC-equivalent artifacts into a reachable box over `/write`.
   *  The box row is threaded in (its `syncedHashes` drive the per-asset
   *  content-hash skip; its `machineId` guards the stamp) so file-sync needs no
   *  per-asset DB read. */
  syncBoxFiles(
    client: SandboxClient,
    sandboxId: string,
    opts: SandboxOptions,
    box: MachineBox,
    bashFence?: SetupBashFence,
    trackSetupWork?: <T>(operation: () => Promise<T>) => Promise<T>
  ): Promise<void>
  /**
   * Seed + realize the box's devbox comfort set (the tools the k8s image baked).
   * NON-fatal at the call site (unlike syncBoxFiles): the seeder throws on failure
   * but a box works with a degraded shell, so the manager logs WARN and proceeds.
   * Returns a devbox-resolve/devbox-realize timing breakdown (see devbox-seed.ts)
   * for the "Box ready" summary line — `{}` when the idempotency marker skipped
   * the install entirely.
   */
  seedBoxDevbox(client: SandboxClient, sandboxId: string, role: BoxRole, invocationId?: string): Promise<BoxStepTimings>
  getSetupState(sandboxId: string): Promise<VmSetupState | null>
  deleteSetupState(sandboxId: string): Promise<void>
  withSetupLease<T>(sandboxId: string, fn: () => Promise<T>): Promise<T>
  ensureSetupFingerprint(sandboxId: string, fingerprint: string): Promise<VmSetupState>
  markSetupPending(sandboxId: string, fingerprint: string, now: Date): Promise<boolean>
  restoreSetupAfterAssets(sandboxId: string, fingerprint: string, prior: VmSetupState, now: Date): Promise<boolean>
  markSetupReconciling(sandboxId: string, fingerprint: string, now: Date): Promise<boolean>
  setSetupPendingInvocation(
    sandboxId: string,
    fingerprint: string,
    invocationId: string,
    kind: string
  ): Promise<boolean>
  clearSetupPendingInvocation(sandboxId: string, fingerprint: string, invocationId: string): Promise<boolean>
  markSetupRepairNeeded(
    sandboxId: string,
    fingerprint: string,
    reason: VmSetupReasonCode,
    now: Date
  ): Promise<VmSetupState | null>
  mergeSetupObservedReasons(
    sandboxId: string,
    fingerprint: string,
    reasons: VmSetupReasonCode[],
    now: Date
  ): Promise<VmSetupState | null>
  markSetupDegraded(input: {
    sandboxId: string
    fingerprint: string
    reasons: VmSetupReasonCode[]
    lastFailureClass?: string
    squadId?: string
    now?: Date
  }): Promise<VmSetupState | null>
  markSetupReady(sandboxId: string, fingerprint: string, now: Date): Promise<boolean>
  now(): number
  /**
   * Render the "Box ready" summary line (see box-timing.ts's module doc).
   * Injectable ONLY so tests can prove the call site tolerates a throw —
   * measurement must never fail box creation (see the try/catch around its
   * one call site in `_ensureSandbox`).
   */
  formatBoxReadyLine(
    sandboxId: string,
    machineId: string,
    totalMs: number,
    steps: BoxStepTimings,
    context: BoxReadyContext
  ): string
}

/**
 * Hash the box-provision script into {@link VmSandboxManager.computeSpecHash}'s
 * `provisionVersion` ingredient; memoized so the (synchronous) spec hash stays
 * cheap. Same formula as before — sha256 hex, first 16 chars — only the SOURCE
 * of the bytes changed, so a git-checkout run keeps producing the exact value it
 * always did and no box's spec hash shifts under it.
 *
 * The bytes come from {@link effectiveMachineScripts}: the copy inlined at build
 * time (`with { type: 'text' }`) in a source/bundle run, the release's own
 * prebuilt `machine/box-provision.sh` in an artifact deployment — the SAME
 * resolution `bootstrapMachine`, `currentBootstrapVersion` and
 * `boxProvisionArtifact` use, so this hash tracks the script the machines
 * actually receive.
 *
 * This replaced a runtime `readFileSync` of `scripts/machine/box-provision.sh`
 * at a path relative to `import.meta.dir`, with a catch-all that memoized the
 * literal `'noscript'`. That path resolves only in a src-layout run: production
 * runs the bundle (`bun run dist/index.js`), where `import.meta.dir` is
 * `apps/core/dist` and the six-level traversal lands outside the repo entirely —
 * so every deployed core hashed `'noscript'` forever and the box spec hash
 * silently stopped tracking box-provision.sh (script changes never recreated a
 * box; only bundle/role/squad changes did). Deploying this fix therefore flips
 * `provisionVersion` once on every already-deployed core, which reads as spec
 * drift for every existing box: each drifted box is parked and fully
 * re-provisioned once, when idle (agent boxes: no active session; squad boxes:
 * the idle gate in reconcileSquadSandboxSpecs). That re-provision is
 * non-destructive — park keeps the box's home, and box-provision.sh's provision
 * mode is idempotent over an existing user — but it is a one-time fleet-wide
 * re-provision pass, which is the deliberate price of the ingredient becoming
 * live again.
 *
 * `opts` is a test seam (mirrors `currentBootstrapVersion`); production calls it
 * with no arguments.
 */
export function defaultBoxProvisionVersion(opts: PrebuiltReadOpts = {}): () => string {
  let cached: string | null = null
  return () => {
    if (cached === null) {
      cached = createHash('sha256').update(effectiveMachineScripts(opts).boxProvisionScript).digest('hex').slice(0, 16)
    }
    return cached
  }
}

function productionDeps(): VmSandboxManagerDeps {
  return {
    ensureBox: (opts) => ensureBoxReal(opts),
    stopBox: (sandboxId) => stopBoxReal(sandboxId),
    removeBox: (sandboxId, opts) => removeBoxReal(sandboxId, opts),
    boxChainHealth: (sandboxId) => boxChainHealthReal(sandboxId),
    releaseMachineForwards: (machineId) => machineTunnels.cancelMachineForwards(machineId),
    getMachineBox: (sandboxId) => getMachineBoxReal(sandboxId),
    getMachine: (machineId) => getMachineReal(machineId),
    ensureMaster: (machine) => machineTunnels.ensureMaster(machine),
    addForward: (machine, remotePort) => machineTunnels.addForward(machine, remotePort),
    refreshForward: (machine, remotePort) => machineTunnels.refreshForward(machine, remotePort),
    refreshForwardDetailed: (machine, remotePort) => machineTunnels.refreshForwardDetailed(machine, remotePort),
    removeForward: (machineId, remotePort) => machineTunnels.removeForwardById(machineId, remotePort),
    persistBoxActivity: (sandboxId, atMs) => touchMachineBoxActivity(sandboxId, new Date(atMs)),
    // SandboxClient constructor prepends `http://`, so pass a bare `host:port`.
    createClient: (endpoint, authToken) => new SandboxClient(endpoint, authToken),
    resolveGitHubIdentity: (squadId) => resolveGitHubIdentityReal(squadId),
    getSecret: (key) => getSecretStore().get(key),
    getBundleVersion: async () => (await currentBundleVersionCached()).version,
    getBoxProvisionVersion: defaultBoxProvisionVersion(),
    getAppUrl: () => process.env.APP_URL,
    resolveBoxApiUrl: (machine) => resolveBoxApiUrlReal(machine),
    resolveBoxApiTransport: (machine) => resolveBoxApiTransportReal(machine),
    resolveMachine: (req) => resolvePlacement(req),
    syncBoxFiles: (client, sandboxId, opts, box, bashFence, trackSetupWork) =>
      syncBoxFilesReal(client, sandboxId, opts, {
        box: { machineId: box.machineId, syncedHashes: box.syncedHashes },
        bashFence,
        trackSetupWork,
      }),
    seedBoxDevbox: (client, sandboxId, role, invocationId) =>
      seedBoxDevboxReal(client, sandboxId, role, {}, invocationId),
    getSetupState: (sandboxId) => getVmSetupState(sandboxId),
    deleteSetupState: (sandboxId) => deleteVmSetupState(sandboxId),
    withSetupLease: (sandboxId, fn) => withVmSetupLease(sandboxId, fn),
    ensureSetupFingerprint: (sandboxId, fingerprint) => ensureVmSetupFingerprint(sandboxId, fingerprint),
    markSetupPending: (sandboxId, fingerprint, now) => markVmSetupPending(sandboxId, fingerprint, now),
    restoreSetupAfterAssets: (sandboxId, fingerprint, prior, now) =>
      restoreVmSetupAfterRequiredAssets(sandboxId, fingerprint, prior, now),
    markSetupReconciling: (sandboxId, fingerprint, now) => markVmSetupReconciling(sandboxId, fingerprint, now),
    setSetupPendingInvocation: (sandboxId, fingerprint, invocationId, kind) =>
      setVmSetupPendingInvocation(sandboxId, fingerprint, invocationId, kind),
    clearSetupPendingInvocation: (sandboxId, fingerprint, invocationId) =>
      clearVmSetupPendingInvocation(sandboxId, fingerprint, invocationId),
    markSetupRepairNeeded: (sandboxId, fingerprint, reason, now) =>
      markVmSetupRepairNeeded(sandboxId, fingerprint, reason, now),
    mergeSetupObservedReasons: (sandboxId, fingerprint, reasons, now) =>
      mergeVmSetupObservedReasons(sandboxId, fingerprint, reasons, now),
    markSetupDegraded: (input) => markVmSetupDegraded(input),
    markSetupReady: (sandboxId, fingerprint, now) => markVmSetupReady(sandboxId, fingerprint, now),
    now: () => Date.now(),
    formatBoxReadyLine: (sandboxId, machineId, totalMs, steps, context) =>
      formatBoxReadyLineReal(sandboxId, machineId, totalMs, steps, context),
  }
}

/** The status shape callers destructure — mirrors K8sPodManager.queryPodStatus. */
export interface VmSandboxStatus {
  status: 'running' | 'starting' | 'failed' | 'not_found'
  reason?: string
  devboxReady?: boolean
  readiness?: VmSetupReadiness
  degradation?: {
    reasons: VmSetupReasonCode[]
    attemptCount: number
    nextAttemptAt?: string
  }
  /**
   * Chain-health breakdown (machine reachable / box provisioned / box server
   * up) backing the VM sandbox UI's status — see {@link BoxChainHealth}.
   */
  chain?: BoxChainHealth
  /** Load and memory from the box's last health check; absent for an idle box. */
  pressure?: SandboxPressure
}

function lifecycleGenerationFromVmSpecHash(specHash: string | null | undefined): string | null {
  const match = specHash?.match(/^lifecycle:([^:]+):/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * SSH budget for a box removal, which is dominated by `box-provision --remove`'s
 * `tar czf` over the WHOLE home before `userdel`.
 *
 * The runner's 30s default is not a budget for that work, and removeBoxUserOnMachine
 * says so: "on the runner's 30s default a stale multi-GB squad ~/workspace cannot
 * be removed at all. Callers that know the home may be big pass their own budget."
 * This caller never passed one — and a personal box is exactly the case that
 * outgrows 30s quietly.
 *
 * What that cost: gzipping a 549MB home ran past 30s, the caller recorded a
 * timeout as a failure, the cleanup sweep retried every 60s, and each retry
 * re-tarred the same still-live box. Three boxes wrote 240 tarballs and 42GB onto
 * the machine host and filled its disk — after which tar failed with ENOSPC too,
 * so the host could not recover on its own.
 *
 * Five minutes matches BOX_PROVISION_RUN_TIMEOUT_MS: removal is the same shape of
 * work as provisioning and deserves the same patience. This is a background sweep,
 * so waiting is nearly free; the failure it replaces was an unbounded retry loop
 * that could never succeed.
 */
const BOX_REMOVE_ARCHIVE_TIMEOUT_MS = 5 * 60_000

export class VmSandboxManager implements ISandboxManager {
  private readonly deps: VmSandboxManagerDeps
  private readonly sandboxes = new Map<string, VmSandboxState>()
  private readonly inflight = new InflightDeduper<string>()
  private readonly connectionGates = new Map<string, Promise<void>>()
  /**
   * Clients attached on-demand ({@link getOrAttachClient}) for boxes ANOTHER
   * process ensured — this process holds a tunnel + client but no full
   * {@link VmSandboxState} (no env/spec/work-root: it never built the box).
   * Superseded by a full ensure and dropped on stop/remove/cleanup.
   */
  private readonly attachedClients = new Map<string, SandboxClient>()
  /** In-flight attach per sandboxId (dedupes concurrent getOrAttachClient misses). */
  private readonly attachInflight = new Map<string, Promise<SandboxClient | null>>()
  /** In-flight connection replacement per sandboxId. */
  private readonly recoveryInflight = new Map<string, Promise<SandboxClient>>()
  private readonly healthObservations = new Map<string, { uptimeSeconds: number; observedAtMs: number }>()
  /**
   * sandboxIds whose `box.status` stop/gone event arrived WHILE an attach was
   * in flight ({@link attachInflight}). The event's invalidation finds nothing
   * cached yet, so {@link attachClient} re-checks this set after its awaits and
   * aborts instead of caching a client for a dead box (whose reallocated
   * MAX(port)+1 port could silently route into a DIFFERENT box). Entries are
   * only ever added while an attach is in flight and are cleared when that
   * attach settles, so the set cannot grow unboundedly.
   */
  private readonly attachTombstones = new Set<string>()
  /** Machines this manager forwarded to (cleanup releases only these processes' forwards). */
  private readonly touchedMachines = new Set<string>()
  /** Process-stable bundle version, cached for the synchronous computeSpecHash. */
  private bundleVersion = ''
  /** Unsubscribe hook for the cross-process box.status invalidation listener. */
  private readonly unsubscribeBoxStatus: () => void

  constructor(deps: Partial<VmSandboxManagerDeps> = {}) {
    const merged = { ...productionDeps(), ...deps }
    if (deps.refreshForward && !deps.refreshForwardDetailed) delete merged.refreshForwardDetailed
    if (deps.resolveBoxApiUrl && !deps.resolveBoxApiTransport) delete merged.resolveBoxApiTransport
    this.deps = merged
    // Cross-process invalidation: box-manager announces every teardown over the
    // DISTRIBUTED event emitter, so a stop/remove served by the other core
    // process (whose removeForward cannot touch our in-memory maps) still drops
    // our stale client + forward. Vital because box ports are reallocated
    // MAX(port)+1: a stale forward on a reused port would silently talk to a
    // DIFFERENT box.
    this.unsubscribeBoxStatus = eventEmitter.on('box.status', (data) => this.onBoxStatus(data))
    // Warm the bundle version so computeSpecHash reflects it even before the
    // first ensure. The build is memoized per process, so this runs once.
    void this.deps
      .getBundleVersion()
      .then((v) => {
        this.bundleVersion = v
      })
      .catch(() => {
        /* first ensure will populate it */
      })
    log.info('Initialized VmSandboxManager')
  }

  private async acquireConnection(sandboxId: string): Promise<() => void> {
    const previous = this.connectionGates.get(sandboxId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.connectionGates.set(sandboxId, tail)
    await previous
    return () => {
      release()
      if (this.connectionGates.get(sandboxId) === tail) this.connectionGates.delete(sandboxId)
    }
  }

  // --- Lifecycle ---------------------------------------------------------

  async ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    return this.inflight.run(sandboxId, () => this._ensureSandbox(sandboxId, opts))
  }

  private async _ensureSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    const releaseConnection = await this.acquireConnection(sandboxId)
    let connectionReleased = false
    try {
      // Box-creation timing (measurement only — see box-timing.ts's module doc).
      // ONE clock for the whole ensure: this.deps.now(), the same clock every
      // other timestamp in this method (and box-manager.ts's ensureBox, and
      // devbox-seed.ts's install-stream watcher) is built from.
      const timer = createBoxStepTimer(() => this.deps.now())
      const startedAt = this.deps.now()

      const role = resolveRole(sandboxId, opts)

      // Resolve the squad BEFORE hashing: the spec hash (and through it the
      // provisioning marker) must be a function of the BOX, not of whichever
      // caller happens to run this ensure. The squad is taken from opts (a
      // squad-scoped agent) else the squad_<id> sandboxId — the SAME fallback
      // placement and buildBoxEnv use — so a partial-opts caller (no squadId)
      // computes the same marker as the canonical ensure. Before this, such a
      // caller drifted the marker, box-manager's healthy fast path missed, and
      // the box's systemd unit was RESTARTED — then restarted AGAIN on the next
      // keep-warm tick when the real opts drifted the marker back (killing
      // terminal shells and running agent commands at a ~60s drumbeat).
      const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined

      // Refresh the cached bundle version (process-stable) before hashing.
      this.bundleVersion = await this.deps.getBundleVersion()
      const specHash = this.canonicalSpecHash(sandboxId, opts)

      // Resolve the machine ONCE via the full role/scope placement policy (§7:
      // squad-per-VM / commons / dedicated / explicit pin / BYO least-loaded), then
      // build the env — including the reverse-tunnel callback URL — against THAT
      // machine and hand its id to ensureBox, so the box and its callback never
      // diverge. Absent a squad, placement treats the box as a solo agent
      // (commons). `dedicated` is threaded from opts (slice-6 setter; default false).

      // Placement→bind is not atomic: the empty-machine reaper can CLAIM the
      // resolved machine (status 'ready'→'reaping') between resolveMachine and
      // ensureBox's bind, which then rejects with MachineNotReadyError rather
      // than binding onto a VM that is being terminated. That rejection is
      // re-placeable, not fatal: re-run the WHOLE resolve→env→ensure sequence —
      // placement never offers a non-ready machine, and the env (reverse-tunnel
      // callback URL) is machine-specific so it must be rebuilt against the new
      // machine. Bounded to one re-place: losing the race twice in a row means
      // something is systemically wrong, so surface it.
      const MAX_PLACEMENT_ATTEMPTS = 2
      let env!: BoxEnv
      let placed!: Awaited<ReturnType<VmSandboxManagerDeps['ensureBox']>>
      let finishPhysicalSetup: ((outcome: 'ready' | 'failed') => void) | undefined
      const beginPhysicalWork = (reason: 'runtime_start' | 'runtime_reconnect' | 'spec_reconcile') => {
        finishPhysicalSetup ??= beginSandboxSetupWork(this, sandboxId, reason)
        return (outcome: 'ready' | 'failed') => {
          // A reaper-claim race is retried below. Keep one widest operation open
          // across attempts and settle it only on eventual success or terminal failure.
          if (outcome === 'ready') {
            finishPhysicalSetup?.('ready')
            finishPhysicalSetup = undefined
          }
        }
      }
      for (let attempt = 1; ; attempt++) {
        const machine = await timer.time('placement', () =>
          this.deps.resolveMachine({
            sandboxId,
            role,
            squadId,
            explicitMachineId: opts.machineId ?? null,
            dedicated: opts.dedicated ?? false,
          })
        )
        env = await this.buildBoxEnv(sandboxId, opts, specHash, machine, timer)

        try {
          placed = await this.deps.withSetupLease(sandboxId, () =>
            this.deps.ensureBox({
              sandboxId,
              machineId: machine.id,
              env,
              role,
              // NOT the bare specHash (that's also baked into env.FICUS_BOX_SPEC_HASH
              // above) — computeProvisioningMarker folds a hash of `env` in too, so
              // box-manager's PARKED-box resume fast path also busts on a rotated
              // secret, not only a bundle/role/provision-script change. See its doc.
              specHash: computeProvisioningMarker(specHash, env),
              // The caller's liveness observation, if any. Set only by the vm
              // lifecycle tick (one `ss -ltnH` per machine), so its keep-warm
              // ensures never HTTP-probe — and therefore never wake — a
              // socket-activated box that has deliberately stood down.
              liveness: opts.boxLiveness,
              beginPhysicalWork,
            })
          )
          timer.merge(placed.timings)
          break
        } catch (err) {
          if (err instanceof MachineNotReadyError && attempt < MAX_PLACEMENT_ATTEMPTS) {
            log.warn(
              `Machine ${machine.id} stopped accepting binds (likely reaper-claimed) between placement and ` +
                `bind for ${sandboxId}; re-placing (attempt ${attempt}/${MAX_PLACEMENT_ATTEMPTS})`
            )
            continue
          }
          finishPhysicalSetup?.('failed')
          finishPhysicalSetup = undefined
          throw err
        }
      }
      const { machine: placedMachine, box, endpoint } = placed
      this.touchedMachines.add(placedMachine.id)

      // Refresh the row activity heartbeat unconditionally, once per ensure:
      // box-manager only seeds it on the full-provision path (its healthy
      // fast-path returns BEFORE the ready upsert), so a re-ensure over an
      // already-healthy box would otherwise leave a stale row heartbeat — and the
      // OTHER process's idle reaper reads max(local, row), both stale, parking a
      // live box under an active session. Fire-and-forget like touch(): a failed
      // heartbeat write must never fail the ensure.
      const ensuredAt = this.deps.now()
      void this.deps.persistBoxActivity(sandboxId, ensuredAt).catch((err) => {
        log.warn(`Failed to persist ensure activity heartbeat for ${sandboxId}:`, err)
      })

      // SandboxClient prepends the scheme itself; pass a bare host:port. The
      // box's executor auth token rides along so every request passes the
      // server's per-box auth gate (null for legacy rows → no header, and the
      // legacy server does not enforce).
      const boxAuthToken = box.authToken ?? undefined
      const existing = this.sandboxes.get(sandboxId)
      // Reuse the live client when nothing addressable changed. close() aborts EVERY
      // in-flight request on a client, and an aborted /bash stream ends without a
      // terminal exitCode — which the bash reader reports as BashOutcomeUnknownError
      // ("Bash invocation outcome is unknown; cleanup proof is required"). The
      // keep-warm sweep re-ensures already-healthy boxes about once a minute, so
      // swapping the client unconditionally here silently killed any agent command
      // that happened to be running at that moment: long execs, builds, and monitors
      // died at a ~60s drumbeat while the box itself was perfectly healthy. Only a
      // genuinely different target (new machine, new forward, rotated token) needs a
      // new client — and only then is closing the old one correct.
      const reusableClient =
        existing !== undefined &&
        existing.endpoint === endpoint &&
        existing.machineId === placedMachine.id &&
        existing.authToken === boxAuthToken
      let client = reusableClient ? existing.client : this.deps.createClient(stripScheme(endpoint), boxAuthToken)
      if (existing && !reusableClient) existing.client.close()
      // A full ensure supersedes any read-only attached client for this box.
      this.dropAttachedClient(sandboxId)

      this.sandboxes.set(sandboxId, {
        sandboxId,
        machineId: placedMachine.id,
        role,
        endpoint,
        client,
        authToken: boxAuthToken,
        workspacePath: opts.workspacePath,
        workRoot: boxWorkRoot(sandboxId, role),
        apiUrl: env.FICUS_API_URL ?? '',
        lastActivityAt: ensuredAt,
        // The heartbeat write above just refreshed the row (regardless of which
        // box-manager path the ensure took), so the first persisted touch can
        // wait a full throttle interval.
        lastPersistedActivityAt: ensuredAt,
        // Seed the idle policy from the caller's opts (k8s idleTimeout is already in
        // ms; see ensure.ts). Re-ensure rebuilds this state object, so a user toggle
        // of alwaysOn / idleTimeout is naturally picked up (mirrors k8s pod-manager's
        // refresh of existing.alwaysOn/idleTimeout on a re-ensure).
        idleTimeoutMs: opts.k8s?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
        // The vm-wide always-on default (see vmBoxAlwaysOnDefault's doc) wins over
        // the caller's requested value — a box is always-on if EITHER the caller
        // opted in OR the runtime default policy is on (the common case today).
        // Setting FICUS_VM_BOX_PARK_ON_IDLE=true drops the OR down to the caller's
        // own opts.k8s.alwaysOn, restoring pre-policy behavior exactly.
        alwaysOn: (opts.k8s?.alwaysOn ?? false) || vmBoxAlwaysOnDefault(),
        specHash,
        options: opts,
      })

      releaseConnection()
      connectionReleased = true

      const setupWorkRoot = boxWorkRoot(sandboxId, role)
      const setupFingerprint = computeVmSetupFingerprint({
        specHash,
        devboxSeedHash: computeDevboxSeedHash(role),
        bashrcContent: buildBashrcContent(setupWorkRoot, setupWorkRoot, {
          devboxDir: `${boxHome(sandboxId)}/.tau/devbox`,
        }),
        gitCredentialsRequired: false,
      })

      // Serialize fingerprint publication, required asset sync, and all
      // best-effort components as one durable setup generation. No other Core
      // process may replace the desired fingerprint while this generation runs.
      const setupResult = await this.deps.withSetupLease(sandboxId, async () => {
        // Publish pending readiness before required asset sync. The box manager
        // has already made the physical server reachable, but API status must
        // remain `starting` until required files are safely present.
        const durableSetup = await this.deps.ensureSetupFingerprint(sandboxId, setupFingerprint)
        if (durableSetup.pendingInvocationId) {
          try {
            try {
              await client.cancelBashInvocation(durableSetup.pendingInvocationId, 'transport-loss')
            } catch (error) {
              client = await this.recoverClient(sandboxId, client, error as Error)
              await client.cancelBashInvocation(durableSetup.pendingInvocationId, 'transport-loss')
            }
            if (
              !(await this.deps.clearSetupPendingInvocation(
                sandboxId,
                setupFingerprint,
                durableSetup.pendingInvocationId
              ))
            ) {
              throw new Error(`VM setup fingerprint changed while clearing invocation ${sandboxId}`)
            }
          } catch (error) {
            throw new Error(`VM setup invocation cleanup remains unproven for ${sandboxId}`, { cause: error })
          }
        }

        // Required assets remain fatal. A failure leaves durable `pending` state
        // and produces no ready log line. Ambiguous Bash cleanup is fenced before
        // any later ensure may repeat file synchronization.
        //
        // A box that already holds a ready generation KEEPS it while its required
        // assets are re-verified. The keep-warm sweep re-ensures every live box
        // each minute; publishing `pending` for the sync's duration surfaced as a
        // Running→Starting status flap whenever the sync was slow (30s under host
        // load), and every status consumer saw a healthy box as not-ready for
        // that window. Only a box that has never been ready — or lost readiness —
        // publishes `pending` before the sync; a failed re-sync on a ready box
        // revokes readiness explicitly in the catch below.
        const retainReadiness = durableSetup.readiness === 'ready' || durableSetup.readiness === 'ready_degraded'
        if (
          !retainReadiness &&
          !(await this.deps.markSetupPending(sandboxId, setupFingerprint, new Date(this.deps.now())))
        ) {
          throw new Error(`VM setup fingerprint changed before required asset sync ${sandboxId}`)
        }
        const bashFence: SetupBashFence = {
          before: async (invocationId, kind) => {
            if (!(await this.deps.setSetupPendingInvocation(sandboxId, setupFingerprint, invocationId, kind))) {
              throw new Error(`VM setup already has an unproven invocation for ${sandboxId}`)
            }
          },
          after: async (invocationId) => {
            if (!(await this.deps.clearSetupPendingInvocation(sandboxId, setupFingerprint, invocationId))) {
              throw new Error(`VM setup fingerprint changed while clearing file sync ${sandboxId}`)
            }
          },
        }
        try {
          await timer.time('assets', () =>
            this.deps.syncBoxFiles(client, sandboxId, opts, box, bashFence, (operation) =>
              trackSandboxSetupWork(this, sandboxId, 'asset_reconcile', operation)
            )
          )
          if (
            !retainReadiness &&
            !(await this.deps.restoreSetupAfterAssets(
              sandboxId,
              setupFingerprint,
              durableSetup,
              new Date(this.deps.now())
            ))
          ) {
            throw new Error(`VM setup generation changed after required asset sync ${sandboxId}`)
          }
        } catch (error) {
          if (error instanceof BashOutcomeUnknownError) {
            try {
              try {
                await client.cancelBashInvocation(error.invocationId, 'transport-loss')
              } catch {
                client = await this.recoverClient(sandboxId, client, error)
                await client.cancelBashInvocation(error.invocationId, 'transport-loss')
              }
              await bashFence.after(error.invocationId)
            } catch {
              // The pre-admission fence remains durable for the next cycle.
            }
          }
          if (retainReadiness) {
            // A ready box whose required-asset re-sync failed must stop
            // advertising readiness: the next ensure re-syncs from `pending`.
            // Fingerprint-scoped — a false return means a newer generation owns
            // the row, and that generation publishes its own readiness.
            try {
              await this.deps.markSetupPending(sandboxId, setupFingerprint, new Date(this.deps.now()))
            } catch (revokeError) {
              log.warn(`Failed to revoke readiness for ${sandboxId} after required asset re-sync failure`, revokeError)
            }
          }
          throw error
        }

        const setupAttemptNow = new Date(this.deps.now())
        const reconcileSetup = () =>
          reconcileVmSetup(
            {
              sandboxId,
              fingerprint: setupFingerprint,
              configureGit: false,
              devboxInvocationId: computeDevboxInstallInvocationId(sandboxId, role),
              gitInvocationId: stableSetupInvocationId('git_config', 'credential-helper'),
              squadId: opts.squadId ?? (sandboxId.startsWith('squad_') ? sandboxId.slice('squad_'.length) : undefined),
              initialReasons: env.FICUS_API_URL?.startsWith('http://127.0.0.1:') ? [] : ['callback_transport_degraded'],
              now: setupAttemptNow,
              leaseAlreadyHeld: true,
            },
            {
              withLease: (id, fn) => this.deps.withSetupLease(id, fn),
              ensureFingerprint: (id, fingerprint) => this.deps.ensureSetupFingerprint(id, fingerprint),
              markReconciling: (id, fingerprint, now) => this.deps.markSetupReconciling(id, fingerprint, now),
              setPendingInvocation: (id, fingerprint, invocationId, kind) =>
                this.deps.setSetupPendingInvocation(id, fingerprint, invocationId, kind),
              clearPendingInvocation: (id, fingerprint, invocationId) =>
                this.deps.clearSetupPendingInvocation(id, fingerprint, invocationId),
              mergeObservedReasons: (id, fingerprint, reasons, now) =>
                this.deps.mergeSetupObservedReasons(id, fingerprint, reasons, now),
              markDegraded: (input) => this.deps.markSetupDegraded(input),
              markReady: (id, fingerprint, now) => this.deps.markSetupReady(id, fingerprint, now),
              getClient: () => this.requireSandbox(sandboxId).client,
              recoverClient: (failed, cause) => this.recoverClient(sandboxId, failed, cause),
              seedDevbox: async (current, invocationId) => {
                timer.merge(await this.deps.seedBoxDevbox(current, sandboxId, role, invocationId))
              },
              signalDevboxReady: (current) =>
                timer.time('devbox-ready', async () => {
                  await current.devboxReady()
                  const health = await current.health()
                  if (!health.healthy || !health.devboxReady) throw new Error('Devbox shell environment is not live')
                }),
              writeBashrc: (current) => timer.time('bashrc', () => this.ensureBoxBashrc(current, sandboxId, role)),
              // GitHub credentials are resolved by the squad shell per command.
              configureGit: async () => {},
              sleep: (ms) => Bun.sleep(ms),
              now: () => new Date(this.deps.now()),
            }
          )
        const setupMutationDue =
          durableSetup.readiness === 'pending' ||
          durableSetup.readiness === 'reconciling' ||
          (durableSetup.readiness === 'ready_degraded' &&
            durableSetup.nextAttemptAt !== null &&
            durableSetup.nextAttemptAt.getTime() <= setupAttemptNow.getTime())
        return setupMutationDue
          ? trackSandboxSetupWork(this, sandboxId, 'setup_reconcile', reconcileSetup)
          : reconcileSetup()
      })

      // ONE structured summary line answers "where did the time go" for this
      // ensure (see box-timing.ts's module doc) — measurement only, never used to
      // change behavior. Non-fatal, matching box-manager.ts's priorBoxesOnMachine
      // annotation: a fully-live box must never be failed by a formatting bug in
      // the LOG LINE describing it.
      try {
        let readyLine = this.deps.formatBoxReadyLine(
          sandboxId,
          placedMachine.id,
          this.deps.now() - startedAt,
          timer.steps,
          { role, priorBoxesOnMachine: placed.priorBoxesOnMachine }
        )
        if (setupResult.readiness === 'ready_degraded') {
          const retryInMs = setupResult.nextAttemptAt
            ? Math.max(0, setupResult.nextAttemptAt.getTime() - this.deps.now())
            : 0
          readyLine = `${readyLine.replace('Box ready', 'Box ready_degraded')} reasons=${setupResult.reasons.join(',')} attempt=${setupResult.attemptCount} retryInMs=${retryInMs}`
        } else {
          readyLine = `${readyLine} readiness=ready`
        }
        log.info(readyLine)
      } catch (err) {
        log.warn(`Failed to format "Box ready" summary line for ${sandboxId} (measurement only, non-fatal):`, err)
      }
      return sandboxId
    } finally {
      if (!connectionReleased) releaseConnection()
    }
  }

  async attachExistingSandbox(sandboxId: string, _opts: SandboxOptions): Promise<boolean> {
    return (await this.getOrAttachClient(sandboxId)) !== null
  }

  async reconcileToolchain(
    sandboxId: string,
    opts: SandboxOptions,
    request: ManagedToolchainRequest
  ): Promise<'unchanged' | 'applied' | 'cleared'> {
    const state = this.sandboxes.get(sandboxId)
    const client = state?.client ?? (await this.getOrAttachClient(sandboxId))
    if (!client) throw new Error('Sandbox is not connected')
    const workRoot = state?.workRoot ?? boxWorkRoot(sandboxId, resolveRole(sandboxId, opts))
    return reconcileRemoteToolchain(client, `${boxHome(sandboxId)}/.tau/toolchain`, workRoot, request, (operation) =>
      trackSandboxSetupWork(this, sandboxId, 'toolchain_reconcile', operation)
    )
  }

  async stopSandbox(sandboxId: string, options: { lifecycleGeneration?: string | null } = {}) {
    const release = await this.acquireConnection(sandboxId)
    try {
      return await this.deps.withSetupLease(sandboxId, async () => {
        const state = this.sandboxes.get(sandboxId)
        const current = await this.deps.getMachineBox(sandboxId)
        if (!current && (options.lifecycleGeneration !== undefined || !state)) {
          if (state) {
            state.client.close()
            this.sandboxes.delete(sandboxId)
          }
          this.dropAttachedClient(sandboxId)
          this.healthObservations.delete(sandboxId)
          return { kind: 'not-found' } as const
        }
        if (options.lifecycleGeneration !== undefined) {
          if (!current) return { kind: 'not-found' } as const
          const actualLifecycleGeneration = lifecycleGenerationFromVmSpecHash(current.reconcilableSpecHash)
          if (actualLifecycleGeneration !== options.lifecycleGeneration) {
            log.warn(
              `Refusing stale sandbox stop for ${sandboxId}: expected generation ${options.lifecycleGeneration ?? 'legacy'}, actual ${actualLifecycleGeneration ?? 'legacy'}`
            )
            return { kind: 'generation-mismatch', actualLifecycleGeneration } as const
          }
        }
        if (state) {
          state.client.close()
          this.sandboxes.delete(sandboxId)
        }
        this.dropAttachedClient(sandboxId)
        this.healthObservations.delete(sandboxId)
        const stop = await this.deps.stopBox(sandboxId)
        if (stop.kind === 'unverified') return { kind: 'unverified' } as const
        return { kind: stop.kind === 'not-found' ? 'not-found' : 'stopped' } as const
      })
    } finally {
      release()
    }
  }

  /**
   * Retire a setup-recovery candidate under the same distributed lease as
   * generation publication. A mismatch preserves both the current box and its
   * setup row so a stale classifier cannot destroy a newly woken generation.
   */
  async retireSetupRecovery(
    sandboxId: string,
    lifecycleGeneration: string | null | undefined
  ): Promise<VmSetupRetireOutcome> {
    const release = await this.acquireConnection(sandboxId)
    try {
      return await this.deps.withSetupLease(sandboxId, async () => {
        if (lifecycleGeneration !== undefined) {
          const current = await this.deps.getMachineBox(sandboxId)
          const actualLifecycleGeneration = lifecycleGenerationFromVmSpecHash(current?.reconcilableSpecHash)
          if (actualLifecycleGeneration !== lifecycleGeneration) {
            log.warn(
              `Refusing stale setup retirement for ${sandboxId}: expected generation ${lifecycleGeneration ?? 'legacy'}, actual ${actualLifecycleGeneration ?? 'legacy'}`
            )
            return { kind: 'generation-mismatch', actualLifecycleGeneration }
          }
        }
        const state = this.sandboxes.get(sandboxId)
        if (state) {
          state.client.close()
          this.sandboxes.delete(sandboxId)
        }
        this.dropAttachedClient(sandboxId)
        this.healthObservations.delete(sandboxId)
        const stop = await this.deps.stopBox(sandboxId)
        if (stop.kind === 'unverified') return { kind: 'unverified' }
        await this.deps.deleteSetupState(sandboxId)
        return { kind: 'retired' }
      })
    } finally {
      release()
    }
  }

  async removeSandbox(sandboxId: string): Promise<void> {
    const release = await this.acquireConnection(sandboxId)
    try {
      const state = this.sandboxes.get(sandboxId)
      if (state) {
        state.client.close()
        this.sandboxes.delete(sandboxId)
      }
      this.dropAttachedClient(sandboxId)
      this.healthObservations.delete(sandboxId)
      // Agent/system-manager boxes carry a per-box `~/.private` worth archiving;
      // squad boxes share a workspace with nothing per-remove to keep.
      const archivePrivate = !sandboxId.startsWith('squad_')
      await this.deps.removeBox(sandboxId, { archivePrivate, timeoutMs: BOX_REMOVE_ARCHIVE_TIMEOUT_MS })
    } finally {
      release()
    }
  }

  /**
   * Routine process shutdown. Closes this process's clients and cancels ONLY
   * this process's local forwards — never `-O exit` on the shared ControlMaster.
   * The master is one adoptable control socket per machine shared by the api
   * AND worker processes, and it carries the reverse forward whose remote port
   * boxes baked into FICUS_API_URL; exiting it here would sever the other
   * process's live forwards and every box's callback port (which the healthy
   * ensure fast-path never re-bakes). Masters are MEANT to survive process
   * death — `ensureMaster` re-adopts them on restart. Genuine machine teardown
   * (delete/park) is the only place `machineTunnels.closeMachine` belongs.
   */
  async cleanup(): Promise<void> {
    // Drain parked work FIRST: an attach/ensure awaiting its addForward when
    // shutdown starts would otherwise register a forward AFTER the sweep below
    // — the same permanent strand cancelMachineForwards drains against, one
    // layer up (its machine may not even be in touchedMachines yet, so the
    // tunnel-layer drain would never see it). Awaiting settle (failures
    // ignored) makes the sweep observe every client/forward that will ever
    // exist. Every leg is wall-clock-bounded by the tunnel layer's
    // master/control timeouts EXCEPT materializePrivateKey's DB read inside
    // establishMaster — a DB outage at shutdown can hang this drain (accepted
    // edge: no generic timeout util exists in lib/infra, and the supervisor's
    // kill grace bounds the process anyway).
    await Promise.allSettled([...this.attachInflight.values(), ...this.recoveryInflight.values()])
    await this.inflight.settled()
    log.info(`Cleaning up ${this.sandboxes.size} boxes`)
    this.unsubscribeBoxStatus()
    for (const state of this.sandboxes.values()) state.client.close()
    this.sandboxes.clear()
    for (const client of this.attachedClients.values()) client.close()
    this.attachedClients.clear()
    this.healthObservations.clear()
    for (const machineId of this.touchedMachines) {
      try {
        await this.deps.releaseMachineForwards(machineId)
      } catch (err) {
        log.warn(`Failed to release forwards for machine ${machineId}:`, err)
      }
    }
    this.touchedMachines.clear()
  }

  /**
   * Write the box's interactive `.tau/.bashrc` (devbox activation + `.env`
   * sourcing) so `spawnShell` terminals get the same env as the seeded `/bash`
   * PATH. The box's devbox lives at `FICUS_DEVBOX_DIR` (`~/.tau/devbox`), OUTSIDE
   * the shell cwd, so the bashrc activates it from there explicitly (see
   * {@link buildBashrcContent}'s `devboxDir`). The physical `<workRoot>/.tau/`
   * target is under `FICUS_BOX_HOME`, so the box server's path allow-list permits
   * it and it lands exactly where `shell.ts` reads it (`WORKSPACE_PATH/.tau/
   * .bashrc`). Non-fatal.
   */
  private async ensureBoxBashrc(client: SandboxClient, sandboxId: string, role: BoxRole): Promise<void> {
    const workRoot = boxWorkRoot(sandboxId, role)
    const devboxDir = `${boxHome(sandboxId)}/.tau/devbox`
    const content = buildBashrcContent(workRoot, workRoot, { devboxDir })
    await client.write({
      path: `${workRoot}/.tau/.bashrc`,
      content: Buffer.from(content).toString('base64'),
      createDirs: true,
    })
  }

  private async repairBashAfterFailure(
    sandboxId: string,
    failedClient: SandboxClient,
    stream: ReturnType<SandboxClient['bash']>,
    error: Error
  ): Promise<void> {
    try {
      await stream.cancelAndWait('transport-loss')
    } catch {
      const recovered = await this.recoverClient(sandboxId, failedClient, error)
      await recovered.cancelBashInvocation(stream.invocationId, 'transport-loss')
    }
  }

  // --- Execution ---------------------------------------------------------

  getSpawnHook(_sandboxId: string, _workspacePath: string): SpawnHook | null {
    // vm boxes use HTTP/WS tools, not docker-exec spawn hooks (like k8s).
    return null
  }

  async exec(sandboxId: string, args: string[]): Promise<Buffer> {
    const state = this.requireSandbox(sandboxId)
    this.touch(state)

    const command = shellCommandFromArgs(args)
    const launchingClient = state.client
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let terminal = false
      let settled = false
      const stream = launchingClient.bash({ command, cwd: state.workRoot })
      stream.on('data', (response: BashResponse) => {
        if (response.stdout) chunks.push(Buffer.from(response.stdout, 'base64'))
        if (response.stderr) chunks.push(Buffer.from(response.stderr, 'base64'))
        if (response.error) reject(new Error(response.error))
        if (response.exitCode !== undefined) {
          terminal = true
          if (response.exitCode !== 0) {
            const output = Buffer.concat(chunks).toString()
            reject(new Error(`Command failed with exit code ${response.exitCode}: ${output}`))
          }
        }
      })
      stream.on('error', (err: Error) => {
        if (settled) return
        settled = true
        void this.repairBashAfterFailure(sandboxId, launchingClient, stream, err).then(
          () => reject(err),
          (cleanupError) => reject(new Error(err.message, { cause: cleanupError }))
        )
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        if (!terminal) reject(new Error('Bash stream ended without a terminal exit code'))
        else resolve(Buffer.concat(chunks))
      })
    })
  }

  async execStatus(sandboxId: string, args: string[]): Promise<number> {
    const state = this.requireSandbox(sandboxId)
    this.touch(state)

    const command = shellCommandFromArgs(args)
    const launchingClient = state.client
    return new Promise((resolve, reject) => {
      let exitCode: number | undefined
      let settled = false
      const stream = launchingClient.bash({ command, cwd: state.workRoot })
      stream.on('data', (response: BashResponse) => {
        if (response.error && response.exitCode === undefined) return
        if (response.exitCode !== undefined) exitCode = response.exitCode
      })
      stream.on('error', (err: Error) => {
        if (settled) return
        settled = true
        void this.repairBashAfterFailure(sandboxId, launchingClient, stream, err).then(
          () => reject(err),
          (cleanupError) => reject(new Error(err.message, { cause: cleanupError }))
        )
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        if (exitCode === undefined) reject(new Error('Bash stream ended without a terminal exit code'))
        else resolve(exitCode)
      })
    })
  }

  streamExec(
    sandboxId: string,
    args: string[],
    onStdout: (chunk: Buffer) => void,
    onStderr: (chunk: Buffer) => void = () => {}
  ): { cancel: () => void; cancelAndWait: () => Promise<void> } {
    const state = this.requireSandbox(sandboxId)
    this.touch(state)

    const command = shellCommandFromArgs(args)
    const launchingClient = state.client
    const stream = launchingClient.bash({ command, cwd: state.workRoot })
    stream.on('data', (response: BashResponse) => {
      if (response.stdout) onStdout(Buffer.from(response.stdout, 'base64'))
      if (response.stderr) onStderr(Buffer.from(response.stderr, 'base64'))
    })
    stream.on('error', (err: Error) => {
      void this.repairBashAfterFailure(sandboxId, launchingClient, stream, err).then(
        () => onStderr(Buffer.from(err.message)),
        (cleanupError) => onStderr(Buffer.from(`${err.message}; cleanup unproven: ${cleanupError.message}`))
      )
    })
    return {
      cancel: () => stream.cancel(),
      cancelAndWait: () =>
        this.repairBashAfterFailure(sandboxId, launchingClient, stream, new Error('stream cancelled')),
    }
  }

  // streamLogs is intentionally ABSENT (the ISandboxManager contract marks it
  // optional): a box has no separate "container log" stream — its process
  // output flows through exec/streamExec. Defining it as a no-op made the logs
  // WS guard (`!manager.streamLogs`, services/ws/logs.ts) pass and handed the
  // user a permanently empty stream; absence makes that guard close the socket
  // with a clear "log streaming not supported for this runtime".

  spawnShell(sandboxId: string, cols: number, rows: number, _workspacePath?: string): IPty | null {
    const state = this.sandboxes.get(sandboxId)
    if (!state) {
      log.warn(`Cannot spawn shell - box not found: ${sandboxId}`)
      return null
    }
    this.touch(state)

    const stream = state.client.shell()
    // Inject the live Core URL so the terminal's `tau` CLI reaches the current
    // Core even if the box baked a now-stale URL at creation (mirrors k8s).
    stream.write({
      spawn: {
        cols,
        rows,
        cwd: state.workRoot,
        useDevboxRc: true,
        env: state.apiUrl ? { FICUS_API_URL: state.apiUrl } : undefined,
      },
    })
    return new HttpPtyWrapper(stream, cols, rows)
  }

  // --- Spec reconciliation ----------------------------------------------

  /**
   * Reconcilable spec hash for these options. Mirrors k8s
   * `reconcilableSpecHash` (squad membership drives the box's workspace root)
   * and adds the sandbox-server bundle version + box-provision script version
   * so a box is recreated when the code that provisions/serves it changes.
   *
   * Synchronous by contract, so it hashes only what's derivable without I/O:
   * the caller env's secret values (git token, callback secret) are NOT part of
   * the hash — a plain re-ensure of a RUNNING or newly-provisioned box always
   * rebuilds and pushes fresh env regardless of this hash, so env drift alone
   * never needs the heavier RECREATE (park + full re-provision) this hash
   * drives (exactly as k8s excludes env from its reconcilable hash).
   *
   * This is deliberately NOT the same value passed as `EnsureBoxOpts.specHash`
   * (see {@link computeProvisioningMarker}): the PARKED-box resume fast path
   * (box-manager.ts) skips exactly the env re-push a full provision does, so
   * that marker folds in an env hash too — otherwise a rotated secret would
   * resume a box on stale credentials. Keeping the two hashes separate means a
   * caller asking "has the box's SPEC drifted" (this method — used by
   * recreateSandbox's drift check, and baked into FICUS_BOX_SPEC_HASH) never
   * gets a false positive from an unrelated env/secret rotation.
   *
   * Role limitation (contract only): the {@link ISandboxManager} contract
   * passes only `opts` here — NO sandboxId — so this method reads role from
   * the explicit `opts.k8s.sandboxType` (defaulting to `'squad'`) and squad
   * membership from `opts.squadId` alone. Its callers (the squad spec
   * reconciler, ensure.ts's agent drift check) always pass FULL canonical
   * opts, where both agree with the sandboxId prefix. Everything ensure-time
   * uses {@link canonicalSpecHash} instead, which derives role and squad from
   * the sandboxId — so a partial-opts caller can never stamp (or compare
   * against) a drifted hash. If you add a computeSpecHash caller, pass the
   * box's full canonical opts or use isSandboxSpecDrifted (which canonicalizes
   * for you).
   */
  computeSpecHash(opts: SandboxOptions): string {
    return this.hashReconcilable(opts.squadId, opts.k8s?.sandboxType ?? 'squad', opts.lifecycleGeneration)
  }

  /**
   * The ensure-time spec hash: identical inputs regardless of caller. Role
   * comes from the sandboxId prefix (see {@link resolveRole}) and squad
   * membership from `opts.squadId ?? getSquadIdFromSandbox(sandboxId)` — the
   * same fallbacks placement and buildBoxEnv use — so every caller of
   * ensureSandbox stamps the same hash (and, through it, the same
   * provisioning marker) for a given box.
   */
  private canonicalSpecHash(sandboxId: string, opts: SandboxOptions): string {
    const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? undefined
    return this.hashReconcilable(squadId, roleFromSandboxId(sandboxId), opts.lifecycleGeneration)
  }

  private hashReconcilable(
    squadId: string | undefined,
    role: BoxRole,
    lifecycleGeneration: string | undefined
  ): string {
    const reconcilable = {
      squadIds: squadId ? [squadId] : [],
      role,
      bundleVersion: this.bundleVersion,
      provisionVersion: this.deps.getBoxProvisionVersion(),
    }
    const digest = createHash('sha256').update(JSON.stringify(reconcilable)).digest('hex').slice(0, 16)
    return lifecycleGeneration ? `lifecycle:${encodeURIComponent(lifecycleGeneration)}:${digest}` : digest
  }

  isSandboxSpecDrifted(sandboxId: string, opts: SandboxOptions): boolean {
    const running = this.sandboxes.get(sandboxId)?.specHash
    if (running === undefined) return false
    return running !== this.canonicalSpecHash(sandboxId, opts)
  }

  /** Re-run setup reconciliation for a due box tracked by this process. */
  async reconcileDueSetup(sandboxId: string): Promise<boolean> {
    const state = this.sandboxes.get(sandboxId)
    if (!state) return false
    await this.ensureSandbox(sandboxId, state.options)
    return true
  }

  async getRunningSandboxSpecHash(sandboxId: string): Promise<string | null> {
    const box = await this.deps.getMachineBox(sandboxId)
    if (box?.reconcilableSpecHash) return box.reconcilableSpecHash
    return this.sandboxes.get(sandboxId)?.specHash ?? null
  }

  async recreateSandbox(sandboxId: string, opts: SandboxOptions): Promise<string> {
    return trackSandboxSetupWork(this, sandboxId, 'spec_reconcile', async () => {
      log.info(`Recreating box to apply spec change: ${sandboxId}`)
      // Park (state persists on disk) then re-ensure with the new spec.
      const stop = await this.stopSandbox(sandboxId)
      if (stop.kind === 'unverified') throw new Error(`Cannot recreate ${sandboxId} until its stop is verified`)
      return this.ensureSandbox(sandboxId, opts)
    })
  }

  // --- Query -------------------------------------------------------------

  hasSandbox(sandboxId: string): boolean {
    return this.sandboxes.has(sandboxId)
  }

  /** Live box status mapped onto the k8s-shaped discriminant callers consume. */
  async getSandboxStatus(sandboxId: string): Promise<VmSandboxStatus> {
    const [{ status, chain }, setup] = await Promise.all([
      this.deps.boxChainHealth(sandboxId),
      this.deps.getSetupState(sandboxId),
    ])
    switch (status) {
      case 'ready': {
        // An IDLE box (socket-activated, server stood down after its idle
        // window) must NOT be probed here. `client.health()` is an HTTP request
        // through the box's socket unit, which activates the server — and the
        // UI polls this endpoint every few seconds for as long as a squad or
        // agent page is open, so probing would wake every idle box on the host
        // on every poll and no box could ever stay idle. chain.boxServer ===
        // 'idle' means the lifecycle tick saw the box's port listening moments
        // ago (one `ss` per machine, no per-box round trip): the box IS
        // reachable, and its devbox environment is self-cached by the server at
        // boot, so a box that was setup-ready before it idled is setup-ready
        // when it next wakes. Trust the durable setup state below; every other
        // branch (setup missing / pending / reconciling / degraded) is
        // unchanged.
        const idle = chain?.boxServer === 'idle'
        let liveDevboxReady = idle
        let pressure: SandboxPressure | undefined
        let repairReason: VmSetupReasonCode = 'transport_recovery_failed'
        const statusClient = idle ? null : await this.getOrAttachClient(sandboxId)
        if (statusClient) {
          let current = statusClient
          try {
            const health = await runIdempotentSandboxOperation({
              sandboxId,
              operationClass: 'health',
              getClient: () => current,
              recoverClient: async (failed, cause) => (current = await this.recoverClient(sandboxId, failed, cause)),
              operation: (client) => client.health(),
              sleep: (ms) => Bun.sleep(ms),
            })
            liveDevboxReady = health.healthy && health.devboxReady
            pressure = health.pressure
            this.observeHealth(sandboxId, health.uptimeSeconds)
            repairReason = 'devbox_unavailable'
          } catch {
            liveDevboxReady = false
            repairReason = 'transport_recovery_failed'
          }
        }
        if (!setup) {
          return {
            status: 'starting',
            reason: 'sandbox setup has not been reconciled',
            devboxReady: false,
            chain,
          }
        }
        if (setup.readiness === 'pending' || setup.readiness === 'reconciling') {
          return { status: 'starting', reason: 'required sandbox assets are not ready', chain }
        }
        if (setup?.readiness === 'ready_degraded') {
          const projected = projectVmSetupState(setup)
          return {
            status: 'running',
            readiness: 'ready_degraded',
            devboxReady: liveDevboxReady && !projected.reasons.includes('devbox_unavailable'),
            chain,
            ...(pressure ? { pressure } : {}),
            degradation: {
              reasons: projected.reasons,
              attemptCount: projected.attemptCount,
              ...(projected.nextAttemptAt ? { nextAttemptAt: projected.nextAttemptAt } : {}),
            },
          }
        }
        if (!liveDevboxReady) {
          const degraded = await this.deps.markSetupRepairNeeded(
            sandboxId,
            setup.desiredFingerprint,
            repairReason,
            new Date(this.deps.now())
          )
          const projected = projectVmSetupState(degraded ?? setup)
          return {
            status: 'running',
            readiness: 'ready_degraded',
            devboxReady: false,
            chain,
            ...(pressure ? { pressure } : {}),
            degradation: {
              reasons: projected.reasons.includes(repairReason) ? projected.reasons : [repairReason],
              attemptCount: projected.attemptCount,
              ...(projected.nextAttemptAt ? { nextAttemptAt: projected.nextAttemptAt } : {}),
            },
          }
        }
        return { status: 'running', readiness: 'ready', devboxReady: true, chain, ...(pressure ? { pressure } : {}) }
      }
      case 'starting':
        // Non-terminal: box mid-(re-)provision, or its machine is up but the
        // tunnel/probe hasn't converged yet. Kept out of the terminal 'failed'
        // bucket so routes/recovery keep the session alive (mirrors k8s 'starting').
        return { status: 'starting', reason: 'box is provisioning or its health probe has not yet passed', chain }
      case 'failed':
        // Terminal: the box's machine is gone or no longer ready — outage.ts
        // treats this as a crash and arms a recovery watch.
        return { status: 'failed', reason: 'box machine is gone or no longer ready', chain }
      case 'stopped':
      case 'absent':
      default:
        return { status: 'not_found', chain }
    }
  }

  /** The SandboxClient for a box (used by routes/ensure + the client-based tools). */
  getClient(sandboxId: string): SandboxClient | null {
    return this.sandboxes.get(sandboxId)?.client ?? null
  }

  /**
   * Alias of {@link getClient} matching the k8s manager's method name, so the
   * shared client-based coding tools (createK8sSandboxedCodingTools) drive a vm
   * box exactly as they drive a k8s pod.
   */
  getClientForSandbox(sandboxId: string): SandboxClient | null {
    return this.getClient(sandboxId)
  }

  /**
   * A SandboxClient for a box that is ready ANYWHERE — not only one THIS
   * process ensured. The api and worker processes each hold their own
   * in-memory sandbox map, so an api-side read path (ssh re-push, memory
   * rescan, ...) would miss for a perfectly healthy box the worker ensured. On
   * a map miss this reads the ready `machine_boxes` row, attaches to the
   * machine's shared ControlMaster (`ensureMaster` adopts the live socket) and
   * forwards the box port, then caches the resulting client for reuse. Returns
   * null when no ready box/machine row exists (caller falls back to its
   * "unreachable"/ensure path). Concurrent misses share one in-flight attach.
   * Attached clients are superseded by a full ensure and dropped on
   * stop/remove/cleanup.
   */
  async getOrAttachClient(sandboxId: string): Promise<SandboxClient | null> {
    const tracked = this.sandboxes.get(sandboxId)?.client
    if (tracked) return tracked
    const attached = this.attachedClients.get(sandboxId)
    if (attached) return attached

    const inflight = this.attachInflight.get(sandboxId)
    if (inflight) return inflight
    const p = this.acquireConnection(sandboxId)
      .then(async (release) => {
        try {
          return await this.attachClient(sandboxId)
        } finally {
          release()
        }
      })
      .finally(() => {
        this.attachInflight.delete(sandboxId)
        this.attachTombstones.delete(sandboxId)
      })
    this.attachInflight.set(sandboxId, p)
    return p
  }

  private async attachClient(sandboxId: string): Promise<SandboxClient | null> {
    const box = await this.deps.getMachineBox(sandboxId)
    if (!box || box.status !== 'ready') return null
    const machine = await this.deps.getMachine(box.machineId)
    if (!machine || machine.status !== 'ready') return null

    await this.deps.ensureMaster(machine)
    const localPort = await this.deps.addForward(machine, box.port)
    this.touchedMachines.add(machine.id)
    // A stop/gone event may have raced the awaits above (row read →
    // ensureMaster → addForward takes seconds on a cold api process); its
    // onBoxStatus invalidation found nothing cached yet, so re-check the
    // tombstone HERE. Caching now would pin a client + forward to a dead box
    // with no future invalidation — release the forward we just added instead.
    if (this.attachTombstones.has(sandboxId)) {
      await this.deps.removeForward(machine.id, box.port).catch((err) => {
        log.warn(`Failed to release aborted-attach forward for ${sandboxId} (${machine.id}:${box.port}):`, err)
      })
      return null
    }
    // SandboxClient prepends the scheme itself; pass a bare host:port. The row
    // carries the box's executor auth token (cross-process source of truth).
    const client = this.deps.createClient(`127.0.0.1:${localPort}`, box.authToken ?? undefined)
    this.attachedClients.set(sandboxId, client)
    // One-shot activity signal: attached reads (rescan, ssh re-push, ...) go
    // through this client without ever hitting touch(), so a long operation on
    // a box near its idle threshold could otherwise be parked mid-flight.
    void this.deps.persistBoxActivity(sandboxId, this.deps.now()).catch((err) => {
      log.warn(`Failed to persist attach activity heartbeat for ${sandboxId}:`, err)
    })
    return client
  }

  private observeHealth(sandboxId: string, uptimeSeconds: number | undefined): void {
    if (typeof uptimeSeconds !== 'number' || !Number.isFinite(uptimeSeconds)) return
    const observedAtMs = this.deps.now()
    const previous = this.healthObservations.get(sandboxId)
    if (!previous || observedAtMs >= previous.observedAtMs)
      this.healthObservations.set(sandboxId, { uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)), observedAtMs })
  }

  /**
   * Reacquire a stale VM transport for future work. The request which exposed
   * the failure is never replayed here; callers may retry only operations whose
   * idempotency/cleanup proof they own.
   */
  async recoverClient(sandboxId: string, failedClient: SandboxClient, cause: Error): Promise<SandboxClient> {
    const current = this.sandboxes.get(sandboxId)?.client ?? this.attachedClients.get(sandboxId)
    if (current && current !== failedClient) return current
    const existing = this.recoveryInflight.get(sandboxId)
    if (existing) return existing

    const recovery = this.acquireConnection(sandboxId)
      .then(async (release) => {
        try {
          return await this.performClientRecovery(sandboxId, failedClient, cause)
        } finally {
          release()
        }
      })
      .finally(() => {
        if (this.recoveryInflight.get(sandboxId) === recovery) this.recoveryInflight.delete(sandboxId)
      })
    this.recoveryInflight.set(sandboxId, recovery)
    return recovery
  }

  private async performClientRecovery(
    sandboxId: string,
    failedClient: SandboxClient,
    cause: Error
  ): Promise<SandboxClient> {
    const current = this.sandboxes.get(sandboxId)?.client ?? this.attachedClients.get(sandboxId)
    if (current && current !== failedClient) return current
    if (!current) throw new Error(`Sandbox ${sandboxId} no longer has a recoverable connection`)

    const diagnostic = safeVmRecoveryDiagnostic(cause)
    const before = this.healthObservations.get(sandboxId)
    const logFailure = (stage: 'row_lookup' | 'forward' | 'reverse' | 'candidate_probe' | 'ownership') =>
      log.warn(
        `VM transport recovery complete ${JSON.stringify({ sandboxId, result: 'failed', stage, ...diagnostic })}`
      )
    log.info(`VM transport recovery start ${JSON.stringify({ sandboxId, ...diagnostic })}`)
    // A bounded authenticated probe distinguishes a transient stale keepalive
    // from a forward which truly needs replacement.
    try {
      const health = await current.health()
      const uptimeAfterSeconds = Math.max(0, Math.floor(health.uptimeSeconds ?? 0))
      this.observeHealth(sandboxId, uptimeAfterSeconds)
      log.info(
        `VM transport recovery complete ${JSON.stringify({
          sandboxId,
          result: 'success',
          box: before ? (uptimeAfterSeconds < before.uptimeSeconds ? 'restart_observed' : 'continuous') : 'unknown',
          master: 'unchanged',
          localForward: 'unchanged',
          reverse: 'preserved',
          ...(before ? { uptimeBeforeSeconds: before.uptimeSeconds } : {}),
          uptimeAfterSeconds,
          ...diagnostic,
        })}`
      )
      return current
    } catch {
      // Repair below; never replay the failed caller operation.
    }

    let box: MachineBox | null
    let machine: Machine | null
    try {
      box = await this.deps.getMachineBox(sandboxId)
      if (!box || box.status !== 'ready') throw new Error(`Sandbox ${sandboxId} is no longer ready`)
      machine = await this.deps.getMachine(box.machineId)
      if (!machine || machine.status !== 'ready') throw new Error(`Sandbox ${sandboxId} machine is no longer ready`)
    } catch (error) {
      logFailure('row_lookup')
      throw error
    }

    // Exact forward repair owns master liveness: pre-ensuring here would erase
    // the evidence that the prior ControlMaster died before diagnostics and
    // reverse invalidation can observe it.
    let forward: ForwardRefreshResult
    try {
      forward = this.deps.refreshForwardDetailed
        ? await this.deps.refreshForwardDetailed(machine, box.port)
        : {
            localPort: await this.deps.refreshForward(machine, box.port),
            master: 'preserved',
            forward: 'rebound',
            reverses: 'preserved',
          }
    } catch (error) {
      logFailure('forward')
      throw error
    }
    const localPort = forward.localPort
    this.touchedMachines.add(machine.id)
    let apiTransport: BoxApiTransportResult
    try {
      apiTransport = this.deps.resolveBoxApiTransport
        ? await this.deps.resolveBoxApiTransport(machine)
        : { url: await this.deps.resolveBoxApiUrl(machine), reverse: 'bound', allocation: 'pinned' }
    } catch (error) {
      logFailure('reverse')
      throw error
    }
    const apiUrl = apiTransport.url
    const candidate = this.deps.createClient(`127.0.0.1:${localPort}`, box.authToken ?? undefined)
    let completionLine = ''
    try {
      const health = await candidate.health()
      const uptimeAfterSeconds = Math.max(0, Math.floor(health.uptimeSeconds ?? 0))
      this.observeHealth(sandboxId, uptimeAfterSeconds)
      const reverse =
        apiTransport.reverse === 'lost'
          ? 'lost'
          : forward.master === 'restarted' && apiTransport.reverse === 'bound'
            ? 'rebound'
            : apiTransport.reverse
      completionLine = `VM transport recovery complete ${JSON.stringify({
        sandboxId,
        result: 'success',
        box: before ? (uptimeAfterSeconds < before.uptimeSeconds ? 'restart_observed' : 'continuous') : 'unknown',
        master: forward.master,
        localForward: forward.forward,
        reverse,
        ...(before ? { uptimeBeforeSeconds: before.uptimeSeconds } : {}),
        uptimeAfterSeconds,
        ...diagnostic,
      })}`
    } catch (error) {
      candidate.close()
      log.warn(
        `VM transport recovery complete ${JSON.stringify({ sandboxId, result: 'failed', stage: 'candidate_probe', ...diagnostic })}`
      )
      throw error
    }

    // Reread authoritative ownership after the awaits so a stop/move/token
    // rotation cannot publish a candidate built from stale identity.
    const latest = await this.deps.getMachineBox(sandboxId)
    if (
      !latest ||
      latest.status !== 'ready' ||
      latest.machineId !== box.machineId ||
      latest.port !== box.port ||
      latest.authToken !== box.authToken
    ) {
      candidate.close()
      await this.deps.removeForward(machine.id, box.port).catch(() => {})
      log.warn(
        `VM transport recovery complete ${JSON.stringify({ sandboxId, result: 'failed', stage: 'ownership', ...diagnostic })}`
      )
      throw new Error(`Sandbox ${sandboxId} changed while its connection was recovering`)
    }

    const tracked = this.sandboxes.get(sandboxId)
    if (tracked?.client === failedClient) {
      tracked.client = candidate
      tracked.machineId = machine.id
      tracked.endpoint = `http://127.0.0.1:${localPort}`
      tracked.apiUrl = apiUrl
      log.info(completionLine)
      return candidate
    }
    if (this.attachedClients.get(sandboxId) === failedClient) {
      this.attachedClients.set(sandboxId, candidate)
      log.info(completionLine)
      return candidate
    }
    const alreadyCurrent = this.sandboxes.get(sandboxId)?.client ?? this.attachedClients.get(sandboxId)
    if (alreadyCurrent) {
      candidate.close()
      log.info(completionLine)
      return alreadyCurrent
    }
    candidate.close()
    await this.deps.removeForward(machine.id, box.port).catch(() => {})
    log.warn(
      `VM transport recovery complete ${JSON.stringify({ sandboxId, result: 'failed', stage: 'ownership', ...diagnostic })}`
    )
    throw new Error(`Sandbox ${sandboxId} stopped while its connection was recovering`)
  }

  /** Close + forget the read-only attached client for a box, if any. */
  private dropAttachedClient(sandboxId: string): void {
    const attached = this.attachedClients.get(sandboxId)
    if (!attached) return
    attached.close()
    this.attachedClients.delete(sandboxId)
  }

  /**
   * A box was stopped ('stopped') or removed ('gone') — possibly by the OTHER
   * core process. Drop every piece of local state that could otherwise go
   * stale: the tracked client, any attached client, and this process's tunnel
   * forward for the box's (machine, port). Same-process teardowns re-enter here
   * via the local emit, where each step is already-done/no-op. The forward drop
   * is keyed on the event's port so no DB read is needed ('gone' has no row
   * left to read).
   */
  private onBoxStatus(data: { sandboxId: string; machineId: string; status: string; port: number }): void {
    if (data.status !== 'stopped' && data.status !== 'gone') return
    // An attach mid-flight for this box has cached nothing yet, so the drops
    // below can't reach it — tombstone it so attachClient aborts instead of
    // resurrecting a client for the now-dead box (see attachTombstones).
    if (this.attachInflight.has(data.sandboxId)) this.attachTombstones.add(data.sandboxId)
    const state = this.sandboxes.get(data.sandboxId)
    if (state) {
      state.client.close()
      this.sandboxes.delete(data.sandboxId)
    }
    this.dropAttachedClient(data.sandboxId)
    this.healthObservations.delete(data.sandboxId)
    // Defensive typeof: a distributed event from an older core build may not
    // carry the port yet.
    if (typeof data.port === 'number') {
      void this.deps.removeForward(data.machineId, data.port).catch((err) => {
        log.warn(`Failed to drop stale forward for ${data.sandboxId} (${data.machineId}:${data.port}):`, err)
      })
    }
  }

  /**
   * The live Core URL injected as `FICUS_API_URL` for bash tool commands. Unlike
   * k8s (which derives a cluster-DNS URL from the pod namespace), a box already
   * baked its correct callback URL at ensure time, so we re-inject exactly that,
   * keeping the box's `tau` CLI pointed at the right Core even if it baked a
   * now-stale reverse-tunnel port.
   *
   * Deliberately NO `getAppUrl()` fallback: `state.apiUrl` is always truthy for
   * a tracked box (resolveBoxApiUrl returns a tunnel URL or a validated APP_URL,
   * or the ensure throws before tracking), and tools only reach here for tracked
   * boxes (via getClientForSandbox). A fallback would be the one remaining path
   * for a possibly-gated public APP_URL to leak into an exec env — the exact
   * footgun the reverse-tunnel-default change removed from the bake path.
   */
  resolveToolApiUrl(sandboxId: string): string {
    return this.sandboxes.get(sandboxId)?.apiUrl || ''
  }

  toContainerPath(sandboxId: string, hostPath: string): string {
    const state = this.sandboxes.get(sandboxId)
    if (!state) return hostPath
    if (hostPath.startsWith(state.workspacePath)) {
      const rel = relative(state.workspacePath, hostPath)
      return rel ? `${state.workRoot}/${rel}` : state.workRoot
    }
    return hostPath
  }

  /**
   * Box-native layout for the given agent context, derived offline from the
   * deterministic box unix user (`vmWorkspaceLayout`): squad-scoped contexts
   * resolve to the SQUAD box's `~/workspace` / `~/memory`; a solo agent's work
   * root is its own box's `~/.private` (matching `boxWorkRoot(sandboxId,
   * 'agent')`). This replaces the old `getContainerWorkspacePath(squadId?)`,
   * whose solo branch had to fall back to the logical `/private` because the
   * contract lacked the agent's sandboxId.
   */
  getWorkspaceLayout(ctx: WorkspaceLayoutContext): WorkspaceLayout {
    return vmWorkspaceLayout(ctx)
  }

  getSandboxRuntime(sandboxId: string): SandboxRuntime | null {
    return this.sandboxes.has(sandboxId) ? VM_RUNTIME : null
  }

  /**
   * Where Core can reach a local app deployment running in this box.
   *
   * Absent this method, `resolveLocalDeploymentTarget` threw "LocalDeployment
   * targets are not supported by this sandbox runtime" — the proxy route has no
   * try/catch, so every tokenized app URL and every /api/health probe returned
   * 500, and the health poller (which resolves the same target) marked healthy
   * apps unhealthy. The feature predates this runtime and was never wired to it.
   *
   * A VM box is NOT a container: it is a systemd unit running as a
   * `box_<hash>` user directly on the machine, and the app it starts binds the
   * machine's loopback (see services/machines/box-manager.ts's EXECUTOR_BIND
   * note). So the target is the same SSH `-L` forward every other box call
   * already uses — `addForward` returns a Core-local port pointing at
   * `127.0.0.1:<port>` ON the machine.
   *
   * Two boxes on one machine share that loopback, which is why ports are now
   * assigned and unique per live deployment (services/deploy/
   * local-deployment-ports.ts). Without that, this forward could hand a
   * tokenized URL to a DIFFERENT squad's app.
   */
  /** Boxes on one machine share its loopback, so the machine is the port scope. */
  async getSandboxMachineId(sandboxId: string): Promise<string | null> {
    const box = await this.deps.getMachineBox(sandboxId)
    return box?.machineId ?? null
  }

  async getLocalDeploymentTarget(sandboxId: string, port: number): Promise<{ host: string; port: number }> {
    const box = await this.deps.getMachineBox(sandboxId)
    // Same message the docker/k8s managers use: the proxy retries once through
    // ensureSquadSandbox when it sees "Sandbox not found", which is what makes a
    // cold box come up on first request instead of 500ing.
    if (!box) throw new Error(`Sandbox not found: ${sandboxId}`)
    const machine = await this.deps.getMachine(box.machineId)
    if (!machine) throw new Error(`Sandbox not found: ${sandboxId}`)
    const localPort = await this.deps.addForward(machine, port)
    return { host: '127.0.0.1', port: localPort }
  }

  /** Last exec/shell activity for a box (epoch ms). Consumed by slice 4's keepalive. */
  getLastActivityAt(sandboxId: string): number | undefined {
    return this.sandboxes.get(sandboxId)?.lastActivityAt
  }

  /**
   * Idle-policy view of a box this process tracks (activity + timeout + alwaysOn),
   * or `undefined` for a box it never ensured. Slice 4's idle reaper builds an
   * {@link IdleCandidate} from this; an untracked box (undefined here) is skipped
   * by the pure park rule rather than reaped on missing activity data. A tracked
   * box completed ensure, so its `status` is `'ready'`.
   */
  getLifecycleState(sandboxId: string): VmLifecycleState | undefined {
    const state = this.sandboxes.get(sandboxId)
    if (!state) return undefined
    return {
      lastActivityAt: state.lastActivityAt,
      idleTimeoutMs: state.idleTimeoutMs,
      alwaysOn: state.alwaysOn,
      status: 'ready',
    }
  }

  // --- Internals ---------------------------------------------------------

  private requireSandbox(sandboxId: string): VmSandboxState {
    const state = this.sandboxes.get(sandboxId)
    if (!state) throw new Error(`Sandbox not found: ${sandboxId}`)
    return state
  }

  /**
   * Record exec/shell activity. In-memory always; persisted to the box's row at
   * most every {@link ACTIVITY_PERSIST_INTERVAL_MS} so the OTHER process's idle
   * reaper sees activity that happens here (a live api terminal must not be
   * parked by the worker). Fire-and-forget — a failed heartbeat write must
   * never fail the exec that triggered it. `lastPersistedActivityAt` is
   * advanced OPTIMISTICALLY and kept even when the write fails, so a failure
   * can leave the row up to one extra throttle interval stale — accepted:
   * idle timeouts are minute-scale, 30s of extra staleness cannot flip a park
   * decision, and retry bookkeeping isn't worth it for a coarse heartbeat.
   */
  private touch(state: VmSandboxState): void {
    const now = this.deps.now()
    state.lastActivityAt = now
    if (now - state.lastPersistedActivityAt >= ACTIVITY_PERSIST_INTERVAL_MS) {
      state.lastPersistedActivityAt = now
      void this.deps.persistBoxActivity(state.sandboxId, now).catch((err) => {
        log.warn(`Failed to persist activity heartbeat for ${state.sandboxId}:`, err)
      })
    }
  }

  /**
   * Build the box's env, mirroring pod-spec.ts:225-272's derivation. The three
   * box-layout vars (EXECUTOR_PORT/WORKSPACE_PATH/FICUS_DEVBOX_DIR) are baked by
   * box-manager itself and intentionally NOT set here.
   */
  private async buildBoxEnv(
    sandboxId: string,
    opts: SandboxOptions,
    specHash: string,
    machine: Machine,
    timer: ReturnType<typeof createBoxStepTimer>
  ): Promise<BoxEnv> {
    const squadId = opts.squadId ?? getSquadIdFromSandbox(sandboxId) ?? ''
    const env: BoxEnv = {
      FICUS_SANDBOX_ID: sandboxId,
      FICUS_SANDBOX_UMASK: process.env.FICUS_SANDBOX_UMASK || '0002',
      // FICUS_SANDBOX_ROLE gates the box's runtime (server.ts:ensureDocker + the
      // 30s docker-wait). Mirror pod-spec.ts exactly: only the light 'agent' box
      // is 'agent'; squad AND system-manager both map to 'squad'. Absent, an agent
      // box would run the heavy squad path and stall on the docker wait.
      FICUS_SANDBOX_ROLE: resolveRole(sandboxId, opts) === 'agent' ? 'agent' : 'squad',
      // vm-specific: baked so the running spec hash is inspectable on the box
      // (read back from the in-memory mirror for drift; see getRunningSandboxSpecHash).
      FICUS_BOX_SPEC_HASH: specHash,
    }
    if (squadId) env.FICUS_SQUAD_ID = squadId

    // FICUS_API_URL — the box reaches Core over an SSH reverse tunnel by default
    // (resolveBoxApiUrl; a direct APP_URL is only its degraded fallback when the
    // tunnel can't be established). Resolved against the machine already picked
    // for THIS ensure, so the tunnel and the box land on the SAME machine.
    env.FICUS_API_URL = await timer.time('tunnel', () => this.deps.resolveBoxApiUrl(machine))

    const appUrl = this.deps.getAppUrl()
    if (appUrl) env.APP_URL = appUrl

    const gh = await timer.time('identity', () => this.deps.resolveGitHubIdentity(squadId || undefined))

    Object.assign(env, gitIdentityEnv(gh))

    // The box calls back to Core over its tunnel (like k8s local-dev), so the
    // callback secret is always injected when configured.
    const callbackSecret = this.deps.getSecret('SANDBOX_CALLBACK_SECRET')
    if (callbackSecret) env.SANDBOX_CALLBACK_SECRET = callbackSecret

    return env
  }
}

function stripScheme(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '')
}
