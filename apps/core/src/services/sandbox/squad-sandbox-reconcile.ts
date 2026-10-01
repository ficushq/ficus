import { Squad } from '../../entities/Squad'
import { getSandboxManager, isRemoteSandboxRuntime } from './factory'
import { buildSquadK8sSandboxOptions, isSquadSandboxIdle } from './ensure'
import type { ISandboxManager, SandboxOptions } from './types'
import { WorkspaceDotDirConflictError } from '../workspace/dot-dir'

const RECONCILE_CONCURRENCY = 3

interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

interface ReconcileOptions {
  /** Sandbox manager to use. Defaults to the runtime manager on any remote
   *  (k8s or vm) runtime — both implement the drift methods. */
  manager?: ISandboxManager
  /** Build the desired sandbox options for a squad. Injectable for tests. */
  buildOptions?: (squad: Squad) => SandboxOptions
  /** Whether a squad is idle enough to safely recreate. Injectable for tests. */
  isIdle?: (squad: Squad, sandboxId: string) => Promise<boolean>
  /**
   * Active squads to reconcile. Supplied by the vm lifecycle tick, which
   * fetches the list once and shares it with the squad warmup in the same pass
   * (the two steps used to run the identical query back to back). Omitted (or
   * undefined) → this function fetches for itself, so every other caller is
   * unaffected.
   */
  squads?: Squad[]
}

/**
 * Recreate squad sandbox pods whose spec has drifted from the squad's current
 * config (e.g. an ephemeral-storage limit change) so the new spec takes effect
 * on live pods — but only when the squad is idle, so active work isn't killed.
 *
 * This is the proactive counterpart to the on-resume drift check in
 * ensureSquadSandbox; it catches always-on pods that are never re-ensured.
 */
export async function reconcileSquadSandboxSpecs(log: Logger, options: ReconcileOptions = {}): Promise<void> {
  // When a manager is injected (tests), skip the runtime gate. On a remote
  // runtime (k8s or vm) use the runtime manager: VmSandboxManager implements the
  // same drift methods, so vm always-on squads get proactive reconciliation too.
  const manager = options.manager ?? (isRemoteSandboxRuntime() ? getSandboxManager() : undefined)
  if (!manager?.recreateSandbox || !manager.getRunningSandboxSpecHash || !manager.computeSpecHash) return

  const buildOptions = options.buildOptions ?? buildSquadK8sSandboxOptions
  const isIdle = options.isIdle ?? isSquadSandboxIdle

  const squads = options.squads ?? (await Squad.list({ status: 'active', includeAnonymous: false }))
  if (squads.length === 0) return

  const candidates: Array<{ squad: Squad; sandboxId: string }> = []
  for (const squad of squads) {
    const sandboxId = Squad.getSandboxId(squad.id)

    // Each squad is isolated: one that cannot be inspected (a workspace settings
    // dir that needs a manual fix fails closed in buildOptions) is skipped with a
    // warning and never stops the reconcile of every other squad.
    try {
      // Compare the durable running spec hash to desired. A null hash on a ready
      // pre-rollout box is drift, so an idle box is recreated once and stamped.
      const runningHash = await manager.getRunningSandboxSpecHash(sandboxId)
      const desiredHash = manager.computeSpecHash(buildOptions(squad))
      if (runningHash === desiredHash) continue // up to date

      // Drifted — only recreate if the squad is idle (no recent agent activity,
      // no active local deployments). Busy squads are retried on a later pass.
      if (!(await isIdle(squad, sandboxId))) continue

      candidates.push({ squad, sandboxId })
    } catch (err) {
      if (err instanceof WorkspaceDotDirConflictError) {
        log.warn(`Sandbox spec reconcile skipped for squad ${squad.id}: ${err.message}`)
      } else {
        log.warn(`Sandbox spec reconcile skipped for squad ${squad.id}:`, err)
      }
    }
  }

  if (candidates.length === 0) return

  log.info(`Reconciling ${candidates.length} drifted squad sandbox(es)`)

  let nextIndex = 0
  async function reconcileNext(): Promise<void> {
    while (nextIndex < candidates.length) {
      const { squad, sandboxId } = candidates[nextIndex++]
      try {
        await manager!.recreateSandbox!(sandboxId, buildOptions(squad))
        log.info(`Reconciled sandbox spec for squad ${squad.id}`)
      } catch (err) {
        log.warn(`Sandbox spec reconcile failed for ${squad.id}:`, err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, candidates.length) }, () => reconcileNext()))
}
