/**
 * A cheap squad-box check for callers that only need to run commands in an
 * already-running squad box, such as work stream repository setup.
 *
 * The full {@link ensureSquadSandbox} cleans up retired exposure, regenerates
 * the squad env file, runs the runtime ensure behind the per-box serial gate
 * (shared with restart, stop and transport recovery), settles the managed
 * toolchain (up to 30 s) and reconfigures the workspace watch. On a box that
 * is already tracked and healthy, all of that is redundant: the ensure that
 * started tracking it already did it, and env changes regenerate the file
 * themselves.
 *
 * The fast path is taken only when every one of these holds; anything else
 * falls back to the full ensure:
 * - the runtime is remote (vm or k8s), where the full ensure is expensive;
 * - the squad exists and is not archived (an archived squad goes to the full
 *   ensure, which refuses it);
 * - this Core process tracks the box and its spec has not drifted;
 * - no managed toolchain install is running for it, and the recorded
 *   toolchain is either undeclared and clean, or `ready` with the current
 *   declaration applied and activated on the box;
 * - maintenance admission is open (a pause throws, exactly as the full ensure
 *   would);
 * - a single command in the box answers within a short bound, resolving the
 *   workspace path.
 */
import { shareAcrossRequests } from '../../db/query-cancellation'
import { Squad } from '../../entities/Squad'
import { createLogger } from '../../lib/infra/logger'
import { assertMaintenanceAdmissionOpen } from '../maintenance/admission'
import { buildSquadK8sSandboxOptions, ensureSquadSandbox } from './ensure'
import { getSandboxManager, isRemoteSandboxRuntime } from './factory'
import type { ISandboxManager } from './types'
import { fingerprintToolchain, isEmptyToolchain, normalizeToolchain } from './toolchain/config'
import { ensureSandboxToolchain } from './toolchain/provision'
import { readToolchainReconcileSnapshot, type ToolchainReconcileSnapshot } from './toolchain/state'

const log = createLogger('sandbox-ensure')

export const SQUAD_BOX_PROBE_TIMEOUT_MS = 10_000

export interface SquadSandboxCheckResult {
  workspacePath: string
  /** `fast` when the full ensure was skipped. */
  path: 'fast' | 'full'
  /** Why the fast path was not taken. */
  reason?: string
}

export interface SquadSandboxFastPathDeps {
  findSquad(squadId: string): Promise<Squad | null>
  getSandboxId(squadId: string): string
  getManager(): ISandboxManager
  isRemoteRuntime(): boolean
  buildSandboxOptions(squad: Squad): Parameters<NonNullable<ISandboxManager['isSandboxSpecDrifted']>>[1]
  isToolchainInstalling(sandboxId: string): boolean
  readToolchainSnapshot(squadId: string, sandboxId: string): Promise<ToolchainReconcileSnapshot>
  assertAdmissionOpen(): Promise<void>
  fullEnsure(squadId: string): Promise<string>
  probeTimeoutMs?: number
}

const defaultDeps = (): SquadSandboxFastPathDeps => ({
  findSquad: (squadId) => Squad.find(squadId),
  getSandboxId: (squadId) => Squad.getSandboxId(squadId),
  getManager: getSandboxManager,
  isRemoteRuntime: isRemoteSandboxRuntime,
  buildSandboxOptions: buildSquadK8sSandboxOptions,
  isToolchainInstalling: (sandboxId) => ensureSandboxToolchain.isInstalling(sandboxId),
  readToolchainSnapshot: readToolchainReconcileSnapshot,
  assertAdmissionOpen: assertMaintenanceAdmissionOpen,
  fullEnsure: (squadId) => ensureSquadSandbox(squadId),
})

/** Whether the recorded toolchain state needs no reconcile for this box. */
export function isToolchainSettled(snapshot: ToolchainReconcileSnapshot): boolean {
  const declared = snapshot.config && !isEmptyToolchain(snapshot.config)
  if (!declared) return !snapshot.provision && !snapshot.activation
  const fingerprint = fingerprintToolchain(normalizeToolchain(snapshot.config!))
  return (
    snapshot.provision?.status === 'ready' &&
    snapshot.provision.desiredFingerprint === fingerprint &&
    snapshot.provision.appliedFingerprint === fingerprint &&
    snapshot.activation?.appliedFingerprint === fingerprint
  )
}

async function fastPathBlocker(
  squad: Squad,
  sandboxId: string,
  manager: ISandboxManager,
  deps: SquadSandboxFastPathDeps
): Promise<string | undefined> {
  // Same test as ensureSquadSandbox's refusal.
  if (squad.isArchived || squad.status === 'archived') return 'archived'
  if (!deps.isRemoteRuntime()) return 'local-runtime'
  if (!manager.hasSandbox(sandboxId)) return 'untracked'
  if (manager.isSandboxSpecDrifted?.(sandboxId, deps.buildSandboxOptions(squad))) return 'spec-drift'
  if (deps.isToolchainInstalling(sandboxId)) return 'toolchain-installing'
  if (!isToolchainSettled(await deps.readToolchainSnapshot(squad.id, sandboxId))) return 'toolchain-unsettled'
  return undefined
}

async function probe(manager: ISandboxManager, sandboxId: string, workspacePath: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      manager.exec(sandboxId, ['sh', '-c', 'cd -- "$1" && pwd -P', 'ficus-box-check', workspacePath]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    if (!answer.toString().trim()) throw new Error('empty answer')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Return the squad's workspace path, skipping the full ensure when the box is
 * already tracked and healthy (see the module comment for every condition).
 */
async function ensureSquadSandboxForCommandsInScope(
  squadId: string,
  deps: SquadSandboxFastPathDeps = defaultDeps()
): Promise<SquadSandboxCheckResult> {
  const squad = await deps.findSquad(squadId)
  if (!squad) return { workspacePath: await deps.fullEnsure(squadId), path: 'full', reason: 'squad-missing' }
  const sandboxId = deps.getSandboxId(squadId)
  const manager = deps.getManager()
  let reason = await fastPathBlocker(squad, sandboxId, manager, deps)
  if (!reason) {
    await deps.assertAdmissionOpen()
    const workspacePath = manager.getWorkspaceLayout({ squadId, sandboxId }).workspaceMount
    try {
      await probe(manager, sandboxId, workspacePath, deps.probeTimeoutMs ?? SQUAD_BOX_PROBE_TIMEOUT_MS)
      return { workspacePath, path: 'fast' }
    } catch (error) {
      log.warn(`Squad box ${sandboxId} did not answer a quick check; running the full ensure:`, error)
      reason = 'probe-failed'
    }
  }
  return { workspacePath: await deps.fullEnsure(squadId), path: 'full', reason }
}

/**
 * A sandbox ensure is shared: concurrent callers join the same wake, and its setup
 * is persisted step by step. It therefore runs outside the cancellation scope of
 * the read that happened to start it (db/query-cancellation.ts), so a reader who
 * leaves never stops a wake that others, or the next reader, depend on.
 */
export function ensureSquadSandboxForCommands(
  ...args: Parameters<typeof ensureSquadSandboxForCommandsInScope>
): ReturnType<typeof ensureSquadSandboxForCommandsInScope> {
  return shareAcrossRequests(() => ensureSquadSandboxForCommandsInScope(...args))
}
