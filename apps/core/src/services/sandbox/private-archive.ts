import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { getSettingsStore } from '../settings'
import { workspaceDotPath } from '../workspace/dot-dir'

/** Ensure and return the archive root: HOME_DIR/private-archive. */
export function getPrivateArchiveRoot(): string {
  const root = join(getHomeDir(), 'private-archive')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Stage a finally terminated agent's private dir by moving HOME_DIR/private/<sandboxId>
 * to HOME_DIR/private-archive/<sandboxId>-<epochMillis>. Returns the destination
 * path, or null if there was nothing to archive. The trailing timestamp is the
 * independent post-termination retention clock consumed by the archive janitor.
 */
export function archiveAgentPrivateDir(sandboxId: string, when: Date): string | null {
  const src = join(getHomeDir(), 'private', sandboxId)
  if (!existsSync(src)) return null
  // Per-agent secrets are never retained: the archive keeps scratch, not credentials.
  removeAgentSecretsFileIfPresent(src)
  const dest = join(getPrivateArchiveRoot(), `${sandboxId}-${when.getTime()}`)
  renameSync(src, dest)
  return dest
}

function removeAgentSecretsFileIfPresent(privateRoot: string): void {
  const dotDir = workspaceDotPath(privateRoot)
  try {
    // Only a real settings dir: never remove through a symlink planted in the private dir.
    if (!lstatSync(dotDir).isDirectory()) return
  } catch {
    return
  }
  rmSync(join(dotDir, 'agent-secrets.env'), { force: true })
}

/**
 * Delete archived private dirs older than `retentionDays`. An entry's age comes
 * from its trailing `-<epochMillis>` suffix; entries without a numeric suffix are
 * left alone. Returns how many entries were removed.
 */
export function purgeExpiredAgentPrivateArchives(retentionDays: number, now: Date = new Date()): number {
  const root = getPrivateArchiveRoot()
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of readdirSync(root)) {
    const match = name.match(/-(\d+)$/)
    if (!match) continue
    if (Number(match[1]) < cutoff) {
      rmSync(join(root, name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

const log = createLogger('agent-private-archive-janitor')
const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000
const LIFECYCLE_CONVERGENCE_INTERVAL_MS = 60 * 1000
const ARCHIVE_BEARING_SWEEP_BUDGET = 5
// Dormancy keeps storage and only stops compute, like the 25-per-tick completion sweep; stay below it.
const IDLE_CONSULTANT_DORMANCY_BUDGET = 10
const IDLE_WORKER_DORMANCY_BUDGET = 10

/** Purge once using the configured retention. Injectable for tests; never throws. */
export function runArchivePurgeOnce(
  deps: { getRetentionDays?: () => number; purge?: (days: number) => number } = {}
): void {
  try {
    const getRetentionDays =
      deps.getRetentionDays ??
      (() => {
        const value = Number(getSettingsStore().getTyped('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS'))
        return Number.isFinite(value) && value > 0 ? value : 7
      })
    const purge = deps.purge ?? purgeExpiredAgentPrivateArchives
    const removed = purge(getRetentionDays())
    if (removed > 0) log.info(`Purged ${removed} expired agent private archive(s)`)
  } catch (err) {
    log.warn('Agent private archive purge failed:', err)
  }
}

let janitor: PeriodicRunner | null = null
let lifecycleConvergenceRunner: PeriodicRunner | null = null

type LifecycleConvergenceDeps = {
  legacy?: (options: { maxCandidates: number }) => Promise<unknown>
  pending?: () => Promise<unknown>
  dormancyCompletion?: () => Promise<unknown>
  dormantRetention?: (options: { maxCandidates: number }) => Promise<unknown>
  finalCleanup?: (options: { maxCandidates: number; maxWorkItems: number }) => Promise<unknown>
  idleConsultants?: (options: { maxAgents: number }) => Promise<unknown>
  idleWorkers?: (options: { maxAgents: number }) => Promise<unknown>
  retainedAssets?: (options: { maxAssets: number }) => Promise<unknown>
  warn?: (message: string, error: unknown) => void
}

/**
 * Run lifecycle convergence independently from the daily purge. Lightweight
 * repairs retain their own bounded defaults; archive/storage-bearing work is
 * capped to five roots/effects per minute.
 */
export async function runAgentLifecycleConvergenceOnce(deps: LifecycleConvergenceDeps = {}): Promise<void> {
  const tasks: Array<[string, () => Promise<unknown>]> = [
    [
      'legacy terminated repair',
      async () =>
        (deps.legacy ?? (await import('../agent/lifecycle')).runLegacyTerminatedAgentSweep)({
          maxCandidates: ARCHIVE_BEARING_SWEEP_BUDGET,
        }),
    ],
    [
      'pending lifecycle repair',
      async () => (deps.pending ?? (await import('../agent/lifecycle')).runPendingAgentLifecycleSweep)(),
    ],
    [
      'dormancy completion',
      async () => (deps.dormancyCompletion ?? (await import('../agent/lifecycle')).runDormancyCompletionSweep)(),
    ],
    [
      'dormant retention',
      async () =>
        (deps.dormantRetention ?? (await import('../agents/cleanup')).runDormantAgentSweep)({
          maxCandidates: ARCHIVE_BEARING_SWEEP_BUDGET,
        }),
    ],
    [
      'final cleanup',
      async () =>
        (deps.finalCleanup ?? (await import('../agents/cleanup')).runFinalAgentCleanupSweep)({
          maxCandidates: ARCHIVE_BEARING_SWEEP_BUDGET,
          maxWorkItems: ARCHIVE_BEARING_SWEEP_BUDGET,
        }),
    ],
    [
      // Every squad unless turned off (consultant_idle_dormancy_days null); same terminate→dormant path as a user.
      'idle consultant dormancy',
      async () =>
        (deps.idleConsultants ?? (await import('../agents/idle-consultants')).runIdleConsultantDormancySweep)({
          maxAgents: IDLE_CONSULTANT_DORMANCY_BUDGET,
        }),
    ],
    [
      // Always on: workers with no open stream and nothing in flight, idle past the grace period.
      'idle worker dormancy',
      async () =>
        (deps.idleWorkers ?? (await import('../agents/idle-workers')).runIdleWorkerDormancySweep)({
          maxAgents: IDLE_WORKER_DORMANCY_BUDGET,
        }),
    ],
    [
      // Work-stream references whose last share went without a release, and blob deletions to retry.
      'retained asset cleanup',
      async () =>
        (deps.retainedAssets ?? (await import('../work-streams/asset-attachments')).runRetainedAssetCleanup)({
          maxAssets: ARCHIVE_BEARING_SWEEP_BUDGET,
        }),
    ],
  ]
  for (const [name, task] of tasks) {
    try {
      await task()
    } catch (error) {
      const warn = deps.warn ?? ((message: string, cause: unknown) => log.warn(message, cause))
      warn(`Agent ${name} sweep failed`, error)
    }
  }
}

type JanitorStartDeps = {
  lifecycleTask?: () => Promise<void>
  purgeTask?: () => void
}

export function startAgentPrivateArchiveJanitor(deps: JanitorStartDeps = {}): void {
  if (!lifecycleConvergenceRunner) {
    lifecycleConvergenceRunner = createPeriodicRunner({
      name: 'agent-lifecycle-convergence',
      intervalMs: LIFECYCLE_CONVERGENCE_INTERVAL_MS,
      runImmediately: true,
      task: deps.lifecycleTask ?? runAgentLifecycleConvergenceOnce,
    })
    lifecycleConvergenceRunner.start()
    log.info('Agent lifecycle convergence runner started (every minute)')
  }
  if (janitor) return
  janitor = createPeriodicRunner({
    name: 'agent-private-archive-janitor',
    intervalMs: JANITOR_INTERVAL_MS,
    runImmediately: true,
    task: async () => (deps.purgeTask ?? runArchivePurgeOnce)(),
  })
  janitor.start()
  log.info('Agent private archive janitor started (daily)')
}

export async function stopAgentPrivateArchiveJanitor(): Promise<void> {
  const stopping = [janitor?.stop(), lifecycleConvergenceRunner?.stop()].filter(Boolean) as Promise<void>[]
  await Promise.all(stopping)
  janitor = null
  lifecycleConvergenceRunner = null
}
