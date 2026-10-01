import { randomBytes, randomUUID } from 'crypto'
import { db } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { isVmRuntime as isVmRuntimeReal } from '../sandbox/runtime'
import { resolveBoxApiUrl as resolveBoxApiUrlReal } from '../sandbox/vm/file-sync'
import { boxHomeForUser, boxUnitControl, boxUnixUser } from './box-paths'
import {
  BoxArchiveStreamError,
  durableStateDirsForRole,
  checkDestinationBaseline,
  compareStateDirFacts,
  detectArchiveCodec as detectArchiveCodecReal,
  installBoxOnMachine as installBoxOnMachineReal,
  measureBoxStateDirs as measureBoxStateDirsReal,
  startBoxAndAwaitHealth as startBoxAndAwaitHealthReal,
  streamBoxStateArchive as streamBoxStateArchiveReal,
  teardownBoxOnMachine as teardownBoxOnMachineReal,
} from './box-manager'
import type { ArchiveCodec, BoxEnv, BoxManagerDeps, EnsureBoxOpts, FetchLike, StateDirFacts } from './box-manager'
import {
  bindMachineBox as bindMachineBoxReal,
  clearBoxMigrating as clearBoxMigratingReal,
  fenceBoxForMigration as fenceBoxForMigrationReal,
  getMachine as getMachineReal,
  getMachineBox as getMachineBoxReal,
  peekNextBoxPort as peekNextBoxPortReal,
} from './queries'
import type { Machine } from './queries'
import { ensureMachineArtifacts as ensureMachineArtifactsReal } from './machine-artifacts-registry'
import { isMigrationCancellation } from './migration-cancellation'
import {
  beginManualBoxEvacuation,
  failEvacuationSourceRetained,
  recordEvacuationBoxProof,
  verifyMachineEvacuation,
} from './machine-evacuation'
import { loadMigrationManifest, persistMigrationManifest } from './migration-evidence'
import { compareMigrationManifests } from './migration-manifest'
import type { MigrationManifestV1 } from './migration-manifest'
import { scanMigrationManifest as scanMigrationManifestReal } from './migration-scanner'
import { defaultSshRunner } from './ssh'
import { sandboxActivity } from './sandbox-activity'
export { sandboxActivity, sandboxHasActiveExecution } from './sandbox-activity'
export type { SandboxActivity } from './sandbox-activity'
import {
  findForceMigrationAudit,
  finishForceMigrationAuditInTransaction,
  finishForceMigrationAudit,
  startForceMigrationAudit,
  requireForceMigrationSettlement,
  type DbExecutor,
  type ForceMigrationActor,
} from './force-migration-audit'

const log = createLogger('box-migrate')

/**
 * Manual-rebalance primitive: move ONE sandbox box (a per-sandbox unix user)
 * from its current machine to an explicit target machine, preserving its
 * authoritative state (`~/.private`, plus a squad box's `~/workspace`) —
 * Approach B ordering, where the OLD box survives any failure that happens
 * before its teardown:
 *
 *   fence → measure the OLD box's state dirs → provision NEW box on the target →
 *   STREAM the state source→destination (BEFORE the unit's first start) →
 *   verify the destination's actual state → start + health-verify →
 *   repoint the row → tear down the OLD box → unfence
 *
 * ## Why the state STREAMS instead of landing on core
 * The transfer used to pull the whole archive back to core as one base64
 * string, buffer it in memory, write it to core's disk, and only then push it
 * on. That is survivable for an agent box's small `~/.private` and hopeless for
 * a squad's multi-GB `~/workspace`. It now pipes the source's `tar c` straight
 * into the destination's `box-provision.sh --restore-stream` (see
 * {@link streamBoxStateArchiveReal}), so memory is flat and nothing is staged
 * on core OR on either machine's disk.
 *
 * That removed the artifact the old safety check read (a `tar tzf` of the
 * pulled archive, proving it carried `workspace/`). Its replacement is
 * strictly stronger and lives in THREE places around the transfer:
 *  - BEFORE it, the source's state dirs are measured (presence + top-level
 *    entry count) — an unmeasurable source, or a squad with no `~/workspace`,
 *    aborts with nothing provisioned;
 *  - after provisioning but still BEFORE it, the DESTINATION's state dirs are
 *    measured and required to be present and EMPTY
 *    ({@link checkDestinationBaseline}) — a target still carrying a tree from
 *    an earlier abandoned attempt is refused rather than streamed onto;
 *  - AFTER it and BEFORE the old box is torn down, the SOURCE is re-measured
 *    and the DESTINATION's actual state is measured and compared against BOTH
 *    source readings ({@link compareStateDirFacts}): every dir present, holding
 *    within [min, max] of what the source held on either side of the transfer,
 *    owned by the box user with the right mode. This verifies the OUTCOME
 *    rather than the transport, which is what the old check could never do.
 *    The band is not slack: the source stays live across minutes of artifact
 *    delivery and box install, so a single pre-provision reading would abort
 *    the move on ordinary concurrent drift AFTER the whole stream was paid
 *    for. The upper bound is retained because a stale superset on the
 *    destination could otherwise stand in for content the transfer silently
 *    dropped, and the old box — the last real copy — would be torn down
 *    against it (the empty baseline is the primary guard against that; this is
 *    the backstop).
 *
 * ## Why the row repoints BEFORE the old teardown (deliberate inversion of the
 * naive "removeBox old, then bind new")
 * `removeBox` DELETES the `machine_boxes` row. That row is (a) the migration
 * fence itself (`migrating = true` — deleting it would let a queued turn start
 * mid-move on a box that no longer exists), (b) the holder of the box's
 * persisted executor auth token (a post-delete bind would mint a FRESH token
 * that mismatches the one already baked into the new unit's server.env — a
 * wedged box), and (c) the box's only identity reservation (a concurrent
 * ensure racing the gap would re-place the box somewhere else entirely). So
 * the success path repoints the row first — `bindMachineBox` with the
 * provisioned port + the preserved token, which keeps `migrating` set and the
 * token COALESCE-stable — and only then tears the old box down WITHOUT
 * touching the row ({@link teardownBoxOnMachine}). A repoint failure therefore
 * leaves the old box fully authoritative (the new box is torn down
 * best-effort); an old-teardown failure after the healthy repoint is logged
 * remnants, and the move still succeeded.
 *
 * The old machine may end up empty with no `empty_since` stamp (the repoint
 * bypasses deleteMachineBox's last-box accounting); the machine reaper's
 * repair pass (`stampMachineEmptySinceIfDrained`) exists precisely for
 * repoint drains and starts its idle clock on the next sweep.
 */

export type MigrateReason =
  | 'already-on-target'
  | 'active-turn'
  | 'squad-box'
  | 'provision-failed'
  // The old box's state could not be READ: its state-dir probe failed, a squad
  // box had no ~/workspace, or the SOURCE end of the streamed transfer exited
  // non-zero AND the destination's did not. Distinct from 'restore-failed' (the
  // DESTINATION end failed, or the restored state failed verification) so
  // operators can tell "old machine unreadable" from "target write failed" at a
  // glance — a distinction the streamed transport preserves by reporting which
  // end died. An AMBIGUOUS attribution (both ends non-zero) is deliberately NOT
  // reported here: this reason names a machine, and a guess must not.
  | 'archive-failed'
  // A squad box's local deployments could not be terminated before the archive
  // (step 5.5). The stop MUST complete first or the ~/workspace tar is taken
  // while an app is still writing to it (an inconsistent archive), so a failed
  // quiesce is a hard abort — the old box stays fully authoritative.
  | 'quiesce-failed'
  // Something on the DESTINATION side went wrong: its freshly-provisioned state
  // dirs were not clean/measurable BEFORE the stream (step 7.5), the
  // destination end of the transfer exited non-zero, or the restored state
  // failed verification (step 8.5). Also the catch-all for a transfer whose
  // failing end could not be told apart (see 'archive-failed'). In every case
  // nothing was repointed and the old box is still authoritative.
  | 'restore-failed'
  | 'source-changed'
  | 'target-root-presence-mismatch'
  | 'target-entry-missing'
  | 'target-extra-entry'
  | 'target-metadata-mismatch'
  | 'target-content-mismatch'
  | 'transfer-incomplete'
  | 'unhealthy'
  // The final repoint (conditional bindMachineBox) failed: either its CAS
  // precondition found the row drifted (a concurrent ensure/bind touched it in
  // the provision window — BoxBindConflictError) or the bind itself was
  // rejected (target claimed by the reaper, port taken). Every case ROLLS BACK
  // inside the bind transaction, so the row still points at the OLD machine:
  // the new box is torn down and the old box stays authoritative.
  | 'repoint-conflict'
  | 'box-not-found'
  | 'machine-not-ready'
  // Never returned by migrateBox itself: the generic label callers (e.g.
  // rebalanceFleet) record when a migrate attempt THREW instead of returning
  // one of the structured reasons above.
  | 'failed'

export type MigrateResult = {
  moved: boolean
  reason?: MigrateReason
  activeExecutionCount?: number
  migrationProof?: { manifestDigest: string; files: number; bytes: string }
  lossReport?: { type: MigrateReason; root?: 'workspace' | '.private'; pathB64?: string }
}

/**
 * Ordered phases a migrate passes through, streamed to a driving CLI so an
 * external orchestrator (the platform's machine-host resize job, tailing the
 * CLI over SSH) can tell which phase is running WITHOUT waiting for the end.
 * `stop-deployments` / `restart-deployments` only appear for squad boxes.
 */
export type MigratePhase =
  | 'fence'
  | 'stop-deployments'
  | 'archive'
  | 'provision'
  | 'restore'
  | 'health'
  | 'repoint'
  | 'teardown'
  | 'restart-deployments'

export interface MigrateProgress {
  phase: MigratePhase
  sandboxId: string
}

/** Caller-facing options (distinct from {@link MigrateDeps}, which are injectable
 *  effects for tests). */
export interface MigrateOptions {
  /** Whole-host evacuation that will aggregate this box proof. */
  evacuationId?: string
  /**
   * Whether a SQUAD box may migrate. **Defaults to true.**
   *
   * It was originally an opt-in (default false) because a squad box carries its
   * authoritative `~/workspace`, and the old archive path materialized that
   * whole tree as a base64 string in core's memory — survivable for an agent
   * box's `~/.private`, hopeless for a multi-GB workspace. Streaming replaced
   * that (source `tar -c` piped straight into destination `tar -x`, constant
   * memory, no disk staging), which is what makes the default flip safe.
   *
   * Pass `false` to restore the old refusal for a caller that wants it.
   *
   * Note this flag was never what kept `rebalance` away from squads: its
   * PLANNER excludes squad boxes structurally (they are VM-exclusive anchors,
   * and only non-squad boxes are ever selected as movable). Rebalance behaviour
   * is therefore unchanged by this default. What the flip unblocks is DIRECT
   * migration — the machines route, the CLI, and the platform resize job, which
   * previously could not evacuate any machine hosting a squad box.
   *
   * A migrating squad box still carries its `~/workspace` and still has its
   * local deployments quiesced and restarted around the move.
   *
   * The fence IS squad-aware (see {@link sandboxActivity}): a squad-capable
   * member's `running`/`stopping` execution refuses the move, and execution
   * pickup takes the same `machine_boxes` row lock, so pickup and migration
   * cannot pass each other. `queued` rows deliberately do NOT block — once the
   * fence commits, pickup's locked read defers them (pinned on real
   * connections by pickup.test.ts, "a queued execution does not block the squad
   * fence — and cannot start once it commits"), so counting them would only
   * manufacture refusals.
   *
   * RESIDUAL, still true and still on the operator: the probe is DB-only, so
   * anything not tied to a live execution row is unfenced — an in-flight
   * `squad_bash` command whose execution has already settled, a detached build
   * or watcher writing `~/workspace`, a file-sync. Those writes can land after
   * the source tar is read and are simply not migrated. Local deployments are
   * the one background writer handled explicitly (quiesced before transfer,
   * restarted after).
   */
  allowSquad?: boolean
  /**
   * Operator override for the ACTIVE-EXECUTION refusal only (`--force` on
   * `ficus machines migrate-box`) with an attributable actor and durable reason.
   *
   * Exists for one situation: a machine is dying and its boxes must be
   * evacuated NOW, even though the fence reports live work — a fence with no
   * override is fine right up until the one time it is wrong. It bypasses
   * NOTHING else: the box must still exist, both machines must still be ready,
   * a squad box still needs `allowSquad`, a concurrent migration still owns the
   * fence, and the ordering law (measure → provision → stream → verify →
   * health → repoint → teardown) is untouched.
   *
   * It is genuinely dangerous. `migrateBox` streams `~/workspace` and then
   * TEARS DOWN THE SOURCE BOX; any write a live turn makes after the tar is
   * read is destroyed with it. A bypass logs at `warn` with the active count.
   */
  force?: {
    actor: ForceMigrationActor
    reason: string
    requestId: string
  }
  /** Per-phase progress sink (see {@link MigratePhase}); no-op when omitted. */
  onProgress?: (progress: MigrateProgress) => void
}

/** Transfer SSH budget for a SQUAD migration — a multi-GB ~/workspace stream
 *  must not die on the runner's 30s default. Env-overridable; 30 minutes covers
 *  tens of GB at typical SSH throughput.
 *
 *  Scoped to the TRANSFER alone. The state-dir probes on either side are
 *  O(top-level entries) and keep the runner default on every role, so an
 *  unreachable machine fails those fast instead of hanging for half an hour. */
const SQUAD_ARCHIVE_EXEC_TIMEOUT_MS = Number(process.env.FICUS_BOX_MIGRATE_ARCHIVE_TIMEOUT_MS) || 30 * 60_000

/** Transfer SSH budget for an AGENT / system-manager migration.
 *
 *  Minutes, not the runner's 30s default: an agent box's ~/.private is its
 *  working root and holds its git trees, and streaming actually TIGHTENED the
 *  old shape — the pull got 30s and the restore got another 30s, whereas the
 *  single streamed transfer would get 30s for both. A fat box is not a broken
 *  box.
 *
 *  Still an order of magnitude under the squad budget, because the fail-fast
 *  rationale is real for a HUNG box: rebalance moves boxes sequentially, so one
 *  unreachable agent box must not stall the whole run for half an hour.
 *
 *  Env-overridable like its squad twin: 5 minutes is only ~600MB on a 2MB/s
 *  cross-region link, and an operator moving fat agent boxes over a slow link
 *  needs an escape hatch that is not a redeploy. */
const AGENT_ARCHIVE_EXEC_TIMEOUT_MS = Number(process.env.FICUS_BOX_MIGRATE_AGENT_ARCHIVE_TIMEOUT_MS) || 5 * 60_000

/** All external effects, injectable for tests; each defaults to production. */
export interface MigrateDeps extends BoxManagerDeps {
  isVmRuntime?: () => boolean
  fenceBoxForMigration?: typeof fenceBoxForMigrationReal
  clearBoxMigrating?: typeof clearBoxMigratingReal
  findForceMigrationAudit?: typeof findForceMigrationAudit
  startForceMigrationAudit?: typeof startForceMigrationAudit
  finishForceMigrationAudit?: typeof finishForceMigrationAudit
  /** Activity probe run INSIDE the fence transaction — must stay DB-only and
   *  executions-table-only (see fenceBoxForMigration's deadlock note). */
  hasActiveExecution?: (sandboxId: string, executor?: DbExecutor) => Promise<boolean>
  peekNextBoxPort?: typeof peekNextBoxPortReal
  /** Agree ONE compression codec across both machines before any byte moves. */
  detectArchiveCodec?: typeof detectArchiveCodecReal
  /** Probe a box's state dirs (presence / owner / mode / top-level entries) —
   *  used for the SOURCE measurement and the DESTINATION verification. */
  measureBoxStateDirs?: typeof measureBoxStateDirsReal
  /** Cryptographically inventory both durable roots. */
  scanMigrationManifest?: typeof scanMigrationManifestReal
  beginManualBoxEvacuation?: typeof beginManualBoxEvacuation
  recordEvacuationBoxProof?: typeof recordEvacuationBoxProof
  verifyMachineEvacuation?: typeof verifyMachineEvacuation
  failEvacuationSourceRetained?: typeof failEvacuationSourceRetained
  /** The source→destination transfer itself. */
  streamBoxStateArchive?: typeof streamBoxStateArchiveReal
  installBoxOnMachine?: typeof installBoxOnMachineReal
  startBoxAndAwaitHealth?: typeof startBoxAndAwaitHealthReal
  teardownBoxOnMachine?: typeof teardownBoxOnMachineReal
  /** Reverse-tunnel callback URL resolver for the TARGET machine (see the
   *  FICUS_API_URL re-resolution note in migrateBox). */
  resolveBoxApiUrl?: (machine: Machine) => Promise<string>
  /** Terminate a squad box's local-deployment PROCESSES (not just mark the DB)
   *  before the archive; defaults to stopLocalDeploymentsForSandbox. */
  stopLocalDeploymentsForBox?: (sandboxId: string) => Promise<void>
  /** Restart a squad box's managed/restartable local deployments on the TARGET
   *  after the move is proven; defaults to restartManagedLocalDeploymentsForSandbox. */
  restartLocalDeploymentsForBox?: (sandboxId: string) => Promise<void>
}

/** Single-quote a value for safe interpolation into a remote shell command
 *  (same shape as box-manager's local helper). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Box role from the sandboxId prefix — the vm manager's convention
 *  (`squad_` / `system_manager_` / `agent_`), lifted here so this module never
 *  imports the (higher-layer) vm manager. */
function roleFromSandboxId(sandboxId: string): EnsureBoxOpts['role'] {
  if (sandboxId.startsWith('squad_')) return 'squad'
  if (sandboxId.startsWith('system_manager_')) return 'system-manager'
  return 'agent'
}

const DERIVED_ENV_KEYS = new Set([
  'EXECUTOR_PORT',
  'EXECUTOR_AUTH_TOKEN',
  'EXECUTOR_BIND',
  'WORKSPACE_PATH',
  'FICUS_DEVBOX_DIR',
  'FICUS_BOX_HOME',
  'BUN_PTY_LIB',
  'DOCKER_HOST',
])

/** Parse a systemd EnvironmentFile body (`KEY=value` lines) into a BoxEnv. */
function parseServerEnv(content: string): BoxEnv {
  const env: BoxEnv = {}
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    env[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return env
}

/** Per-attempt timeout for the token-auth probe fetch (mirrors the /healthz
 *  probes' bounded per-request abort). */
const AUTH_PROBE_TIMEOUT_MS = 2_000

/**
 * Move `sandboxId`'s box to `targetMachineId` (see the module doc for the full
 * ordering + failure-containment story). Never interrupts a live turn: the box
 * is fenced first (set-then-recheck under the row lock), every post-fence exit
 * clears the fence, and any failure before the old teardown leaves the old box
 * and its row untouched — the old box IS the retained copy, since the state is
 * streamed host→host and no core-side archive is written on this path at all.
 * vm-runtime only.
 */
export async function migrateBox(
  sandboxId: string,
  targetMachineId: string,
  deps: MigrateDeps = {},
  opts: MigrateOptions = {}
): Promise<MigrateResult> {
  if (!(deps.isVmRuntime ?? isVmRuntimeReal)()) {
    throw new Error('migrateBox is only available on the VM sandbox runtime')
  }

  const progress = (phase: MigratePhase) => opts.onProgress?.({ phase, sandboxId })
  // Lazy defaults (dynamic import) for the deploy-service wiring: keeps the
  // machines layer free of a static deploy import and is never hit in tests
  // (which inject fakes).
  const stopDeployments =
    deps.stopLocalDeploymentsForBox ??
    (async (id: string) => {
      const { stopLocalDeploymentsForSandbox } = await import('../deploy/local-deployment-health')
      await stopLocalDeploymentsForSandbox(id)
    })
  const restartDeployments =
    deps.restartLocalDeploymentsForBox ??
    (async (id: string) => {
      const { restartManagedLocalDeploymentsForSandbox } = await import('../deploy/local-deployment-health')
      // skipIfMigrating: false — this IS the migration (the row is already
      // repointed to the target; the fence is only still up because it isn't
      // lifted until this whole call returns). Every OTHER restart trigger
      // (the health poller, ensureSquadSandbox) keeps the default `true` guard
      // so they never resurrect a deployment on the OLD box mid-archive.
      await restartManagedLocalDeploymentsForSandbox(id, { skipIfMigrating: false })
    })

  const runner = deps.runner ?? defaultSshRunner
  const getBox = deps.getMachineBox ?? getMachineBoxReal
  const getMachine = deps.getMachine ?? getMachineReal
  const fence = deps.fenceBoxForMigration ?? fenceBoxForMigrationReal
  const clearFence = deps.clearBoxMigrating ?? clearBoxMigratingReal
  const ensureArtifacts = deps.ensureMachineArtifacts ?? ((m: Machine) => ensureMachineArtifactsReal(m))
  const peekPort = deps.peekNextBoxPort ?? peekNextBoxPortReal
  const detectCodec = deps.detectArchiveCodec ?? detectArchiveCodecReal
  const measureStateDirs = deps.measureBoxStateDirs ?? measureBoxStateDirsReal
  const scanManifest = deps.scanMigrationManifest ?? scanMigrationManifestReal
  const beginManual = deps.beginManualBoxEvacuation ?? beginManualBoxEvacuation
  const recordProof = deps.recordEvacuationBoxProof ?? recordEvacuationBoxProof
  const verifyEvacuation = deps.verifyMachineEvacuation ?? verifyMachineEvacuation
  const failEvacuation = deps.failEvacuationSourceRetained ?? failEvacuationSourceRetained
  const streamStateArchive = deps.streamBoxStateArchive ?? streamBoxStateArchiveReal
  const install = deps.installBoxOnMachine ?? installBoxOnMachineReal
  const start = deps.startBoxAndAwaitHealth ?? startBoxAndAwaitHealthReal
  const teardown = deps.teardownBoxOnMachine ?? teardownBoxOnMachineReal
  const bind = deps.bindMachineBox ?? bindMachineBoxReal
  const resolveApiUrl = deps.resolveBoxApiUrl ?? ((m: Machine) => resolveBoxApiUrlReal(m))
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const findForceAudit = deps.findForceMigrationAudit ?? findForceMigrationAudit
  const startForceAudit = deps.startForceMigrationAudit ?? startForceMigrationAudit
  const finishForceAudit = deps.finishForceMigrationAudit ?? finishForceMigrationAudit

  // 1. The box must exist. A squad box migrates by DEFAULT (allowSquad
  // defaults to true) now that archives stream rather than being buffered
  // whole in memory; pass allowSquad:false to restore the old refusal. This
  // does not change rebalance, whose planner never selects a squad box in the
  // first place. A migrating squad box carries its authoritative ~/workspace
  // (the role-driven archive set) and has its local deployments
  // quiesced/restarted around the move. (`let`: this pre-fence snapshot is
  // swapped for the post-fence re-read in step 5.)
  let box = await getBox(sandboxId)
  if (!box) return { moved: false, reason: 'box-not-found' }
  const role = roleFromSandboxId(sandboxId)
  if (role === 'squad' && opts.allowSquad === false) return { moved: false, reason: 'squad-box' }
  if (opts.force && role !== 'squad') throw new Error('Forced migration is only supported for squad boxes')
  if (opts.force) {
    const existing = await findForceAudit(opts.force.requestId)
    if (existing) {
      if (
        existing.sandboxId !== sandboxId ||
        existing.squadId !== sandboxId.slice('squad_'.length) ||
        existing.sourceMachineId !== box.machineId ||
        existing.targetMachineId !== targetMachineId ||
        existing.actorType !== opts.force.actor.type ||
        existing.actorId !== opts.force.actor.id ||
        existing.reason !== opts.force.reason.trim()
      )
        throw new Error('Forced migration request ID conflict')
      if (existing.outcome === 'started') throw new Error('Forced migration request is already in progress')
      if (existing.result) return existing.result as MigrateResult
      throw new Error('Forced migration terminal audit has no replay result')
    }
  }

  // 2. Idempotent no-op.
  if (box.machineId === targetMachineId) return { moved: false, reason: 'already-on-target' }

  // 3. Both machines must be ready: the target to receive the new box, the OLD
  // one because every pre-teardown step (archive pull, env read) SSHes it — a
  // box stranded on a dead machine is outage recovery's job, not a migrate.
  const target = await getMachine(targetMachineId)
  if (!target || target.status !== 'ready') return { moved: false, reason: 'machine-not-ready' }
  const oldMachine = await getMachine(box.machineId)
  if (!oldMachine || (oldMachine.status !== 'ready' && !(opts.evacuationId && oldMachine.status === 'draining')))
    return { moved: false, reason: 'machine-not-ready' }
  const operationId = opts.evacuationId ?? randomUUID()
  if (!opts.evacuationId)
    await beginManualBoxEvacuation({
      operationId,
      sourceMachineId: oldMachine.id,
      targetMachineId,
      sandboxId,
      unixUser: box.unixUser,
    })

  // 4. Fence (exclusive claim, set-then-recheck under the box row lock). A lost
  // claim means an active turn, a concurrent migration, or a just-removed box —
  // in every case the box must be left alone, and the fence was never ours to
  // clear. From HERE on, every exit path clears the fence (the finally below).
  progress('fence')
  let activeExecutionCount: number | undefined
  const measureActivity =
    deps.hasActiveExecution ??
    (async (id: string, executor?: DbExecutor) => {
      const activity = await sandboxActivity(id, executor)
      if (activity.activeExecutionCount !== undefined) activeExecutionCount = activity.activeExecutionCount
      return activity.active
    })
  let forceAuditId: string | undefined
  const activityProbe = async (id: string, executor: DbExecutor = db) => {
    const active = await measureActivity(id, executor)
    if (!opts.force) return active
    if (activeExecutionCount === undefined) throw new Error('Forced migration activity count is unavailable')
    const squadId = id.slice('squad_'.length)
    const audit = await startForceAudit(
      {
        requestId: opts.force.requestId,
        actor: opts.force.actor,
        reason: opts.force.reason,
        sandboxId: id,
        squadId,
        sourceMachineId: box!.machineId,
        targetMachineId,
        activeExecutionCount,
      },
      executor
    )
    if (audit.outcome !== 'started') throw new Error('Forced migration request has already completed')
    forceAuditId = audit.id
    if (active)
      log.warn(
        `migrate ${id}: forced by ${opts.force.actor.type}:${opts.force.actor.id} past ${activeExecutionCount} active execution(s); request ${opts.force.requestId}`
      )
    return false
  }
  let fenced: boolean
  try {
    fenced = await fence(sandboxId, activityProbe)
  } catch (error) {
    if (forceAuditId) {
      try {
        const settlement = await finishForceAudit(
          forceAuditId,
          'failed',
          { moved: false, reason: 'failed' },
          'fence-failed'
        )
        // The started audit is written ON the fence transaction, so a fence
        // that THREW took the record down with it: `missing` is the expected
        // outcome here, not a settlement failure. Nothing destructive ran and
        // there is no phantom `started` row left to settle, so the caller must
        // see the fence's own error — not an AggregateError blaming the audit.
        // A genuine conflicting terminal state still fails closed.
        if (settlement.kind !== 'missing') requireForceMigrationSettlement(settlement)
      } catch (auditError) {
        throw new AggregateError([error, auditError], 'Fence and forced migration audit settlement both failed')
      }
    }
    await failEvacuationSourceRetained(operationId)
    throw error
  }
  if (!fenced) {
    await failEvacuationSourceRetained(operationId)
    return {
      moved: false,
      reason: 'active-turn',
      ...(activeExecutionCount === undefined ? {} : { activeExecutionCount }),
    }
  }

  const unixUser = boxUnixUser(sandboxId)
  const home = boxHomeForUser(unixUser)

  // Role-scaled SIZE budget for everything in this move that is bounded by how
  // big the box's state is rather than by how alive its machine is: half an
  // hour for a squad's potentially-huge ~/workspace, minutes for an agent's
  // ~/.private. Neither is the runner's 30s default — that is a hung-box bound,
  // not a big-box one. See both consts' docs.
  //
  // It covers the TRANSFER and BOTH teardowns, because `box-provision.sh
  // --remove` gzips the entire home before `userdel`: on the 30s default the
  // teardown of a just-streamed multi-GB home times out, its tree survives on
  // the target, and step 7.5's baseline then refuses every later migration of
  // that box to that machine — turning "costs a retry" into a permanent block.
  // The state-dir probes keep the runner default on every role (they are
  // O(top-level entries)), so an unreachable machine still fails fast.
  const sizeBudgetMs = role === 'squad' ? SQUAD_ARCHIVE_EXEC_TIMEOUT_MS : AGENT_ARCHIVE_EXEC_TIMEOUT_MS

  /** Best-effort teardown of the just-provisioned NEW box on a failure path —
   *  never masks the structured reason it accompanies. */
  const teardownNewBox = async (port: number) => {
    try {
      await teardown(target, sandboxId, unixUser, port, { timeoutMs: sizeBudgetMs }, deps)
    } catch (err) {
      log.warn(
        `migrate ${sandboxId}: best-effort teardown of the new box on ${targetMachineId} failed ` +
          `(remnants left for the machine-side sweep): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  let migrationSucceeded = false
  let sourceUnitStopped = false
  let forceAuditSettled = false
  let atomicAuditCallbackRan = false
  let migrationCanceled = false
  let terminalResult: MigrateResult | undefined
  let primaryError: unknown
  const terminal = (result: MigrateResult): MigrateResult => {
    terminalResult = result
    return result
  }
  try {
    // 5. Post-fence staleness re-check. The snapshot above was taken BEFORE the
    // fence was won, and ensureBox's full path is NOT fence-gated (it also
    // fires from non-turn paths), so a concurrent ensure can mutate the row in
    // the getBox→fence window: repoint it (migrate would then operate against
    // a stale machine) or — for a legacy token-less box — mint and persist its
    // OWN token (the final bind's COALESCE would keep it while the new unit
    // serves ours: a permanently wedged 401 box, exactly what this design
    // exists to prevent). Re-read under the fence; ANY drift of the
    // load-bearing fields aborts. Nothing is provisioned yet, so aborting
    // leaves the old box and its row fully intact (the finally lifts the
    // fence), and the fresh row replaces the snapshot for the rest of the move.
    const fresh = await getBox(sandboxId)
    if (!fresh) {
      log.warn(`migrate ${sandboxId}: box row vanished between snapshot and fence (concurrent remove); aborting`)
      return terminal({ moved: false, reason: 'box-not-found' })
    }
    if (fresh.machineId !== box.machineId || fresh.port !== box.port || fresh.authToken !== box.authToken) {
      log.warn(
        `migrate ${sandboxId}: box row drifted between snapshot and fence ` +
          `(machine ${box.machineId} → ${fresh.machineId}, port ${box.port} → ${fresh.port}, ` +
          `token ${box.authToken === fresh.authToken ? 'unchanged' : 'CHANGED'}); aborting untouched`
      )
      return terminal({ moved: false, reason: 'provision-failed' })
    }
    box = fresh

    // Stop every source box writer, not only squad deployments. The migration
    // fence blocks new turns but does not stop detached commands or the box
    // server itself. Keep the unit down until exact verification and repoint;
    // failure paths restart it before releasing the fence.
    //
    // `loginctl terminate-user` alone is enough ONLY for a user-manager box: it
    // kills the user's sessions and its lingering manager (and with it the
    // sandbox-server). A box on a per-box SYSTEM unit has no user manager at
    // all — its server is a system service running AS that user, which
    // terminate-user does not touch — so stop the unit explicitly first, and
    // keep terminate-user afterwards (best-effort) to reap anything the box
    // user left detached. Ordering matters: the unit's Restart=on-failure would
    // otherwise resurrect a server the kill had just taken out.
    //
    // Under socket activation the SERVER is not the only thing to take down:
    // the socket unit would re-activate the proxy (and through it the server)
    // on the next connection, in the middle of the archive. Stop all three,
    // socket first.
    const unitCtl = boxUnitControl({ sandboxId, unixUser })
    const quiesceCmd =
      unitCtl.mode === 'system'
        ? `${unitCtl.systemctl} stop ${unitCtl.allUnits} && { sudo loginctl terminate-user ${unixUser} || true; }`
        : // User mode needs no explicit unit stop: terminate-user takes the whole
          // user manager down, and the box's three units live inside it.
          `sudo loginctl terminate-user ${unixUser}`
    const stopResult = await runner.run(oldMachine, quiesceCmd)
    if (stopResult.exitCode !== 0) return terminal({ moved: false, reason: 'quiesce-failed' })
    sourceUnitStopped = true

    // 5.5. Quiesce squad-box local deployments BEFORE the archive: actually
    // terminate the running processes (not just mark the DB), so no app is
    // writing to ~/workspace while it is tar'd. The stop MUST complete first —
    // a failure is a hard abort (the old box is untouched beyond a read). Agent
    // and system-manager boxes have no local deployments, so this is skipped for
    // them (keeping their path byte-identical). Restarted after the move proves
    // out (step 10.5).
    if (role === 'squad') {
      progress('stop-deployments')
      try {
        await stopDeployments(sandboxId)
      } catch (err) {
        log.warn(`migrate ${sandboxId}: local-deployment quiesce failed (old box intact): ${String(err)}`)
        return terminal({ moved: false, reason: 'quiesce-failed' })
      }
    }

    // 6. Read the OLD box's authoritative state — its role-driven state dirs
    // (~/.private for agent/system-manager, ~/workspace + ~/.private for a
    // squad box) — and agree ONE codec both machines can write AND read, so
    // the transfer can never produce an archive the destination cannot decode.
    // This step only READS: a failure leaves the old box fully intact and
    // nothing provisioned.
    //
    // The measurement is the baseline the post-restore destination check
    // compares against (step 8.5). Taking it from the SOURCE — rather than
    // applying a fixed floor — is what lets a brand-new squad with a genuinely
    // empty ~/workspace migrate while a LOST workspace still fails.
    const stateDirs = durableStateDirsForRole(role)
    progress('archive')
    let codec: ArchiveCodec
    let sourceFacts: Record<string, StateDirFacts>
    let sourceManifest: MigrationManifestV1
    const manifestIdentity = {
      operationId,
      sandboxId,
      source: { machineId: oldMachine.id, generation: null, unixUser },
      target: { machineId: target.id, generation: null, unixUser },
    }
    try {
      codec = await detectCodec(runner, [oldMachine, target])
      sourceFacts = await measureStateDirs(runner, oldMachine, sandboxId, home, stateDirs)
      sourceManifest = await scanManifest(runner, oldMachine, home, unixUser, manifestIdentity)
      persistMigrationManifest(sourceManifest)
      sourceManifest = loadMigrationManifest(manifestIdentity.operationId, sandboxId)
    } catch (err) {
      log.warn(`migrate ${sandboxId}: state read of the box on ${box.machineId} failed: ${String(err)}`)
      return terminal({ moved: false, reason: 'archive-failed' })
    }

    // 6.5. Squad-only: box-provision.sh's `ensure_dirs` creates ~/workspace for
    // EVERY box, so its absence on a squad box means the source is not in a
    // state we can safely read from — refuse while the old box (the last
    // surviving authoritative copy of the squad's work) is still fully intact.
    if (role === 'squad' && !sourceFacts.workspace?.present) {
      log.warn(`migrate ${sandboxId}: source box has no ~/workspace to carry (old box intact); aborting`)
      return terminal({ moved: false, reason: 'archive-failed' })
    }

    // 7. Provision the box on the TARGET machine, WITHOUT repointing the row.
    // The caller env is carried over from the old box's server.env (the full
    // BoxEnv the vm manager assembled at its last ensure — secrets, git
    // identity, sandbox ids), minus the machine-derived vars install re-bakes.
    // The token is the row's persisted one (COALESCE-stable across the final
    // repoint), so the new unit and the row can never disagree; a legacy
    // token-less row gets one minted HERE and passed as the bind candidate.
    const authToken = box.authToken ?? randomBytes(32).toString('hex')
    // `undefined` until peeked: the provision-failure teardown below must know
    // whether anything could have landed on the target at all.
    let port: number | undefined
    progress('provision')
    try {
      const envRes = await runner.run(oldMachine, `sudo cat ${shellQuote(`${home}/.tau/server.env`)}`)
      if (envRes.exitCode !== 0) {
        throw new Error(`server.env read failed (exit ${envRes.exitCode}): ${envRes.stderr.trim()}`)
      }
      const callerEnv = parseServerEnv(envRes.stdout)
      for (const key of DERIVED_ENV_KEYS) delete callerEnv[key]
      // FICUS_API_URL is machine-specific: the reverse tunnel is the default
      // box→core path, so it's a reverse SSH forward on the OLD machine's
      // control connection — carried verbatim it would point the new box's
      // callbacks at a port that only exists on the machine it just left. And
      // since a healthy migrated box takes ensureBox's fast-path (which never
      // re-pushes env), it would stay broken indefinitely. ALWAYS re-resolve
      // against the TARGET machine (even a public-looking carried URL is just
      // the old ensure's degraded fallback, superseded by a fresh resolution).
      callerEnv.FICUS_API_URL = await resolveApiUrl(target)

      await ensureArtifacts(target)
      // Peek (not reserve — the row still points at the old machine) the port
      // the target-side bind would allocate. The final bind passes it back
      // explicitly; the (machine_id, port) unique constraint catches a
      // concurrent bind that took it meanwhile.
      port = await peekPort(targetMachineId)
      await install({ machine: target, sandboxId, unixUser, port, role, env: callerEnv, authToken }, deps)
    } catch (err) {
      log.warn(`migrate ${sandboxId}: provision on ${targetMachineId} failed (old box intact): ${String(err)}`)
      // Symmetry with the restore/health/repoint failure paths: install can die
      // halfway (user created, unit half-written), so sweep the target rather
      // than strand a partial unix user there on every failed migrate. Safe
      // no-op when install failed before the user existed (box-provision.sh
      // --remove no-ops on an absent user); skipped entirely when nothing was
      // even peeked (env read / bundle / peek failures touch the target not at
      // all).
      if (port !== undefined) await teardownNewBox(port)
      return terminal({ moved: false, reason: 'provision-failed' })
    }

    // 7.5. BASELINE the just-provisioned destination: every state dir must
    // exist and be EMPTY. box-provision's ensure_dirs creates them empty, and
    // nothing has yet written into ~/workspace or ~/.private — NOT because
    // assets avoid those dirs (two of them land squarely inside: the squad
    // `.env` at ~/workspace/.ficus/.env and the identity key at
    // ~/.private/identity.pem — see vm/file-sync.ts's push order) but because
    // asset delivery goes through the BOX SERVER's HTTP API, and this box's
    // unit has only been `enable`d, never started (box-provision.sh starts
    // nothing; step 9 below is its first activation). migrate does not call
    // syncBoxFiles at all. So anything present here means the target already
    // carries a tree from an earlier attempt whose best-effort teardown failed.
    // A maintainer moving asset delivery earlier — or before the stream —
    // breaks this, and would have to move the baseline with it.
    //
    // This is what keeps step 8.5's UPPER bound meaningful rather than blind to
    // exactly that stale tree: a later attempt whose transfer silently omitted
    // ~/workspace would pass a bare `>=` against the stale SUPERSET, repoint the
    // row, and tear down the last real copy. Refusing an unverifiable or dirty
    // destination costs one retry (the teardowns above are budgeted to actually
    // clear it — see sizeBudgetMs); the alternative cost a squad's work.
    try {
      const baseline = await measureStateDirs(runner, target, sandboxId, home, stateDirs)
      const check = checkDestinationBaseline(baseline, { stateDirs })
      if (!check.ok) throw new Error(check.reason)
    } catch (err) {
      log.warn(
        `migrate ${sandboxId}: destination box on ${targetMachineId} is not a clean, measurable ` +
          `target (old box intact, nothing streamed): ${String(err)}`
      )
      await teardownNewBox(port)
      return terminal({ moved: false, reason: 'restore-failed' })
    }

    // 8. STREAM the state onto the new box BEFORE its unit ever starts (a
    // running box user could swap a restored dir for a symlink and race the
    // restore's chmod). The source's `tar c` is piped straight into the
    // destination's `box-provision.sh --restore-stream`, which extracts from
    // stdin into per-operation staging (~/.tau-migrate/<operationId>) and
    // re-owns/locks the members (workspace 0755, private 0700) with the SAME
    // helper the file-restore path uses. No archive is buffered on core or
    // written as a file on either machine; the staged tree lives on the
    // destination's home filesystem only until step 8.5 verifies it against the
    // manifest and promotes it into place (an mv/rename within that same
    // filesystem, so no second full copy).
    //
    // Fail-closed: the transport requires the source's exit status, the
    // destination's exit status, AND a non-zero byte count to all agree (see
    // streamBoxStateArchive). Which END failed picks the reason, preserving the
    // "old machine unreadable" vs "target write failed" distinction. On any
    // failure the new box is torn down and the old box is untouched.
    progress('restore')
    try {
      const { bytes } = await streamStateArchive(
        {
          sandboxId,
          source: { machine: oldMachine, home },
          dest: { machine: target, unixUser, stagingId: operationId },
          stateDirs,
          codec,
          timeoutMs: sizeBudgetMs,
        },
        deps
      )
      log.info(
        `migrate ${sandboxId}: streamed ${bytes} bytes (${codec}, dirs ${stateDirs.join(',')}) ` +
          `${box.machineId} → ${targetMachineId}`
      )
    } catch (err) {
      // 'archive-failed' renders to an operator as "old machine unreadable", so
      // it is claimed ONLY when the transport is sure: an `ambiguous` error
      // means both ends exited non-zero and the source-first attribution is a
      // GUESS, which must not be spent naming a machine. Both branches behave
      // identically here (new box torn down, old box authoritative), so the
      // ambiguous case simply takes the destination-side reason. The log below
      // still carries the error's full both-ends detail (see
      // BoxArchiveStreamError), which is where the real diagnosis lives.
      const sourceEnd = err instanceof BoxArchiveStreamError && err.end === 'source' && !err.ambiguous
      log.warn(
        `migrate ${sandboxId}: state transfer to ${targetMachineId} failed, attributed to the ` +
          `${err instanceof BoxArchiveStreamError ? err.end : 'unknown'} end (old box intact): ${String(err)}`
      )
      await teardownNewBox(port)
      return terminal({ moved: false, reason: sourceEnd ? 'archive-failed' : 'restore-failed' })
    }

    // 8.5. Verify the OUTCOME on the destination, while the old box is still
    // the surviving authoritative copy. This replaces the pre-streaming check
    // that inspected the pulled archive at rest, and is strictly stronger: it
    // asserts what the target box ACTUALLY ended up with (every state dir
    // present, holding what the source held, owned by the box user with the
    // mode the restore promises) rather than what the transport claimed. An
    // unverifiable destination is treated exactly like a failed one — "we could
    // not check" is never "it is fine".
    //
    // The source is RE-MEASURED here, and the destination is accepted anywhere
    // in [min, max] of the two readings. Step 6's reading was taken before
    // ensureMachineArtifacts (up to 2 min PER FILE) and installBoxOnMachine (a
    // minute+), and the source box is live throughout: a background build or a
    // dev server an agent left running can add a top-level entry in that
    // window, and comparing against the stale reading alone would abort AFTER
    // the entire multi-GB stream had been paid for. A genuine ceiling is still
    // enforced, just against a reading taken on the same side of the transfer.
    // The re-probe must be a REAL probe — synthesising it from the first would
    // reinstate exactly the staleness it exists to remove — and a re-probe that
    // FAILS leaves the comparison with no trustworthy bound, so it fails closed
    // like any other unverifiable outcome (one retry, old box intact).
    try {
      const sourceFactsAfter = await measureStateDirs(runner, oldMachine, sandboxId, home, stateDirs)
      const destFacts = await measureStateDirs(runner, target, sandboxId, home, stateDirs)
      const verification = compareStateDirFacts([sourceFacts, sourceFactsAfter], destFacts, { unixUser, stateDirs })
      if (!verification.ok) throw new Error(verification.reason)
      const sourceManifestAfter = await scanManifest(runner, oldMachine, home, unixUser, manifestIdentity)
      if (sourceManifestAfter.manifestSha256 !== sourceManifest.manifestSha256)
        throw Object.assign(new Error('source-changed'), { migrationReason: 'source-changed' as const })
      const targetEvidence = JSON.stringify(sourceManifest)
      const evidenceResult = await runner.run(
        target,
        `sudo install -d -m 0700 /opt/tau/migrations/${manifestIdentity.operationId} && sudo install -m 0600 -o root -g root /dev/stdin /opt/tau/migrations/${manifestIdentity.operationId}/${unixUser}.manifest.json`,
        { stdin: targetEvidence }
      )
      if (evidenceResult.exitCode !== 0) throw new Error('transfer-incomplete')
      const stagingHome = `${home}/.tau-migrate/${operationId}`
      const stagedManifest = await scanManifest(runner, target, stagingHome, unixUser, manifestIdentity)
      const stagedVerification = compareMigrationManifests(sourceManifest, stagedManifest)
      if (!stagedVerification.ok)
        throw Object.assign(new Error(stagedVerification.type), {
          migrationReason: stagedVerification.type,
          lossReport: stagedVerification,
        })
      const promote = await runner.run(
        target,
        `set -e; for root in workspace .private; do sudo rm -rf -- ${home}/$root.next; if sudo test -e ${stagingHome}/$root; then sudo mv -- ${stagingHome}/$root ${home}/$root.next; sudo rmdir -- ${home}/$root; sudo mv -T -- ${home}/$root.next ${home}/$root; else sudo rm -rf -- ${home}/$root; fi; done; sudo rm -rf -- ${stagingHome}`
      )
      if (promote.exitCode !== 0) throw new Error('transfer-incomplete')
      const targetManifest = await scanManifest(runner, target, home, unixUser, manifestIdentity)
      const manifestVerification = compareMigrationManifests(sourceManifest, targetManifest)
      if (!manifestVerification.ok)
        throw Object.assign(new Error(manifestVerification.type), {
          migrationReason: manifestVerification.type,
          lossReport: manifestVerification,
        })
    } catch (err) {
      log.warn(
        `migrate ${sandboxId}: restored state on ${targetMachineId} failed verification ` +
          `(old box intact, migration abandoned): ${String(err)}`
      )
      await teardownNewBox(port)
      const typedReason =
        err && typeof err === 'object' && 'migrationReason' in err
          ? (err.migrationReason as MigrateReason)
          : 'restore-failed'
      const mismatch =
        err && typeof err === 'object' && 'lossReport' in err
          ? (err.lossReport as { type: MigrateReason; root?: 'workspace' | '.private'; pathB64?: string })
          : undefined
      const lossReport = mismatch
        ? {
            type: mismatch.type,
            ...(mismatch.root ? { root: mismatch.root } : {}),
            ...(mismatch.pathB64 ? { pathB64: mismatch.pathB64 } : {}),
          }
        : undefined
      return terminal({ moved: false, reason: typedReason, ...(lossReport ? { lossReport } : {}) })
    }

    // 9. First start + health. /healthz is deliberately auth-exempt, so follow
    // it with a token-authenticated probe (GET /watch — trivial, side-effect
    // free): the new box must prove it serves THE token the row will carry
    // before the old box is destroyed.
    progress('health')
    try {
      const endpoint = await start({ machine: target, sandboxId, unixUser, port }, deps)
      const probe = await fetchFn(`${endpoint}/watch`, {
        method: 'GET',
        headers: { authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
      })
      if (!probe.ok) {
        throw new Error(`token-auth probe failed (status ${probe.status})`)
      }
    } catch (err) {
      log.warn(`migrate ${sandboxId}: new box on ${targetMachineId} unhealthy (old box intact): ${String(err)}`)
      await teardownNewBox(port)
      return terminal({ moved: false, reason: 'unhealthy' })
    }

    // 10. Repoint the row to the target (explicit provisioned port; candidate
    // token for a legacy row — COALESCE keeps a persisted one, which equals
    // ours). This also clears the target's drain marker under the bind lock.
    // The row — and its migrating fence — exists at every instant; see the
    // module doc for why this precedes the old teardown.
    //
    // The bind is CONDITIONAL (compare-and-swap on the fenced re-read's
    // pre-state): if a concurrent ensure/bind touched the row in the provision
    // window — repointed it, changed its port, or minted a token the new unit
    // would reject (a permanently wedged 401 box; /healthz is auth-exempt, so
    // it never self-heals) — the bind THROWS INSIDE its transaction and rolls
    // back. The row then genuinely still points at the OLD machine, so tearing
    // down the NEW box is safe (a post-commit verify-then-teardown here once
    // destroyed the box the committed row pointed at: the next ensure would
    // provision an EMPTY ~/.private — file loss).
    progress('repoint')
    // Publish the immutable proof before changing the authoritative row. A
    // proof failure is therefore still a pre-commit failure and the target may
    // safely be removed.
    try {
      const finalSourceManifest = await scanManifest(runner, oldMachine, home, unixUser, manifestIdentity)
      if (finalSourceManifest.manifestSha256 !== sourceManifest.manifestSha256)
        throw Object.assign(new Error('source-changed'), { migrationReason: 'source-changed' as const })
      await recordProof({
        evacuationId: operationId,
        sandboxId,
        manifestDigest: sourceManifest.manifestSha256,
        files: sourceManifest.totals.files,
        bytes: sourceManifest.totals.bytes,
      })
    } catch (err) {
      await teardownNewBox(port)
      const reason =
        err && typeof err === 'object' && 'migrationReason' in err
          ? (err.migrationReason as MigrateReason)
          : 'repoint-conflict'
      return terminal({ moved: false, reason })
    }

    try {
      await bind({
        sandboxId,
        machineId: targetMachineId,
        unixUser,
        port,
        authToken,
        expected: { fromMachineId: box.machineId, port: box.port, authToken: box.authToken },
        ...(forceAuditId
          ? {
              onBound: async (tx: import('./queries').DbTransaction) => {
                requireForceMigrationSettlement(
                  await finishForceMigrationAuditInTransaction(tx, forceAuditId!, { moved: true })
                )
                atomicAuditCallbackRan = true
              },
            }
          : {}),
      })
      if (atomicAuditCallbackRan) forceAuditSettled = true
      // The row now names the healthy target. Set this before any fallible
      // settlement so cleanup can never restart writers or destroy/retry the
      // authoritative target as though bind had rolled back.
      migrationSucceeded = true
    } catch (err) {
      log.warn(`migrate ${sandboxId}: row repoint to ${targetMachineId} rolled back: ${String(err)}`)
      await teardownNewBox(port)
      return terminal({ moved: false, reason: 'repoint-conflict' })
    }

    // From here onward the target is authoritative. Never tear it down if a
    // post-commit settlement fails; retain the source and report a successful
    // move so callers cannot retry as though the row still pointed at source.
    if (!opts.evacuationId) {
      try {
        await verifyEvacuation(operationId, { requireSourceUsersAbsent: false })
      } catch (err) {
        await failEvacuation(operationId)
        log.warn(`migrate ${sandboxId}: post-repoint proof settlement failed; source retained: ${String(err)}`)
        migrationSucceeded = true
        return terminal({ moved: true })
      }
    }

    // Old-box teardown, best-effort: the move ALREADY succeeded (new box
    // healthy, row repointed). Failure leaves machine-side remnants on the old
    // machine (logged; same posture as ensureBox's pin-move migrate). The row
    // must NOT be deleted — hence teardownBoxOnMachine, never removeBox. The
    // state was streamed onto the target (step 8) and its arrival VERIFIED
    // there (step 8.5) before this point, so pulling a second copy to core here
    // would buy nothing; --remove's machine-side whole-home archive is the
    // remaining belt-and-braces, so archivePrivate is deliberately false.
    progress('teardown')
    try {
      await teardown(oldMachine, sandboxId, unixUser, box.port, { timeoutMs: sizeBudgetMs }, deps)
    } catch (err) {
      log.warn(
        `migrate ${sandboxId}: teardown of the old box on ${box.machineId} failed after a successful move ` +
          `(box-side remnants are not reclaimed — see runtime.md Backlog): ${
            err instanceof Error ? err.message : String(err)
          }`
      )
    }

    // Announce the OLD box's departure over the DISTRIBUTED event emitter
    // (same shape as removeBox's emit): the migrate ran in THIS (API) process,
    // so only this process's tunnel forward was dropped by the teardown — the
    // WORKER still caches a SandboxClient + forward for the old (machine,
    // port), which VmSandboxManager.onBoxStatus drops on exactly this event.
    // Without it the stale forward lingers until the box's next ensure (first
    // use fails once, then heals). Emitted even when the old teardown itself
    // failed above: the row no longer points there, so no process may keep
    // using that endpoint.
    eventEmitter.emit('box.status', { sandboxId, machineId: box.machineId, status: 'gone', port: box.port })

    // 10.5. Restart the squad box's managed/restartable local deployments on the
    // TARGET (the row now points there, so ensure resolves to the new box). The
    // move ALREADY succeeded — a restart failure is the user's to retry, never a
    // migration failure — so this is best-effort (WARN only). Skipped for
    // agent/system-manager boxes (no local deployments).
    if (role === 'squad') {
      progress('restart-deployments')
      try {
        await restartDeployments(sandboxId)
      } catch (err) {
        log.warn(
          `migrate ${sandboxId}: local-deployment restart on ${targetMachineId} failed after a successful move ` +
            `(user-restartable; the move stands): ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    log.info(`migrate ${sandboxId}: moved ${box.machineId} → ${targetMachineId} (port ${port})`)
    return terminal({
      moved: true,
      ...(opts.evacuationId
        ? {
            migrationProof: {
              manifestDigest: sourceManifest.manifestSha256,
              files: sourceManifest.totals.files,
              bytes: sourceManifest.totals.bytes,
            },
          }
        : {}),
    })
  } catch (error) {
    primaryError = error
    migrationCanceled = isMigrationCancellation(error)
    terminalResult ??= { moved: false, reason: 'failed' }
    throw error
  } finally {
    let restartSourceError: unknown
    if (sourceUnitStopped && !migrationSucceeded) {
      try {
        const ctl = boxUnitControl({ sandboxId, unixUser })
        // Socket first (quiesce took it down with the rest), then the server —
        // same shape, and the same missing-socket tolerance for a box that has
        // not been re-provisioned since the socket layout landed, as
        // box-manager's startBoxAndAwaitHealth.
        const result = await runner.run(
          oldMachine,
          `${ctl.systemctl} start ${ctl.socket} 2>/dev/null || true; ${ctl.systemctl} restart ${ctl.unit}`
        )
        if (result.exitCode !== 0) restartSourceError = new Error(`source box restart failed: ${result.stderr.trim()}`)
      } catch (error) {
        restartSourceError = error
      }
    }
    let clearError: unknown
    try {
      await clearFence(sandboxId)
    } catch (error) {
      clearError = error
    } finally {
      let auditError: unknown
      if (forceAuditId && !forceAuditSettled) {
        const result = terminalResult ?? (migrationSucceeded ? { moved: true } : { moved: false, reason: 'failed' })
        try {
          requireForceMigrationSettlement(
            await finishForceAudit(
              forceAuditId,
              migrationSucceeded ? 'succeeded' : migrationCanceled ? 'canceled' : 'failed',
              result,
              migrationSucceeded ? undefined : migrationCanceled ? 'canceled' : (result.reason ?? 'migration-failed')
            )
          )
        } catch (error) {
          auditError = error
        }
      }
      let evacuationError: unknown
      if (!migrationSucceeded) {
        try {
          await failEvacuation(operationId)
        } catch (error) {
          evacuationError = error
        }
      }
      const errors = [primaryError, restartSourceError, clearError, auditError, evacuationError].filter(
        (error) => error !== undefined
      )
      // Cleanup failures must surface even though this code runs in finally.
      // eslint-disable-next-line no-unsafe-finally
      if (errors.length > 1) throw new AggregateError(errors, 'Migration cleanup and audit settlement failed')
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && restartSourceError) throw restartSourceError
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && auditError) throw auditError
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && clearError) throw clearError
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && evacuationError) throw evacuationError
    }
  }
}
