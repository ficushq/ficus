import { isUserAssistantAgentType } from '@ficus/shared'
import { consultantSandboxSquadId } from './consultant-sandbox'
import { sandboxHasActiveExecution } from '../machines/sandbox-activity'
import { RECENT_ACTIVITY_WINDOW_MS } from './squad-activity'
/**
 * Sandbox setup orchestration.
 *
 * Ensures sandbox environments are ready for agent execution — creating
 * workspace directories, injecting environment variables, and mounting
 * volumes as needed. Runtime-agnostic: delegates to the active sandbox
 * manager (Docker or K8s) via the factory.
 */

import { join } from 'path'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as sandboxFactory from './factory'
import { SandboxProvisionError } from './k8s/provision-errors'
import { getSecretStore } from '../secrets'
import * as cliHelp from '../../lib/utils/cli-help'
import { CLI_BUNDLE_FILE, SANDBOX_CLI_PATH } from './cli-path'
import * as homeUtils from '../../lib/utils/home'
import { ensureWorkspace } from './workspace'
import * as squadWorkspace from '../squad/workspace'
import { prepareWorkspaceDotDir } from '../workspace/dot-dir'
import * as squadSsh from '../squad/ssh'
import * as memoryPaths from '../memory/paths'
import * as localDeploymentHealth from '../deploy/local-deployment-health'
import { EXTENSIONS_DIR } from '../../lib/paths'
import { Squad } from '../../entities/Squad'
import { regenerateEnvFileForSquad } from '../squad/env'
import { hasRecentAgentActivity } from './squad-activity'
import { hasActiveLocalDeployments } from '../deploy/local-deployment-service'
import * as sessionState from '../execution/session-state'
import { getSquadIdFromSandbox } from './types'
import type { SandboxOptions as SandboxManagerOptions, ISandboxManager, BoxLivenessHint } from './types'
import { setHostWorkspaceOverride } from './host/workspace-overrides'
import { recordHostActiveWorkspacePath } from './host/active-workspace'
import { containerWorkspaceLayout, type WorkspaceLayoutContext } from './workspace-layout'
import { resolveSandboxAssets, type AssetContext } from './asset-manifest'
import { createLogger } from '../../lib/infra/logger'
import { InflightDeduper } from '../../lib/infra/inflight'
import { ensureSandboxToolchain } from './toolchain/provision'
import { assertMaintenanceAdmissionOpen } from '../maintenance/admission'
import type { AdmissionScope, AdmissionWritePhase } from '../maintenance/admission-reservation'
import { observeSandboxSetupProgress, type SandboxSetupProgressListener } from './setup-progress'

const log = createLogger('sandbox-ensure')

/**
 * The sandbox-side work root for an agent context, from the manager's own
 * runtime layout: the shared squad workspace for squad-scoped sandboxes, the
 * agent's private dir for solo ones.
 */
function sandboxWorkRoot(manager: ISandboxManager, ctx: WorkspaceLayoutContext): string {
  const layout = manager.getWorkspaceLayout(ctx)
  return ctx.squadId ? layout.workspaceMount : layout.privateMount
}

/**
 * Host runtime: refresh the in-memory override cache from the squad row.
 *
 * Always re-reads the row rather than trusting a caller-supplied `Squad`
 * instance: a caller may be holding a stale snapshot (e.g. fetched before a
 * concurrent PATCH), and the DB row is the sole authority for this cache.
 */
async function refreshHostWorkspaceOverride(squadId: string): Promise<void> {
  const row = await Squad.find(squadId)
  setHostWorkspaceOverride(squadId, row?.hostWorkspacePath ?? null)
}

/**
 * Build the K8s sandbox options for a squad from its stored sandbox config.
 * Shared by ensureSquadSandbox and the spec reconciler so both produce the same
 * desired pod spec.
 */
export function buildSquadK8sSandboxOptions(squad: Squad): SandboxManagerOptions {
  const sandboxConfig = squad.sandboxConfig
  return {
    workspacePath: squadWorkspace.ensureSquadWorkspace(squad.id),
    squadId: squad.id,
    // vm runtime: pin the box to the squad's machine when set (ignored by k8s/docker).
    machineId: squad.machineId ?? undefined,
    k8s: {
      sandboxType: 'squad',
      alwaysOn: sandboxConfig?.alwaysOn === true, // default: false
      idleTimeout: (sandboxConfig?.idleTimeoutMinutes ?? 60) * 60 * 1000,
      ephemeralStorageLimitGi: sandboxConfig?.ephemeralStorageLimitGi,
    },
  }
}

/**
 * Whether it's safe to recreate a squad's sandbox without disrupting work: no
 * agent activity in the recent window and no active local deployments relying
 * on it. Used to gate spec-drift reconciliation.
 */
export async function isSquadSandboxIdle(squad: Squad, sandboxId: string): Promise<boolean> {
  if (await hasRecentAgentActivity(squad)) return false
  if (await hasActiveLocalDeployments(sandboxId)) return false
  return true
}

export interface SandboxOptions {
  /** The sandbox ID (taskId, squadId, etc.) */
  sandboxId: string
  /** The workspace ID (taskId, squadId, etc.) */
  workspaceId: string
  /** When set, the sandbox is a member of this squad (shared workspace + squad volumes) */
  squadId?: string
  /** vm runtime: pin the box to this machine (from the agent row). Ignored by k8s/docker. */
  machineId?: string
  lifecycleGeneration?: string
  /** Observes the authoritative generation selected inside this ensure. */
  onLifecycleGenerationResolved?: (generation: string | undefined) => void
  admissionScope?: AdmissionScope | null
  /** Receives authoritative manager progress during physical and toolchain reconciliation. */
  setupProgress?: SandboxSetupProgressListener
  /** vm runtime: the caller already saw this box's port listening (see
   *  services/sandbox/types.ts `BoxLivenessHint`). Ignored by k8s/docker. */
  boxLiveness?: BoxLivenessHint
}

async function runSandboxEffect<T>(
  scope: AdmissionScope | null | undefined,
  phase: AdmissionWritePhase,
  sandboxId: string,
  operation: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!scope) return operation()
  return scope.runEffect({ phase, resourceKey: `sandbox:${sandboxId}` }, ({ signal }) => operation(signal))
}

/**
 * Collaborators that ensureWorkspaceSandbox depends on.
 *
 * Tests pass fakes directly — no ESM module spying required. Production code
 * uses {@link defaultWorkspaceDeps}, which wires up the real module imports.
 */
export interface EnsureWorkspaceDeps {
  isK8sRuntime: () => boolean
  /**
   * Whether the runtime is a remote (k8s or vm) runtime — i.e. sandboxes are
   * reached through a manager/client rather than local Docker. Gates the shared
   * "talk to the manager" flow. Optional so pre-existing test deps (which set
   * only isK8sRuntime) keep working: when absent it falls back to isK8sRuntime.
   */
  isRemoteSandboxRuntime?: () => boolean
  getSandboxManager: () => ISandboxManager
  getCliHostPath: () => string
  getHomeDir: () => string
  ensureSquadWorkspace: (squadId: string) => string
  isSessionActive: (agentId: string) => boolean
  /** Whether the runtime is the host (no-sandbox) runtime. Optional for legacy test deps. */
  isHostRuntime?: () => boolean
}

/**
 * Default collaborator wiring for ensureWorkspaceSandbox — delegates to the
 * real module imports. Production callers never need to pass deps explicitly.
 */
const defaultWorkspaceDeps: EnsureWorkspaceDeps = {
  isK8sRuntime: sandboxFactory.isK8sRuntime,
  isRemoteSandboxRuntime: sandboxFactory.isRemoteSandboxRuntime,
  getSandboxManager: sandboxFactory.getSandboxManager,
  getCliHostPath: cliHelp.getCliHostPath,
  getHomeDir: homeUtils.getHomeDir,
  ensureSquadWorkspace: squadWorkspace.ensureSquadWorkspace,
  isSessionActive: sessionState.isSessionActive,
  isHostRuntime: sandboxFactory.isHostRuntime,
}

/**
 * Ensure a sandbox is running for the given workspace,
 * with the ficus CLI and host access configured.
 *
 * Returns the workspace path on the host (Docker) or container mount (K8s).
 */
/** Idle timeout for agent (non-squad) sandbox pods: 30 minutes */
const AGENT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Return the backend-accessible storage path for an agent workspace.
 *
 * In K8s this should point at the same shared workspace backing store that the
 * sandbox pod mounts at /workspace. Use HOME_DIR/getWorkspacePath rather than a
 * hardcoded mount point so deployments can choose where that volume lives.
 */
export function ensureK8sCliForSandbox(options: { cliHostPath?: string; homeDir?: string } = {}): string {
  const cliHostPath = options.cliHostPath ?? cliHelp.getCliHostPath()
  const homeDir = options.homeDir ?? homeUtils.getHomeDir()

  if (!existsSync(cliHostPath)) {
    throw new Error(`Ficus CLI build not found at ${cliHostPath}. Run bun run build:cli before starting K8s sandboxes.`)
  }

  const cliDir = join(homeDir, 'cli')
  mkdirSync(cliDir, { recursive: true })
  const stagedPath = join(cliDir, CLI_BUNDLE_FILE)
  const cliContents = readFileSync(cliHostPath)
  const stagedContents = existsSync(stagedPath) ? readFileSync(stagedPath) : null

  if (!stagedContents || !stagedContents.equals(cliContents)) {
    // Preserve the staged file inode when refreshing it. K8s subPath file mounts
    // bind to the source inode; replacing the file leaves running pods mounted to
    // a deleted inode, and Bun reports `/usr/local/bin/ficus (deleted)` as missing.
    writeFileSync(stagedPath, cliContents, { mode: 0o755 })
  }

  chmodSync(stagedPath, 0o755)
  return stagedPath
}

export function getAgentWorkspaceStoragePath(workspaceId: string): string {
  if (sandboxFactory.isK8sRuntime()) {
    // K8s sandbox pods mount the shared core-data PVC at /workspace using the
    // subPath "workspaces/agents/<workspaceId>". Core must read/write that
    // same backing directory via its HOME_DIR mount, not the container path.
    const workspacePath = join(homeUtils.getHomeDir(), 'workspaces', 'agents', workspaceId)
    mkdirSync(workspacePath, { recursive: true })
    return workspacePath
  }

  return ensureWorkspace(workspaceId)
}

/**
 * Return the backend-accessible storage path for an agent's private directory.
 *
 * In K8s the path lives under HOME_DIR/private/<sandboxId> on the shared PVC.
 * In Docker the same layout is used on the host filesystem.
 * The directory is created eagerly so the volume/subPath mount point exists.
 */
export function getAgentPrivateStoragePath(sandboxId: string): string {
  const privatePath = join(homeUtils.getHomeDir(), 'private', sandboxId)
  mkdirSync(privatePath, { recursive: true })
  // A private dir still under the legacy dot dir (identity key, toolchain) moves to `.ficus` first.
  prepareWorkspaceDotDir(privatePath)
  return privatePath
}

const AGENT_SANDBOX_PREFIX = 'agent_'

/**
 * Generate/refresh the calling agent's AMTP federation identity on the host
 * BEFORE any manifest sync runs (#788 root cause: `ensureAgentIdentity` was
 * only ever invoked from `agent-warmup.ts`, which fires on narrow triggers —
 * squad.agentSpawned, workStream.updated, boot sweeps, admin routes — NOT from
 * the per-turn execution path every runner's `createSession()` actually uses.
 * A plain `agent.created` agent that never hit one of those triggers got
 * identity.pem generated nowhere: not on the host, not in the box). Calling
 * this here — unconditionally, before the docker/k8s/vm branches below do
 * their manifest work — guarantees the host file exists on every turn,
 * regardless of warmup plumbing. It matters most for the vm runtime: unlike
 * docker/k8s (which live-mount `/private`, so a write is visible in the box
 * immediately regardless of ordering), the vm manager's `ensureSandbox`
 * SNAPSHOTS and pushes the manifest, so identity must already exist on the
 * host before that call or the first sync misses it.
 *
 * Keyed off the sandboxId itself — no caller changes needed, since every
 * runner already calls `ensureWorkspaceSandbox` with its sandboxId every turn:
 *   - Only `agent_<id>`-prefixed sandboxIds resolve to an agent at all. Squad
 *     sandboxIds (`squad_<id>`) and the shared system-manager sandboxId
 *     (`system_manager_<userId>`) never match, so those shared boxes get no
 *     identity file — matching the asset manifest's own rule that a shared
 *     box has no single-agent identity.
 *   - A subagent's own sandboxId always resolves (via `Agent#getSandboxId`)
 *     to its PARENT's `agent_<parentId>` — so this naturally refreshes the
 *     PARENT's identity/private dir and never mints a separate one for the
 *     subagent's own row.
 *   - `agentTypeId === 'system-manager'` is asserted explicitly too (mirrors
 *     `agent-warmup.ts`'s existing guard). This is NOT mere defense in depth:
 *     `Agent#getSandboxId` only routes to the shared `system_manager_<userId>`
 *     sandboxId when `ownerUserId` is set; if it's unset, it falls back to the
 *     per-agent `agent_<id>` box even for a system-manager, which WOULD match
 *     the `agent_` prefix check above. The explicit guard is load-bearing for
 *     that case.
 *
 * Imports are dynamic to avoid an entity ⇆ sandbox import cycle (`Agent.ts`
 * imports `agent-runners/base.ts`, which imports this module).
 *
 * Deduplicated per sandboxId via `identityInflight` (review follow-up on
 * #788): this now runs on EVERY `ensureWorkspaceSandbox` call — every turn,
 * every agent, every runner — with no gate on whether a session is already
 * active. Without a lock, two concurrent first-time ensures for the same
 * never-before-generated agent (e.g. a warmup sweep racing a live turn's
 * `createSession()`, especially plausible during the fleet-wide self-heal
 * this fix triggers for existing broken agents) would both see the identity
 * file absent, both generate different keypairs, and race each other on the
 * atomic rename and the DB update — leaving `identityPublicKey` in the DB
 * not matching the private key that actually won the rename, silently
 * breaking federation until a human notices. Keying the dedupe on sandboxId
 * (not agentId) matters: a subagent's sandboxId always resolves to its
 * PARENT's, so concurrent ensures from a subagent and its parent must join
 * the same in-flight run rather than racing each other under different keys.
 */
const identityInflight = new InflightDeduper<void>()

async function ensureAgentIdentityForSandbox(sandboxId: string): Promise<void> {
  return identityInflight.run(sandboxId, () => doEnsureAgentIdentityForSandbox(sandboxId))
}

export async function resolveLifecycleGenerationForSandbox(sandboxId: string): Promise<string | undefined> {
  if (!sandboxId.startsWith(AGENT_SANDBOX_PREFIX)) return undefined
  const agentId = sandboxId.slice(AGENT_SANDBOX_PREFIX.length)
  const { findAgentLifecycleState } = await import('../../entities/agent-queries')
  const agent = await findAgentLifecycleState(agentId)
  const generation = (agent?.metadata as Record<string, unknown> | null)?.resourceGeneration
  return typeof generation === 'string' ? generation : undefined
}

async function doEnsureAgentIdentityForSandbox(sandboxId: string): Promise<void> {
  if (!sandboxId.startsWith(AGENT_SANDBOX_PREFIX)) return
  const agentId = sandboxId.slice(AGENT_SANDBOX_PREFIX.length)
  const { Agent } = await import('../../entities/Agent')
  const agent = await Agent.find(agentId, { eager: false })
  if (!agent || isUserAssistantAgentType(agent.agentTypeId)) return
  const { ensureAgentIdentity } = await import('../amtp/agent-identity')
  try {
    await ensureAgentIdentity(agent, sandboxId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (agent.identityPublicKey) {
      log.error(
        `Federation identity unavailable for agent ${agentId} (sandbox ${sandboxId}); continuing sandbox startup in degraded federation state: ${message}`
      )
      return
    }
    throw new Error(`Failed to provision federation identity for agent ${agentId} (sandbox ${sandboxId}): ${message}`, {
      cause: err,
    })
  }
}

/** In-flight agent-box drift recreates, keyed by sandboxId (see the drift block below). */
const inflightDriftRecreates = new Map<string, Promise<void>>()

export async function ensureWorkspaceSandbox(
  {
    sandboxId,
    workspaceId: _workspaceId,
    squadId,
    machineId,
    onLifecycleGenerationResolved,
    admissionScope,
    setupProgress,
    boxLiveness,
  }: SandboxOptions,
  deps: EnsureWorkspaceDeps = defaultWorkspaceDeps
): Promise<string> {
  // Must run before the manifest sync below (see the doc comment on
  // ensureAgentIdentityForSandbox for why ordering matters).
  await ensureAgentIdentityForSandbox(sandboxId)
  // The sandbox owner row is authoritative. Callers (warmup, runners, direct
  // projection refresh) cannot select a different generation/spec identity.
  const consultantSquadId = consultantSandboxSquadId(sandboxId)
  if (consultantSquadId && squadId !== consultantSquadId) throw new Error('Consultant sandbox squad mismatch')
  const consultantSquad = consultantSquadId ? await Squad.find(consultantSquadId) : null
  if (consultantSquadId && (!consultantSquad || consultantSquad.status !== 'active'))
    throw new Error('Consultant squad is not active')
  const lifecycleGeneration = await resolveLifecycleGenerationForSandbox(sandboxId)
  onLifecycleGenerationResolved?.(lifecycleGeneration)

  // Host runtime: no CLI staging, no volumes, no toolchain — the directories ARE
  // the sandbox. Identity provisioning already ran above (unconditionally, for
  // every runtime); the host path has no manifest sync to race against, since
  // there's no container/box to push files into. Refresh the squad's workspace
  // override first so the manager's layout (and everything downstream) sees the
  // row's current value.
  if (deps.isHostRuntime?.()) {
    const manager = deps.getSandboxManager()
    if (squadId) await refreshHostWorkspaceOverride(squadId)
    const workspacePath = sandboxWorkRoot(manager, { squadId, sandboxId })
    mkdirSync(join(deps.getHomeDir(), 'private', sandboxId), { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
    // Record what was actually applied — the override cache alone only says
    // where agents WILL work after the next start (see active-workspace.ts).
    if (squadId) await recordHostActiveWorkspacePath(squadId, workspacePath)
    const stopObserving = setupProgress ? observeSandboxSetupProgress(manager, sandboxId, setupProgress) : undefined
    try {
      await assertMaintenanceAdmissionOpen()
      await runSandboxEffect(admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
        manager.ensureSandbox(sandboxId, { workspacePath, squadId, machineId, lifecycleGeneration, signal })
      )
      return workspacePath
    } finally {
      stopObserving?.()
    }
  }

  // Remote runtimes (k8s + vm) share the "talk to the manager" flow. Only k8s
  // stages the CLI into a HOME_DIR/cli subPath mount; vm boxes receive it via the
  // manager's file-sync, so that staging stays k8s-only (and would otherwise throw
  // when the local CLI build is absent on a vm deployment).
  const isRemoteRuntime = deps.isRemoteSandboxRuntime?.() ?? deps.isK8sRuntime()
  if (isRemoteRuntime) {
    if (deps.isK8sRuntime()) {
      ensureK8sCliForSandbox({ cliHostPath: deps.getCliHostPath(), homeDir: deps.getHomeDir() })
    }
    const manager = deps.getSandboxManager()
    const stopObserving = setupProgress ? observeSandboxSetupProgress(manager, sandboxId, setupProgress) : undefined
    try {
      const privatePath = join(deps.getHomeDir(), 'private', sandboxId) // HOME_DIR/private/<sandboxId>
      mkdirSync(privatePath, { recursive: true })
      // Solo agents work in /private (no /workspace); squad members use the shared squad workspace.
      const workspacePath = squadId ? deps.ensureSquadWorkspace(squadId) : privatePath
      const sandboxOpts: SandboxManagerOptions = {
        workspacePath,
        squadId,
        // vm runtime: pin the box to the agent's machine when set (ignored by k8s/docker).
        machineId,
        // vm runtime: skip the waking health probe when the caller already knows
        // the box's port is listening (keep-warm tick only).
        boxLiveness,
        lifecycleGeneration,
        k8s: {
          sandboxType: 'agent',
          alwaysOn: false,
          idleTimeout: consultantSquad ? RECENT_ACTIVITY_WINDOW_MS : AGENT_IDLE_TIMEOUT_MS,
          privateStorageKey: sandboxId,
        },
      }

      // Self-heal spec drift on per-agent boxes. Agent boxes have no periodic
      // reconciler (unlike squads), so the ensure path is the only place drift
      // gets corrected — e.g. a box created SOLO by an older code path that should
      // now mount the shared squad workspace/memory. We compare the running pod's
      // annotation (cluster read, so it survives a Core restart when in-memory
      // state is empty) against the desired spec and recreate when they differ.
      // Gated on the agent having no active session: registerSession runs AFTER
      // the runner's session-start ensure, so this path heals right before use,
      // while the periodic warmup sweep can never tear down a box mid-execution.
      const agentId = sandboxId.startsWith('agent_') ? sandboxId.slice('agent_'.length) : null
      if (agentId && manager.getRunningSandboxSpecHash && manager.computeSpecHash && manager.recreateSandbox) {
        let inspectionAllowed = true
        try {
          await manager.assertProvisionInspectionAllowed?.()
        } catch (error) {
          if (!(error instanceof SandboxProvisionError)) throw error
          inspectionAllowed = false
        }
        // Concurrent callers (the keep-warm sweep and a runner's session-start
        // ensure landed 1s apart in production logs) both read the stale stamp
        // before either recreate re-stamps it, and recreated the SAME box twice
        // back-to-back. Serialize: a second caller waits for the in-flight
        // recreate and then falls through to the normal ensure, which fast-paths
        // on the freshly stamped box.
        const inflightRecreate = inflightDriftRecreates.get(sandboxId)
        if (inflightRecreate) {
          // Warmup can own a cold rebuild for longer than the runner's 30s
          // admission lease. Joining it is part of this runner's setup too:
          // keep our own phase heartbeated, without taking over or canceling
          // the shared rebuild. The normal ensure below checks our fence again.
          await runSandboxEffect(admissionScope, 'sandbox-ensure', sandboxId, () => inflightRecreate)
        } else if (inspectionAllowed) {
          const runningHash = await manager.getRunningSandboxSpecHash(sandboxId)
          if (runningHash !== manager.computeSpecHash(sandboxOpts) && !deps.isSessionActive(agentId)) {
            log.info(`Agent sandbox spec drifted and no active session; recreating sandbox: ${sandboxId}`)
            const recreate = runSandboxEffect(admissionScope, 'sandbox-drift-recreate', sandboxId, (signal) =>
              manager.recreateSandbox!(sandboxId, { ...sandboxOpts, signal })
            ).finally(() => inflightDriftRecreates.delete(sandboxId))
            inflightDriftRecreates.set(
              sandboxId,
              recreate.then(
                () => undefined,
                () => undefined
              )
            )
            await recreate
            if (squadId) {
              const squad = await Squad.find(squadId)
              if (squad)
                await runSandboxEffect(admissionScope, 'toolchain-reconcile', sandboxId, () =>
                  ensureSandboxToolchain(manager, sandboxId, sandboxOpts, squadId)
                )
            }
            return sandboxWorkRoot(manager, { squadId, sandboxId })
          }
        }
      }

      await assertMaintenanceAdmissionOpen()
      await runSandboxEffect(admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
        manager.ensureSandbox(sandboxId, { ...sandboxOpts, signal })
      )
      if (squadId) {
        const squad = await Squad.find(squadId)
        if (squad)
          await runSandboxEffect(admissionScope, 'toolchain-reconcile', sandboxId, () =>
            ensureSandboxToolchain(manager, sandboxId, sandboxOpts, squadId)
          )
      }
      return sandboxWorkRoot(manager, { squadId, sandboxId })
    } finally {
      stopObserving?.()
    }
  }

  // Docker: create host workspace dir and configure volume mounts
  const cliHostPath = deps.getCliHostPath()
  const env = buildDockerEnv()

  let workspacePath: string
  const volumes = [...buildCliVolumes(cliHostPath)]

  if (squadId) {
    workspacePath = deps.ensureSquadWorkspace(squadId)
    // Shared extension infra (not a per-sandbox asset — stays outside the manifest).
    volumes.push(`${EXTENSIONS_DIR}:${EXTENSIONS_DIR}:ro`)
  } else {
    // Solo agents work in /private (no /workspace), same as K8s.
    workspacePath = join(deps.getHomeDir(), 'private', sandboxId)
    mkdirSync(workspacePath, { recursive: true })
  }

  // Per-asset bind mounts (skills / memory / ssh) come from the shared asset manifest.
  // System-managers are collapsed to 'agent' here — safe because every manifest source
  // treats them identically (only 'squad' is special-cased) and identity is skipped on
  // docker by the dest-base rule; a future system-manager-scoped asset would need a real role.
  volumes.push(...(await buildDockerAssetVolumes({ sandboxId, squadId, role: 'agent' })))

  // Squad members get a separate /private mount alongside the shared workspace;
  // solo agents already work in /private (their workspacePath), so no extra mount.
  let privateVolumePath: string | undefined
  if (squadId) {
    privateVolumePath = join(deps.getHomeDir(), 'private', sandboxId)
    mkdirSync(privateVolumePath, { recursive: true })
  }

  // Defer spec-drift recreation while the agent has an active session (parity
  // with the remote runtime's drift-recreate gate above): tearing the box down
  // mid-turn would kill in-flight work. The docker manager reuses the drifted
  // box now and reconciles on a later idle ensure.
  const dockerAgentId = sandboxId.startsWith('agent_') ? sandboxId.slice('agent_'.length) : null
  const hasActiveSession = dockerAgentId
    ? deps.isSessionActive(dockerAgentId)
    : consultantSquad
      ? await sandboxHasActiveExecution(sandboxId)
      : false

  const manager = deps.getSandboxManager()
  const sandboxOpts = {
    workspacePath,
    hostAccess: true,
    env,
    volumes,
    squadId,
    privateVolumePath,
    lifecycleGeneration,
    hasActiveSession,
  }
  const stopObserving = setupProgress ? observeSandboxSetupProgress(manager, sandboxId, setupProgress) : undefined
  try {
    await assertMaintenanceAdmissionOpen()
    await runSandboxEffect(admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
      manager.ensureSandbox(sandboxId, { ...sandboxOpts, signal })
    )
    if (squadId) {
      const squad = await Squad.find(squadId)
      if (squad)
        await runSandboxEffect(admissionScope, 'toolchain-reconcile', sandboxId, () =>
          ensureSandboxToolchain(manager, sandboxId, sandboxOpts, squadId)
        )
    }

    return workspacePath
  } finally {
    stopObserving?.()
  }
}

/**
 * Ensure a sandbox is running for a squad workspace.
 *
 * Unlike task sandboxes which mount individual skill directories based on
 * agent type config, squad sandboxes mount the entire config/skills folder.
 * This ensures all skills are available to any agent in the squad.
 *
 * Returns the workspace path.
 */
export async function ensureSquadSandbox(
  squadOrId: string | Squad,
  options: {
    restartManagedLocalDeployments?: boolean
    admissionScope?: AdmissionScope | null
    setupProgress?: SandboxSetupProgressListener
    /** vm runtime: see services/sandbox/types.ts `BoxLivenessHint`. */
    boxLiveness?: BoxLivenessHint
  } = {}
): Promise<string> {
  const squadId = typeof squadOrId === 'string' ? squadOrId : squadOrId.id
  const squad = typeof squadOrId === 'string' ? await Squad.find(squadOrId) : squadOrId
  if (squad?.archivedAt || squad?.status === 'archived') {
    throw new Error(`Cannot ensure sandbox for archived squad ${squadId}`)
  }

  const sandboxId = Squad.getSandboxId(squadId)
  const manager = sandboxFactory.getSandboxManager()
  const wasTracked = manager.hasSandbox?.(sandboxId) ?? false

  let workspacePath: string

  await regenerateEnvFileForSquad(squadId)

  const stopObserving = options.setupProgress
    ? observeSandboxSetupProgress(manager, sandboxId, options.setupProgress)
    : undefined
  try {
    if (sandboxFactory.isHostRuntime()) {
      await refreshHostWorkspaceOverride(squadId)
      workspacePath = sandboxWorkRoot(manager, { squadId, sandboxId })
      mkdirSync(workspacePath, { recursive: true })
      await recordHostActiveWorkspacePath(squadId, workspacePath)
      await assertMaintenanceAdmissionOpen()
      await runSandboxEffect(options.admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
        manager.ensureSandbox(sandboxId, { workspacePath, squadId, signal })
      )
    } else if (sandboxFactory.isRemoteSandboxRuntime()) {
      // Read squad sandbox config to determine always-on vs idle-shutdown behavior
      const resolvedSquad = squad ?? (await Squad.mustFind(squadId))

      // k8s pods mount the CLI via a HOME_DIR/cli subPath; vm boxes receive it via
      // the manager's file-sync, so this staging stays k8s-only.
      if (sandboxFactory.isK8sRuntime()) {
        ensureK8sCliForSandbox()
      }
      const sandboxOpts = { ...buildSquadK8sSandboxOptions(resolvedSquad), boxLiveness: options.boxLiveness }

      // Reconcile spec drift on resume: if a running pod's spec is outdated (e.g.
      // a storage-limit change) and the squad is idle, recreate it now so the new
      // spec applies. Busy squads are left untouched and get reconciled later by
      // the periodic reconciler once they go idle.
      if (
        manager.isSandboxSpecDrifted?.(sandboxId, sandboxOpts) &&
        (await isSquadSandboxIdle(resolvedSquad, sandboxId))
      ) {
        log.info(`Sandbox spec changed and squad is idle; recreating sandbox: ${sandboxId}`)
        await assertMaintenanceAdmissionOpen()
        await runSandboxEffect(options.admissionScope, 'sandbox-drift-recreate', sandboxId, (signal) =>
          manager.recreateSandbox!(sandboxId, { ...sandboxOpts, signal })
        )
      } else {
        await assertMaintenanceAdmissionOpen()
        await runSandboxEffect(options.admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
          manager.ensureSandbox(sandboxId, { ...sandboxOpts, signal })
        )
      }
      workspacePath = sandboxWorkRoot(manager, { squadId, sandboxId })
    } else {
      // Docker: create host workspace dir and configure volume mounts
      workspacePath = squadWorkspace.ensureSquadWorkspace(squadId)

      const env = buildDockerEnv()
      const cliHostPath = cliHelp.getCliHostPath()
      const volumes = [
        ...buildCliVolumes(cliHostPath),
        // Shared extension infra (not a per-sandbox asset — stays outside the manifest).
        `${EXTENSIONS_DIR}:${EXTENSIONS_DIR}:ro`,
        // Per-asset bind mounts (skills / memory / ssh) from the shared asset manifest.
        ...(await buildDockerAssetVolumes({ sandboxId, squadId, role: 'squad' })),
      ]

      // Defer spec-drift recreation while the squad is busy (parity with the k8s
      // drift-recreate gate above, which reconciles only when the squad is idle):
      // recreating mid-turn would tear down in-flight work. The docker manager
      // reuses the drifted box now and reconciles on a later idle ensure. Use the
      // nullable lookup and default to "not busy" (recreate allowed) when the row
      // is absent — an ensure must never throw just to evaluate the gate.
      const hasActiveSession = squad ? !(await isSquadSandboxIdle(squad, sandboxId)) : false

      await assertMaintenanceAdmissionOpen()
      await runSandboxEffect(options.admissionScope, 'sandbox-ensure', sandboxId, (signal) =>
        manager.ensureSandbox(sandboxId, {
          workspacePath,
          hostAccess: true,
          env,
          volumes,
          squadId,
          hasActiveSession,
          signal,
        })
      )
    }

    const toolchainSquad = typeof squadOrId === 'string' ? await Squad.find(squadOrId) : squadOrId
    if (toolchainSquad && !sandboxFactory.isHostRuntime()) {
      const toolchainOpts = buildSquadK8sSandboxOptions(toolchainSquad)
      await runSandboxEffect(options.admissionScope, 'toolchain-reconcile', sandboxId, () =>
        ensureSandboxToolchain(manager, sandboxId, toolchainOpts, squadId)
      )
    } else if (toolchainSquad?.toolchainConfig) {
      log.warn(`Squad ${squadId} declares a managed toolchain but the host runtime has no devbox; ignoring it`)
    }
  } finally {
    stopObserving?.()
  }

  await runSandboxEffect(options.admissionScope, 'workspace-watch-configure', sandboxId, () =>
    configureWorkspaceWatch(squadId)
  )
  if (options.restartManagedLocalDeployments !== false && !wasTracked) {
    // Best effort: the box is ready either way, and an app that fails to come
    // back is the health poller's to retry — it must not fail the agent
    // execution that happened to ensure the box.
    await runSandboxEffect(options.admissionScope, 'local-deployment-restart', sandboxId, () =>
      localDeploymentHealth.restartManagedLocalDeploymentsForSandbox(sandboxId).catch((err) => {
        log.warn(`Managed localDeployment restart failed for ${sandboxId}; the health poller will retry:`, err)
      })
    )
  }

  return workspacePath
}

/**
 * Normalize watch glob patterns the same way the sandbox watcher does (trim, strip a leading "/" and
 * a "workspace/" prefix, drop empties). The watcher reports back its *normalized* config, so core
 * must normalize the desired patterns before comparing — otherwise the "already watching, skip" guard
 * never matches and re-issues startWatch every reconcile cycle (the rescan storm).
 */
export function normalizeWatchPatterns(patterns: string[]): string[] {
  return patterns
    .map((pattern) =>
      pattern
        .trim()
        .replace(/^\/+/, '')
        .replace(/^workspace\//, '')
    )
    .filter(Boolean)
}

/**
 * Configure workspace file watching for a squad's sandbox.
 * Called after the sandbox is ready.
 */
/** Inflight watch configuration calls — prevents concurrent duplicate calls per squad */
const watchInflight = new InflightDeduper<void>()

async function configureWorkspaceWatch(squadId: string): Promise<void> {
  // Deduplicate concurrent calls for the same squad
  return watchInflight.run(squadId, () => _configureWorkspaceWatch(squadId))
}

async function _configureWorkspaceWatch(squadId: string): Promise<void> {
  try {
    const squad = await Squad.find(squadId)
    if (!squad) return

    const memoryConfig = squad.memoryConfig
    const manager = sandboxFactory.getSandboxManager()

    // Host runtime: the manager itself owns an in-process watcher — there is no
    // executor client to carry it. Prefer the manager-native capability.
    if (typeof manager.configureWatch === 'function') {
      const workspacePaths = memoryConfig?.enabled === true ? memoryConfig.workspacePaths : undefined
      const desiredInclude = workspacePaths?.include?.length ? normalizeWatchPatterns(workspacePaths.include) : []
      if (desiredInclude.length === 0) {
        // Host workspace dirs persist (no pod teardown), so a disabled config
        // must explicitly stop any live watcher.
        await manager.stopWatch?.(squadId)
        return
      }
      const desiredExclude = normalizeWatchPatterns(workspacePaths!.exclude || [])
      const result = await manager.configureWatch(squadId, { include: desiredInclude, exclude: desiredExclude })
      if (result.owned) log.info(`Configured host workspace watch for squad ${squadId}`)
      else log.debug(`Workspace watch for squad ${squadId} owned by a sibling core process`)
      return
    }

    // --- container/VM path: executor-backed watch, unchanged ---
    if (!memoryConfig?.enabled || !memoryConfig.workspacePaths?.include?.length) {
      return
    }

    if (!('getClient' in manager)) return

    const client = (manager as any).getClient(Squad.getSandboxId(squadId))
    if (!client) return

    const desiredInclude = normalizeWatchPatterns(memoryConfig.workspacePaths.include)
    const desiredExclude = normalizeWatchPatterns(memoryConfig.workspacePaths.exclude || [])

    // Check if the sandbox is already watching with the same config
    try {
      const status = await client.getWatchStatus()
      log.debug(`Watch status for squad ${squadId}: active=${status.active}, config=${JSON.stringify(status.config)}`)
      if (
        status.active &&
        status.config &&
        JSON.stringify(status.config.include) === JSON.stringify(desiredInclude) &&
        JSON.stringify(status.config.exclude) === JSON.stringify(desiredExclude) &&
        status.config.squadId === squadId
      ) {
        log.debug(`Workspace watch already active for squad ${squadId}, skipping`)
        return
      }
    } catch (err) {
      log.debug(`Watch status check failed for squad ${squadId}, will start fresh:`, err)
    }

    await client.startWatch({
      include: desiredInclude,
      exclude: desiredExclude,
      squadId,
    })

    log.info(`Configured workspace watch for squad ${squadId}`)
  } catch (err) {
    log.error(`Failed to configure workspace watch for squad ${squadId}:`, err)
  }
}

// --- Docker-specific helpers ---

/**
 * Build the docker per-asset bind mounts from the shared sandbox asset
 * manifest — the same single source of truth the k8s subPath mounts and the vm
 * file push deliver from. Scope (who gets what) is entirely the manifest's:
 * solo agent → skills; squad member → skills + ssh; squad box → skills +
 * memory + ssh.
 *
 * Skip rule (mirrors k8s's no-pvcSubPath rule): assets whose dest lives under
 * a working volume the docker manager already mounts whole — `/private`
 * (identity) and `/workspace/<squadId>` (squad-env) — arrive via that working
 * volume, so no per-file bind mount is emitted for them.
 *
 * Dest anchor resolution (docker's transport conventions):
 * - `skills`: ONE read-only mount of the materializer parent dir at the
 *   IDENTICAL container path — the same skills anchor the k8s consumer uses
 *   (pod mountPath == host path). Host/container path parity is load-bearing:
 *   the skill paths handed to the Pi session are host paths, read core-side by
 *   the resource loader AND in-container by the sandboxed read/bash tools.
 * - `memory`: the container layout's memoryMount, read-only.
 * - `ssh`: writable mount at /home/ficus/.ssh with the known_hosts pre-seed
 *   (host-side prep, unchanged from the pre-manifest flow).
 */
async function buildDockerAssetVolumes(ctx: AssetContext): Promise<string[]> {
  // Same squadId derivation resolveSandboxAssets applies, so host-side prep
  // below always targets the squad the manifest resolved assets for.
  const squadId = ctx.squadId ?? getSquadIdFromSandbox(ctx.sandboxId) ?? undefined
  const { memoryMount } = containerWorkspaceLayout({ squadId })
  const volumes: string[] = []
  for (const { asset, source } of await resolveSandboxAssets({ ...ctx, squadId })) {
    // Rides a working volume docker already mounts whole — skip.
    if (asset.dest.base === 'private' || asset.dest.base === 'workspace') continue
    switch (asset.dest.base) {
      case 'skills':
        // Pre-create so docker never auto-creates the mount source root-owned
        // (a squad box has no session materializing skills before ensure).
        mkdirSync(source.hostPath, { recursive: true })
        volumes.push(`${source.hostPath}:${source.hostPath}:ro`)
        break
      case 'memory':
        // squad-scoped asset: squadId is set whenever it resolved.
        memoryPaths.ensureSquadMemoryPath(squadId!)
        volumes.push(`${source.hostPath}:${memoryMount}:ro`)
        break
      case 'ssh': {
        // squad-scoped asset: squadId is set whenever it resolved.
        squadSsh.ensureSquadSshDir(squadId!)
        const knownHostsPath = join(source.hostPath, 'known_hosts')
        if (!existsSync(knownHostsPath)) {
          writeFileSync(knownHostsPath, '', { mode: 0o644 })
        }
        volumes.push(`${source.hostPath}:/home/ficus/.ssh`)
        break
      }
      default:
        throw new Error(
          `docker ensure: asset '${asset.name}' has no docker mount resolution for dest.base='${asset.dest.base}'`
        )
    }
  }
  return volumes
}

function buildDockerEnv(): Record<string, string> {
  const port = process.env.PORT || '3000'
  const env: Record<string, string> = {
    FICUS_API_URL: `http://host.docker.internal:${port}`,
  }
  // NOTE: FICUS_PASSWORD is intentionally NOT injected. Agents authenticate via the
  // per-command FICUS_TOKEN; the shared legacy password is a dead credential under
  // multi-admin setups and pure exfil surface in a shared box.
  const sandboxCallbackSecret = getSecretStore().get('SANDBOX_CALLBACK_SECRET')
  if (sandboxCallbackSecret) {
    env.SANDBOX_CALLBACK_SECRET = sandboxCallbackSecret
  }
  const appUrl = process.env.APP_URL
  if (appUrl) {
    env.APP_URL = appUrl
  }
  return env
}

/**
 * The one CLI a docker sandbox gets: the built `ficus.js` at `/usr/local/bin/ficus`.
 * The mount is part of the container's stamped spec, so a container created
 * without it drifts and the manager recreates it on an idle ensure (deferred
 * while a session runs).
 */
function buildCliVolumes(cliHostPath: string): string[] {
  return [`${cliHostPath}:${SANDBOX_CLI_PATH}:ro`]
}
