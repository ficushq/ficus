import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, executionAdmissionReservations, executions, instanceMaintenanceState, messages } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { DbTransaction } from '../machines/queries'
import { ADMISSION_LIVENESS_HASH_SEED, ADMISSION_LIVENESS_LOCK_VERSION } from './process-liveness'
import { restoreQueueOwnedAdmission, restoreStrandedQueuedAdmission } from '../execution/agent-admission'
import { databaseClockNow } from '../../db/clock'

const log = createLogger('admission-reservation')

/** How often an open admission phase renews its 30s lease. */
export const ADMISSION_HEARTBEAT_INTERVAL_MS = 10_000
let heartbeatIntervalOverrideMs: number | undefined
/** Test hook: shrink the default heartbeat interval so runner-level tests can observe renewals. */
export function setAdmissionHeartbeatIntervalForTests(ms?: number): void {
  heartbeatIntervalOverrideMs = ms
}

export type AdmissionWritePhase =
  | 'sandbox-drift-recreate'
  | 'sandbox-ensure'
  | 'toolchain-reconcile'
  | 'workspace-watch-configure'
  | 'local-deployment-restart'
  | 'session-create'
  | 'agent-session'
  | 'sandbox-recovery'
  | 'settlement'

export interface AdmissionLease {
  executionId: string
  token: string
  claimEpoch: bigint
  generation: number
  holderRevision: bigint
  ownerId: string
  ownerIncarnation: string
}

type AdmissionReservation = typeof executionAdmissionReservations.$inferSelect
type LeaseBearingReservation = AdmissionReservation & {
  token: string
  claimEpoch: bigint
  ownerId: string
  ownerIncarnation: string
  admittedGeneration: number
  admittedHolderRevision: bigint
  leaseExpiresAt: Date
  lastHeartbeatAt: Date
}

export function isLeaseBearingReservation(row: AdmissionReservation): row is LeaseBearingReservation {
  return (
    !['queued', 'waiting-maintenance'].includes(row.state) &&
    row.token !== null &&
    row.claimEpoch !== null &&
    row.ownerId !== null &&
    row.ownerIncarnation !== null &&
    row.admittedGeneration !== null &&
    row.admittedHolderRevision !== null &&
    row.leaseExpiresAt !== null &&
    row.lastHeartbeatAt !== null
  )
}

function exactLeasePredicates(lease: AdmissionLease) {
  return [
    eq(executionAdmissionReservations.executionId, lease.executionId),
    eq(executionAdmissionReservations.token, lease.token),
    eq(executionAdmissionReservations.claimEpoch, lease.claimEpoch),
    eq(executionAdmissionReservations.ownerId, lease.ownerId),
    eq(executionAdmissionReservations.ownerIncarnation, lease.ownerIncarnation),
    eq(executionAdmissionReservations.admittedGeneration, lease.generation),
    eq(executionAdmissionReservations.admittedHolderRevision, lease.holderRevision),
  ]
}

export async function settleExactAdmissionLease(
  tx: DbTransaction,
  lease: AdmissionLease,
  state: 'released' | 'revoked'
): Promise<boolean> {
  const [updated] = await tx
    .update(executionAdmissionReservations)
    .set({
      state,
      phase: 'none',
      operationId: null,
      resourceKey: null,
      updatedAt: new Date(),
    })
    .where(
      and(...exactLeasePredicates(lease), sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`)
    )
    .returning({ executionId: executionAdmissionReservations.executionId })
  return !!updated
}

const admissionLeaseErrors = new WeakMap<Error, AdmissionLease>()

/** Normalize arbitrary JavaScript throws into a lease-carrying Error. */
export function attachAdmissionLeaseToError(error: unknown, lease: AdmissionLease): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error })
  admissionLeaseErrors.set(normalized, lease)
  return normalized
}

export function admissionLeaseFromError(error: unknown): AdmissionLease | undefined {
  return error instanceof Error ? admissionLeaseErrors.get(error) : undefined
}

const admissionEffectPhases = new WeakMap<Error, AdmissionWritePhase>()

/**
 * Record which admission effect phase an operation failed inside, so failure
 * sites classify structurally (see services/execution/failure-classification)
 * instead of parsing error prose.
 */
export function attachAdmissionEffectPhase(error: unknown, phase: AdmissionWritePhase): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error })
  admissionEffectPhases.set(normalized, phase)
  return normalized
}

export function admissionEffectPhaseFromError(error: unknown): AdmissionWritePhase | undefined {
  return error instanceof Error ? admissionEffectPhases.get(error) : undefined
}

export async function isExactAdmissionLeaseTerminal(tx: DbTransaction, lease: AdmissionLease): Promise<boolean> {
  const [row] = await tx
    .select({ executionId: executionAdmissionReservations.executionId })
    .from(executionAdmissionReservations)
    .where(and(...exactLeasePredicates(lease), inArray(executionAdmissionReservations.state, ['released', 'revoked'])))
  return !!row
}

export interface AdmissionEffectSpec {
  phase: AdmissionWritePhase
  resourceKey: string
  successState?: 'requested' | 'running'
}

/**
 * Why a heartbeat did or did not renew. `retryable` outcomes are transient
 * (retry next tick); the rest are definitive fence loss for this phase.
 */
export type AdmissionHeartbeatOutcome =
  | { ok: true; repaired: boolean }
  | { ok: false; retryable: true; reason: 'maintenance-missing' }
  | {
      ok: false
      retryable: false
      reason:
        'fence-revoked' | 'reservation-missing' | 'identity-mismatch' | 'phase-superseded' | 'reservation-not-live'
    }

/**
 * Why beginWritePhase refused: the maintenance fence is closed (park), the
 * caller no longer holds this lease (someone else owns/settled the row), or
 * the row is held but not in the state/phase the caller expected.
 */
export type AdmissionPhaseRefusal = 'fence-closed' | 'lease-lost' | 'phase-conflict'

/**
 * The runner's exact lease no longer authorizes a phase and the maintenance
 * fence is NOT what refused it: the row was settled, taken over, or is in a
 * state this owner cannot repair. Distinct from MaintenanceAdmissionPaused so
 * callers fail the execution durably instead of parking it (parking is a no-op
 * when maintenance is not effective, which left rows `running` and unheld).
 */
export class AdmissionLeaseLostError extends Error {
  constructor(
    readonly executionId: string,
    readonly phase: AdmissionWritePhase,
    readonly refusal: AdmissionPhaseRefusal | 'finish-refused'
  ) {
    super(`Admission lease for execution ${executionId} no longer authorizes phase ${phase} (${refusal})`)
    this.name = 'AdmissionLeaseLostError'
  }
}

export class LiveAdmissionOwnerConflictError extends Error {
  constructor(executionId: string) {
    super(`Execution ${executionId} has an admission reservation owned by another live process`)
    this.name = 'LiveAdmissionOwnerConflictError'
  }
}

export async function replaceAdmissionReservationForPickup(
  tx: DbTransaction,
  input: {
    executionId: string
    agentId: string
    token: string
    ownerId: string
    ownerIncarnation: string
    generation: number
    holderRevision: bigint
  }
): Promise<AdmissionLease> {
  const [existing] = await tx
    .select()
    .from(executionAdmissionReservations)
    .where(eq(executionAdmissionReservations.executionId, input.executionId))
    .for('update')

  if (existing && !['queued', 'waiting-maintenance', 'released', 'revoked'].includes(existing.state)) {
    if (existing.ownerIncarnation !== input.ownerIncarnation) {
      const [proof] = await tx
        .select({
          dead: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${existing.ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`,
        })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!proof?.dead) throw new LiveAdmissionOwnerConflictError(input.executionId)
    }
  }

  const [clock] = await tx
    .select({ now: sql<Date>`clock_timestamp()` })
    .from(instanceMaintenanceState)
    .where(eq(instanceMaintenanceState.id, 'global'))
  const now = new Date(clock!.now)
  const values = {
    agentId: input.agentId,
    token: input.token,
    claimEpoch: (existing?.claimEpoch ?? 0n) + 1n,
    ownerId: input.ownerId,
    ownerIncarnation: input.ownerIncarnation,
    admittedGeneration: input.generation,
    admittedHolderRevision: input.holderRevision,
    state: 'provisional',
    phase: 'none',
    phaseSequence: 0,
    operationId: null,
    resourceKey: null,
    revokeGeneration: null,
    revokeHolderRevision: null,
    revokeAdminHold: null,
    revokeLeaseId: null,
    revokeLeaseOwnerTokenId: null,
    revokeRequestedAt: null,
    recoveryOwnerId: null,
    recoveryOwnerIncarnation: null,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    lastHeartbeatAt: now,
    updatedAt: now,
  }
  await tx
    .insert(executionAdmissionReservations)
    .values({ executionId: input.executionId, ...values })
    .onConflictDoUpdate({ target: executionAdmissionReservations.executionId, set: values })
  return {
    executionId: input.executionId,
    token: input.token,
    claimEpoch: values.claimEpoch,
    generation: input.generation,
    holderRevision: input.holderRevision,
    ownerId: input.ownerId,
    ownerIncarnation: input.ownerIncarnation,
  }
}

export interface AdmissionEffectContext {
  operationId: string
  signal: AbortSignal
  phaseSequence: number
}

export class NestedAdmissionEffectError extends Error {
  constructor() {
    super('Admission effects cannot be nested or run concurrently')
    this.name = 'NestedAdmissionEffectError'
  }
}

/**
 * The durable fence refused to begin an admission effect phase for this
 * execution. Same message as the plain `Error` it replaces so existing
 * INTERNAL_EXECUTION_ERROR_MARKERS matching and log greps are unchanged — but
 * typed, carrying the refused phase and refusal reason structurally so the
 * failure site can classify the execution without prose matching.
 */
export class AdmissionEffectRefusedError extends Error {
  constructor(
    readonly executionId: string,
    readonly phase: AdmissionWritePhase,
    readonly refusal: AdmissionPhaseRefusal | 'fence-refused'
  ) {
    super('Admission effect was refused by the durable fence')
    this.name = 'AdmissionEffectRefusedError'
  }
}

export interface AdmissionScopeOptions {
  /** Interval the default scheduler ticks at; also sizes the stall budget (2x). */
  heartbeatIntervalMs?: number
  /** Monotonic clock used to detect a stalled heartbeat (tests inject a fake). */
  now?: () => number
}

type OpenPhase = { phase: string; phaseSequence: number; operationId: string | null; resourceKey: string | null }

export class AdmissionScope {
  private readonly controller = new AbortController()
  private effectOpen = false
  private readonly heartbeatIntervalMs: number
  private readonly now: () => number
  private readonly scheduleHeartbeat: (callback: () => void) => () => void

  constructor(
    private readonly store: AdmissionReservationStore,
    private readonly lease: AdmissionLease,
    scheduleHeartbeat?: (callback: () => void) => () => void,
    options: AdmissionScopeOptions = {}
  ) {
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? heartbeatIntervalOverrideMs ?? ADMISSION_HEARTBEAT_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    this.scheduleHeartbeat =
      scheduleHeartbeat ??
      ((callback) => {
        const timer = setInterval(callback, this.heartbeatIntervalMs)
        timer.unref?.()
        return () => clearInterval(timer)
      })
  }

  /**
   * Renew the open phase's lease every interval until `stop` is called.
   *
   * Only a definitive fence loss aborts the scope: the maintenance fence moved
   * on, or the reservation row is gone/foreign/superseded/no longer live. A DB
   * error, or a heartbeat that could not even read the maintenance singleton,
   * is logged and retried on the next tick — a transient outage must never
   * permanently stop renewals (which would let the row lapse to `unknown` and
   * later refuse this live owner's own settlement). A row that already lapsed
   * to `unknown` is repaired by the store when the exact identity still matches.
   *
   * A heartbeat stalled beyond two intervals no longer blocks the next tick;
   * concurrent renewals are idempotent. Outcomes arriving after `stop` are
   * ignored so a late no-row heartbeat cannot poison the next phase.
   */
  private startHeartbeat(phase: OpenPhase): { stop: () => Promise<void> } {
    const inflight = new Set<Promise<void>>()
    let inflightSince: number | null = null
    let closed = false
    const label = `execution ${this.lease.executionId} phase ${phase.phase}#${phase.phaseSequence}`
    const tick = () => {
      if (closed || this.controller.signal.aborted) return
      if (inflight.size > 0) {
        const stalledFor = this.now() - (inflightSince ?? this.now())
        if (stalledFor < this.heartbeatIntervalMs * 2) return
        log.warn(`Admission heartbeat for ${label} still pending after ${stalledFor}ms; starting another renewal`)
      }
      inflightSince = this.now()
      const run = (async () => {
        try {
          const outcome = await this.store.heartbeatEffect(this.lease, phase)
          if (closed) return
          if (outcome.ok) {
            if (outcome.repaired) log.warn(`Admission heartbeat for ${label} repaired a lapsed (unknown) reservation`)
            return
          }
          if (outcome.retryable) {
            log.warn(`Admission heartbeat for ${label} could not renew (${outcome.reason}); retrying next tick`)
            return
          }
          log.warn(`Admission heartbeat for ${label} lost its fence (${outcome.reason}); aborting the effect`)
          this.controller.abort(new Error(`Admission effect fence was revoked (${outcome.reason})`))
        } catch (error) {
          if (closed) return
          log.warn(
            `Admission heartbeat for ${label} failed (${error instanceof Error ? error.message : String(error)}); retrying next tick`
          )
        }
      })()
      inflight.add(run)
      void run.finally(() => {
        inflight.delete(run)
        if (inflight.size === 0) inflightSince = null
      })
      return run
    }
    const cancel = this.scheduleHeartbeat(tick)
    return {
      stop: async () => {
        closed = true
        cancel()
        // Join heartbeats that began before the phase settled so a renewal
        // cannot land after finish and so callers observe a quiet scope.
        await Promise.all([...inflight])
      },
    }
  }

  /**
   * Keep an already-open phase (begun by the caller through the store) renewed
   * while `operation` runs. Used by the runner for the agent-session phase,
   * which spans the whole model turn and is not an external-resource effect.
   */
  async heartbeatWhile<T>(phase: OpenPhase, operation: () => Promise<T>): Promise<T> {
    const heartbeat = this.startHeartbeat(phase)
    try {
      return await operation()
    } finally {
      await heartbeat.stop()
    }
  }

  async runEffect<T>(
    spec: AdmissionEffectSpec,
    operation: (context: AdmissionEffectContext) => Promise<T>,
    cleanup?: (value: T) => Promise<void> | void
  ): Promise<T> {
    if (this.effectOpen) throw new NestedAdmissionEffectError()
    this.effectOpen = true
    try {
      const { phase, refusal } = await this.store.beginWritePhaseDetailed(this.lease, spec.phase, spec.resourceKey)
      if (!phase) throw new AdmissionEffectRefusedError(this.lease.executionId, spec.phase, refusal ?? 'fence-refused')
      let value: T
      const heartbeat = this.startHeartbeat(phase)
      try {
        value = await operation({
          operationId: phase.operationId!,
          signal: this.controller.signal,
          phaseSequence: phase.phaseSequence,
        })
      } catch (operationError) {
        // Quiesce the heartbeat before restoring `requested`, so a renewal
        // landing after the restore cannot read the closed phase as fence loss.
        await heartbeat.stop()
        try {
          await this.store.finishWritePhase(this.lease, phase, 'requested')
        } catch {
          // Preserve the original adapter failure; recovery classifies the open phase.
        }
        // Carry the phase structurally so the failure site can classify a
        // platform-infrastructure refusal without prose matching.
        throw attachAdmissionEffectPhase(operationError, spec.phase)
      } finally {
        await heartbeat.stop()
      }
      let finished: boolean
      try {
        finished = await this.store.finishWritePhase(this.lease, phase, spec.successState ?? 'requested')
      } catch (finishError) {
        try {
          await cleanup?.(value)
        } catch (cleanupError) {
          throw new AggregateError([finishError, cleanupError], 'Admission effect finish and cleanup both failed')
        }
        throw finishError
      }
      if (!finished) {
        try {
          await cleanup?.(value)
        } catch (cleanupError) {
          throw new AggregateError(
            [new Error('Admission effect was revoked or superseded'), cleanupError],
            'Admission effect revocation cleanup failed'
          )
        }
        throw new Error('Admission effect was revoked or superseded')
      }
      return value
    } finally {
      this.effectOpen = false
    }
  }

  abort(reason?: Error): void {
    this.controller.abort(reason)
  }

  async close(): Promise<void> {
    if (this.effectOpen) throw new NestedAdmissionEffectError()
  }
}

export class AdmissionReservationStore {
  constructor(
    private readonly ownerId: string,
    private readonly ownerIncarnation: string
  ) {}

  async revokeProvisionalClaim(executionId: string, token: string, generation: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, executionId))
        .for('update')
      if (
        !row ||
        !isLeaseBearingReservation(row) ||
        row.state !== 'provisional' ||
        row.phase !== 'none' ||
        row.token !== token ||
        row.admittedGeneration !== generation ||
        row.ownerId !== this.ownerId ||
        row.ownerIncarnation !== this.ownerIncarnation
      )
        return false
      return settleExactAdmissionLease(
        tx,
        {
          executionId,
          token,
          claimEpoch: row.claimEpoch,
          generation,
          holderRevision: row.admittedHolderRevision,
          ownerId: row.ownerId,
          ownerIncarnation: row.ownerIncarnation,
        },
        'revoked'
      )
    })
  }

  async revokeLease(lease: AdmissionLease, tx?: DbTransaction): Promise<boolean> {
    if (tx) return settleExactAdmissionLease(tx, lease, 'revoked')
    return db.transaction((transaction) => settleExactAdmissionLease(transaction, lease, 'revoked'))
  }

  async releaseLease(lease: AdmissionLease, tx?: DbTransaction): Promise<boolean> {
    if (tx) return settleExactAdmissionLease(tx, lease, 'released')
    return db.transaction((transaction) => settleExactAdmissionLease(transaction, lease, 'released'))
  }

  async createProvisional(executionId: string): Promise<AdmissionLease> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!maintenance) throw new Error('Instance maintenance singleton is not initialized')
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const leaseActive =
        maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > new Date(clock!.now)
      if (maintenance.adminHold || leaseActive) throw new Error('Maintenance admission is closed')
      const [existing] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, executionId))
        .for('update')
      if (existing && !['queued', 'waiting-maintenance', 'released', 'revoked'].includes(existing.state))
        throw new Error('Execution already has an active admission reservation')
      const token = crypto.randomUUID()
      const claimEpoch = (existing?.claimEpoch ?? 0n) + 1n
      const values = {
        executionId,
        token,
        claimEpoch,
        ownerId: this.ownerId,
        ownerIncarnation: this.ownerIncarnation,
        admittedGeneration: maintenance.generation,
        admittedHolderRevision: maintenance.holderRevision,
        state: 'provisional',
        phase: 'none',
        leaseExpiresAt: new Date(new Date(clock!.now).getTime() + 30_000),
        lastHeartbeatAt: new Date(clock!.now),
        updatedAt: new Date(clock!.now),
      }
      await tx
        .insert(executionAdmissionReservations)
        .values(values)
        .onConflictDoUpdate({ target: executionAdmissionReservations.executionId, set: values })
      return {
        executionId,
        token,
        claimEpoch,
        generation: maintenance.generation,
        holderRevision: maintenance.holderRevision,
        ownerId: this.ownerId,
        ownerIncarnation: this.ownerIncarnation,
      }
    })
  }

  async claimProvisionalLease(
    executionId: string,
    expectedRunnerClaimToken: string,
    expectedRunnerClaimGeneration: number
  ): Promise<AdmissionLease | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const [execution] = await tx
        .select({
          runnerClaimToken: executions.runnerClaimToken,
          runnerClaimGeneration: executions.runnerClaimGeneration,
          status: executions.status,
        })
        .from(executions)
        .where(eq(executions.id, executionId))
        .for('update')
      const [row] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, executionId))
        .for('update')
      if (
        !maintenance ||
        !execution ||
        execution.status !== 'running' ||
        execution.runnerClaimToken !== expectedRunnerClaimToken ||
        execution.runnerClaimGeneration !== expectedRunnerClaimGeneration ||
        !row ||
        !isLeaseBearingReservation(row) ||
        row.state !== 'provisional' ||
        row.token !== expectedRunnerClaimToken ||
        row.admittedGeneration !== expectedRunnerClaimGeneration
      )
        return null
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const platformActive = maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now
      if (
        maintenance.adminHold ||
        platformActive ||
        maintenance.generation !== row.admittedGeneration ||
        maintenance.holderRevision !== row.admittedHolderRevision
      )
        return null
      const [claimed] = await tx
        .update(executionAdmissionReservations)
        .set({
          ownerId: this.ownerId,
          ownerIncarnation: this.ownerIncarnation,
          state: 'requested',
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionAdmissionReservations.executionId, executionId),
            eq(executionAdmissionReservations.token, row.token),
            eq(executionAdmissionReservations.claimEpoch, row.claimEpoch),
            eq(executionAdmissionReservations.state, 'provisional')
          )
        )
        .returning()
      if (!claimed || !isLeaseBearingReservation(claimed)) return null
      return {
        executionId,
        token: claimed.token,
        claimEpoch: claimed.claimEpoch,
        generation: claimed.admittedGeneration,
        holderRevision: claimed.admittedHolderRevision,
        ownerId: claimed.ownerId,
        ownerIncarnation: claimed.ownerIncarnation,
      }
    })
  }

  /**
   * Whether the maintenance fence this lease was admitted under is still open
   * (same generation/holder revision, no admin hold, no active platform lease).
   * Lets a caller whose phase finish was refused tell "maintenance closed on
   * me" (park) from "I no longer hold this lease" (fail durably).
   */
  /**
   * True when this exact lease's reservation row is already terminally settled
   * (released/revoked): the owner's own teardown won a race against a pending
   * phase finish. Distinguishes self-settled bookkeeping (idempotent success)
   * from a genuine lease loss (foreign takeover).
   */
  async isLeaseTerminal(lease: AdmissionLease): Promise<boolean> {
    return db.transaction((tx) => isExactAdmissionLeaseTerminal(tx, lease))
  }

  async isFenceOpen(lease: AdmissionLease): Promise<boolean> {
    const [result] = await db
      .select({ state: instanceMaintenanceState, now: sql<Date>`clock_timestamp()` })
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    if (!result) return false
    const now = new Date(result.now)
    const platformActive = result.state.platformLeaseExpiresAt !== null && result.state.platformLeaseExpiresAt > now
    return (
      !result.state.adminHold &&
      !platformActive &&
      result.state.generation === lease.generation &&
      result.state.holderRevision === lease.holderRevision
    )
  }

  async loadLease(executionId: string): Promise<AdmissionLease | null> {
    const [row] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, executionId))
    if (
      !row ||
      !isLeaseBearingReservation(row) ||
      row.ownerId !== this.ownerId ||
      row.ownerIncarnation !== this.ownerIncarnation ||
      ['released', 'revoked'].includes(row.state)
    )
      return null
    return {
      executionId: row.executionId,
      token: row.token,
      claimEpoch: row.claimEpoch,
      generation: row.admittedGeneration,
      holderRevision: row.admittedHolderRevision,
      ownerId: row.ownerId,
      ownerIncarnation: row.ownerIncarnation,
    }
  }

  async adoptLease(lease: AdmissionLease): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const [reservation] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, lease.executionId))
        .for('update')
      if (!maintenance || !reservation || !isLeaseBearingReservation(reservation)) return false
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const platformActive = maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now
      if (
        maintenance.adminHold ||
        platformActive ||
        maintenance.generation !== lease.generation ||
        maintenance.holderRevision !== lease.holderRevision ||
        reservation.state !== 'provisional' ||
        reservation.token !== lease.token ||
        reservation.claimEpoch !== lease.claimEpoch ||
        reservation.ownerId !== lease.ownerId ||
        reservation.ownerIncarnation !== lease.ownerIncarnation ||
        reservation.leaseExpiresAt <= now
      )
        return false
      const [updated] = await tx
        .update(executionAdmissionReservations)
        .set({
          state: 'requested',
          phase: 'none',
          operationId: null,
          resourceKey: null,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionAdmissionReservations.executionId, lease.executionId),
            eq(executionAdmissionReservations.token, lease.token),
            eq(executionAdmissionReservations.claimEpoch, lease.claimEpoch),
            eq(executionAdmissionReservations.ownerId, lease.ownerId),
            eq(executionAdmissionReservations.ownerIncarnation, lease.ownerIncarnation),
            eq(executionAdmissionReservations.state, 'provisional')
          )
        )
        .returning({ id: executionAdmissionReservations.executionId })
      return !!updated
    })
  }

  /**
   * Renew the lease of an open phase. Reports WHY a renewal did not happen so
   * the caller can tell a definitive fence loss (abort the effect) from a
   * transient condition (retry next tick).
   *
   * A row that lapsed to `unknown` (markExpiredOpenEffectsUnknown) is repaired
   * back to `starting` when the FULL exact identity — token, claim epoch, owner,
   * incarnation, admitted generation/holder revision — AND the exact phase and
   * phase sequence still match: the owner is provably alive and still inside
   * that phase, so `unknown` was a false alarm. Recovery consumers of `unknown`
   * rewrite state/identity under the same row lock, so a repair can never race
   * them destructively: whichever commits first wins and the other no-ops.
   */
  async heartbeatEffect(lease: AdmissionLease, phase: OpenPhase): Promise<AdmissionHeartbeatOutcome> {
    return db.transaction(async (tx): Promise<AdmissionHeartbeatOutcome> => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!maintenance || !clock) return { ok: false, retryable: true, reason: 'maintenance-missing' }
      const now = new Date(clock.now)
      const platformActive = maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now
      if (
        maintenance.adminHold ||
        platformActive ||
        maintenance.generation !== lease.generation ||
        maintenance.holderRevision !== lease.holderRevision
      )
        return { ok: false, retryable: false, reason: 'fence-revoked' }
      const [reservation] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, lease.executionId))
        .for('update')
      if (!reservation) return { ok: false, retryable: false, reason: 'reservation-missing' }
      if (
        reservation.token !== lease.token ||
        reservation.claimEpoch !== lease.claimEpoch ||
        reservation.ownerId !== lease.ownerId ||
        reservation.ownerIncarnation !== lease.ownerIncarnation ||
        reservation.admittedGeneration !== lease.generation ||
        reservation.admittedHolderRevision !== lease.holderRevision
      )
        return { ok: false, retryable: false, reason: 'identity-mismatch' }
      if (reservation.phase !== phase.phase || reservation.phaseSequence !== phase.phaseSequence)
        return { ok: false, retryable: false, reason: 'phase-superseded' }
      if (reservation.state !== 'starting' && reservation.state !== 'unknown')
        return { ok: false, retryable: false, reason: 'reservation-not-live' }
      const repaired = reservation.state === 'unknown'
      const [updated] = await tx
        .update(executionAdmissionReservations)
        .set({
          state: 'starting',
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            ...exactLeasePredicates(lease),
            inArray(executionAdmissionReservations.state, ['starting', 'unknown']),
            eq(executionAdmissionReservations.phase, phase.phase as AdmissionWritePhase),
            eq(executionAdmissionReservations.phaseSequence, phase.phaseSequence)
          )
        )
        .returning({ id: executionAdmissionReservations.executionId })
      if (!updated) return { ok: false, retryable: false, reason: 'reservation-not-live' }
      return { ok: true, repaired }
    })
  }

  /**
   * Restore queued executions stranded behind an expired admission whose
   * process owner is proven dead. Candidate SQL is only an optimization; the
   * shared classifier rechecks every safety discriminator under row locks.
   */
  async recoverDeadOwnerQueuedAdmissions(): Promise<Array<{ executionId: string; agentId: string; status: 'queued' }>> {
    // Intentionally no agent queue lock: execution->reservation row locks plus
    // six-field CAS exclude mutation; the queued event is emitted post-commit.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!clock) return []
      const now = new Date(clock.now)
      const candidates = await tx
        .select({ executionId: executionAdmissionReservations.executionId })
        .from(executionAdmissionReservations)
        .innerJoin(executions, eq(executions.id, executionAdmissionReservations.executionId))
        .where(
          and(
            eq(executions.status, 'queued'),
            sql`${executionAdmissionReservations.state} NOT IN ('queued', 'waiting-maintenance', 'released', 'revoked')`,
            sql`${executionAdmissionReservations.leaseExpiresAt} <= ${clock.now}`
          )
        )
      const recovered: Array<{ executionId: string; agentId: string; status: 'queued' }> = []
      for (const candidate of candidates) {
        const [execution] = await tx
          .select()
          .from(executions)
          .where(eq(executions.id, candidate.executionId))
          .for('update')
        if (!execution) continue
        const [reservation] = await tx
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, candidate.executionId))
          .for('update')
        if (!reservation) continue
        const result = await restoreStrandedQueuedAdmission(tx, { execution, reservation, now })
        if (result.kind === 'cas-lost') throw new Error('Queued admission recovery lost its exact reservation CAS')
        if (result.kind !== 'restored') continue
        recovered.push({ executionId: execution.id, agentId: execution.agentId, status: 'queued' })
      }
      return recovered
    })
  }

  /**
   * Recover phases whose adapters provide observable idempotent reconciliation:
   * - sandbox ensure/recreate adopts the manager's actual runtime state;
   * - toolchain reconcile adopts its durable fingerprint/provision state;
   * - workspace watch adopts getWatchStatus before startWatch;
   * - managed deployment restart uses the supervisor/health guard and does not
   *   blindly spawn a second healthy process.
   *
   * The old row is terminalized before wake. The next pickup creates a fresh
   * token/epoch, so an old finisher cannot settle the replayed execution.
   */
  async recoverUnknownRetryableEffects(): Promise<
    Array<{ executionId: string; agentId: string; status: 'queued' | 'waiting-maintenance' }>
  > {
    const retryablePhases: AdmissionWritePhase[] = [
      'sandbox-drift-recreate',
      'sandbox-ensure',
      'toolchain-reconcile',
      'workspace-watch-configure',
      'local-deployment-restart',
    ]
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!maintenance) return []
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const effective =
        maintenance.adminHold ||
        (maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now)
      const candidates = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.state, 'unknown'),
            inArray(executionAdmissionReservations.phase, retryablePhases)
          )
        )
      const recovered: Array<{
        executionId: string
        agentId: string
        status: 'queued' | 'waiting-maintenance'
      }> = []
      for (const candidate of candidates) {
        if (!isLeaseBearingReservation(candidate)) continue
        const [current] = await tx
          .select()
          .from(executions)
          .where(eq(executions.id, candidate.executionId))
          .for('update')
        if (!current) continue
        const [reservation] = await tx
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, candidate.executionId))
          .for('update')
        if (
          !reservation ||
          reservation.token !== candidate.token ||
          reservation.claimEpoch !== candidate.claimEpoch ||
          reservation.ownerId !== candidate.ownerId ||
          reservation.ownerIncarnation !== candidate.ownerIncarnation ||
          reservation.state !== 'unknown' ||
          !retryablePhases.includes(reservation.phase as AdmissionWritePhase)
        )
          continue
        const [execution] = await tx
          .update(executions)
          .set({
            status: effective ? 'waiting-maintenance' : 'queued',
            maintenanceGeneration: effective ? maintenance.generation : null,
            maintenanceQueuedAt: effective ? now : null,
            runnerClaimToken: null,
            runnerClaimGeneration: null,
            executionVersion: sql`${executions.executionVersion} + 1`,
          })
          .where(
            and(
              eq(executions.id, candidate.executionId),
              eq(executions.status, 'running'),
              eq(executions.runnerClaimToken, candidate.token),
              eq(executions.runnerClaimGeneration, candidate.admittedGeneration)
            )
          )
          .returning({ id: executions.id, agentId: executions.agentId, status: executions.status })
        if (!execution) continue
        const [revoked] = await tx
          .update(executionAdmissionReservations)
          .set({
            state: 'revoked',
            phase: 'none',
            operationId: null,
            resourceKey: null,
            recoveryOwnerId: this.ownerId,
            recoveryOwnerIncarnation: this.ownerIncarnation,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionAdmissionReservations.executionId, candidate.executionId),
              eq(executionAdmissionReservations.token, candidate.token),
              eq(executionAdmissionReservations.claimEpoch, candidate.claimEpoch),
              eq(executionAdmissionReservations.ownerId, candidate.ownerId),
              eq(executionAdmissionReservations.ownerIncarnation, candidate.ownerIncarnation),
              eq(executionAdmissionReservations.admittedGeneration, candidate.admittedGeneration),
              eq(executionAdmissionReservations.admittedHolderRevision, candidate.admittedHolderRevision),
              eq(executionAdmissionReservations.state, 'unknown'),
              eq(executionAdmissionReservations.phase, candidate.phase),
              inArray(executionAdmissionReservations.phase, retryablePhases)
            )
          )
          .returning({ id: executionAdmissionReservations.executionId })
        if (!revoked) throw new Error('Retryable effect recovery lost its exact reservation CAS')
        if (
          !(await restoreQueueOwnedAdmission(tx, {
            agentId: execution.agentId,
            executionId: execution.id,
            state: execution.status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued',
          }))
        )
          throw new Error('Retryable recovery lost its queue-owned admission repair')
        recovered.push({
          executionId: execution.id,
          agentId: execution.agentId,
          status: execution.status as 'queued' | 'waiting-maintenance',
        })
      }
      return recovered
    })
  }

  async recoverDeadOwnerSessionCreates(): Promise<
    Array<{ executionId: string; agentId: string; status: 'queued' | 'waiting-maintenance' }>
  > {
    const { ADMISSION_LIVENESS_HASH_SEED, ADMISSION_LIVENESS_LOCK_VERSION } = await import('./process-liveness')
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!maintenance) return []
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const effective =
        maintenance.adminHold ||
        (maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now)
      const candidates = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.state, 'unknown'),
            eq(executionAdmissionReservations.phase, 'session-create')
          )
        )
      const recovered: Array<{
        executionId: string
        agentId: string
        status: 'queued' | 'waiting-maintenance'
      }> = []
      for (const candidate of candidates) {
        if (!isLeaseBearingReservation(candidate)) continue
        const [current] = await tx
          .select()
          .from(executions)
          .where(eq(executions.id, candidate.executionId))
          .for('update')
        if (!current) continue
        const [reservation] = await tx
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, candidate.executionId))
          .for('update')
        if (
          !reservation ||
          reservation.token !== candidate.token ||
          reservation.claimEpoch !== candidate.claimEpoch ||
          reservation.ownerId !== candidate.ownerId ||
          reservation.ownerIncarnation !== candidate.ownerIncarnation ||
          reservation.state !== 'unknown' ||
          reservation.phase !== 'session-create'
        )
          continue
        const [proof] = await tx
          .select({
            dead: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${candidate.ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`,
          })
          .from(instanceMaintenanceState)
          .where(eq(instanceMaintenanceState.id, 'global'))
        if (!proof?.dead) continue
        const [execution] = await tx
          .update(executions)
          .set({
            status: effective ? 'waiting-maintenance' : 'queued',
            maintenanceGeneration: effective ? maintenance.generation : null,
            maintenanceQueuedAt: effective ? now : null,
            runnerClaimToken: null,
            runnerClaimGeneration: null,
            executionVersion: sql`${executions.executionVersion} + 1`,
          })
          .where(
            and(
              eq(executions.id, candidate.executionId),
              eq(executions.status, 'running'),
              eq(executions.runnerClaimToken, candidate.token),
              eq(executions.runnerClaimGeneration, candidate.admittedGeneration)
            )
          )
          .returning({ id: executions.id, agentId: executions.agentId, status: executions.status })
        if (!execution) continue
        const [revoked] = await tx
          .update(executionAdmissionReservations)
          .set({
            state: 'revoked',
            phase: 'none',
            operationId: null,
            resourceKey: null,
            recoveryOwnerId: this.ownerId,
            recoveryOwnerIncarnation: this.ownerIncarnation,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionAdmissionReservations.executionId, candidate.executionId),
              eq(executionAdmissionReservations.token, candidate.token),
              eq(executionAdmissionReservations.claimEpoch, candidate.claimEpoch),
              eq(executionAdmissionReservations.ownerId, candidate.ownerId),
              eq(executionAdmissionReservations.ownerIncarnation, candidate.ownerIncarnation),
              eq(executionAdmissionReservations.admittedGeneration, candidate.admittedGeneration),
              eq(executionAdmissionReservations.admittedHolderRevision, candidate.admittedHolderRevision),
              eq(executionAdmissionReservations.state, 'unknown'),
              eq(executionAdmissionReservations.phase, 'session-create')
            )
          )
          .returning({ id: executionAdmissionReservations.executionId })
        if (!revoked) throw new Error('Session-create recovery lost its exact reservation CAS')
        if (
          !(await restoreQueueOwnedAdmission(tx, {
            agentId: execution.agentId,
            executionId: execution.id,
            state: execution.status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued',
          }))
        )
          throw new Error('Session-create recovery lost its queue-owned admission repair')
        recovered.push({
          executionId: execution.id,
          agentId: execution.agentId,
          status: execution.status as 'queued' | 'waiting-maintenance',
        })
      }
      return recovered
    })
  }

  async recoverDeadOwnerRuntimeEffects(): Promise<
    Array<{
      executionId: string
      agentId: string
      status: 'queued' | 'waiting-maintenance' | 'completed' | 'failed' | 'stopped'
    }>
  > {
    const { ADMISSION_LIVENESS_HASH_SEED, ADMISSION_LIVENESS_LOCK_VERSION } = await import('./process-liveness')
    const phases: AdmissionWritePhase[] = ['agent-session', 'settlement', 'sandbox-recovery']
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!maintenance) return []
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const effective =
        maintenance.adminHold ||
        (maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now)
      const candidates = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.state, 'unknown'),
            inArray(executionAdmissionReservations.phase, phases)
          )
        )
      const recovered: Array<{
        executionId: string
        agentId: string
        status: 'queued' | 'waiting-maintenance' | 'completed' | 'failed' | 'stopped'
      }> = []
      for (const candidate of candidates) {
        if (!isLeaseBearingReservation(candidate)) continue
        const [current] = await tx
          .select()
          .from(executions)
          .where(eq(executions.id, candidate.executionId))
          .for('update')
        if (!current) continue
        const [reservation] = await tx
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, candidate.executionId))
          .for('update')
        if (
          !reservation ||
          reservation.token !== candidate.token ||
          reservation.claimEpoch !== candidate.claimEpoch ||
          reservation.ownerId !== candidate.ownerId ||
          reservation.ownerIncarnation !== candidate.ownerIncarnation ||
          reservation.state !== 'unknown' ||
          !phases.includes(reservation.phase as AdmissionWritePhase)
        )
          continue
        const [proof] = await tx
          .select({
            dead: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${candidate.ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`,
          })
          .from(instanceMaintenanceState)
          .where(eq(instanceMaintenanceState.id, 'global'))
        if (!proof?.dead) continue
        const terminal = ['completed', 'failed', 'stopped'].includes(current.status)
        if (
          !terminal &&
          (current.runnerClaimToken !== candidate.token ||
            current.runnerClaimGeneration !== candidate.admittedGeneration)
        )
          continue
        let status: 'queued' | 'waiting-maintenance' | 'completed' | 'failed' | 'stopped'
        if (terminal) {
          status = current.status as 'completed' | 'failed' | 'stopped'
        } else {
          const [durableAssistant] = await tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.agentId, current.agentId),
                eq(messages.role, 'assistant'),
                sql`${messages.metadata}->>'executionId' = ${candidate.executionId}`
              )
            )
            .limit(1)
          status = durableAssistant ? 'completed' : effective ? 'waiting-maintenance' : 'queued'
          const [updatedExecution] = await tx
            .update(executions)
            .set({
              status,
              endedAt: status === 'completed' ? databaseClockNow() : null,
              maintenanceGeneration: status === 'waiting-maintenance' ? maintenance.generation : null,
              maintenanceQueuedAt: status === 'waiting-maintenance' ? now : null,
              runnerClaimToken: null,
              runnerClaimGeneration: null,
              executionVersion: sql`${executions.executionVersion} + 1`,
            })
            .where(
              and(
                eq(executions.id, candidate.executionId),
                eq(executions.runnerClaimToken, candidate.token),
                eq(executions.runnerClaimGeneration, candidate.admittedGeneration),
                inArray(executions.status, ['running', 'stopping'])
              )
            )
            .returning({ id: executions.id })
          if (!updatedExecution) continue
        }
        const [released] = await tx
          .update(executionAdmissionReservations)
          .set({
            state: ['completed', 'failed', 'stopped'].includes(status) ? 'released' : 'revoked',
            phase: 'none',
            operationId: null,
            resourceKey: null,
            recoveryOwnerId: this.ownerId,
            recoveryOwnerIncarnation: this.ownerIncarnation,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionAdmissionReservations.executionId, candidate.executionId),
              eq(executionAdmissionReservations.token, candidate.token),
              eq(executionAdmissionReservations.claimEpoch, candidate.claimEpoch),
              eq(executionAdmissionReservations.ownerId, candidate.ownerId),
              eq(executionAdmissionReservations.ownerIncarnation, candidate.ownerIncarnation),
              eq(executionAdmissionReservations.admittedGeneration, candidate.admittedGeneration),
              eq(executionAdmissionReservations.admittedHolderRevision, candidate.admittedHolderRevision),
              eq(executionAdmissionReservations.state, 'unknown'),
              eq(executionAdmissionReservations.phase, candidate.phase),
              inArray(executionAdmissionReservations.phase, phases)
            )
          )
          .returning({ id: executionAdmissionReservations.executionId })
        if (!released) throw new Error('Runtime effect recovery lost its exact reservation CAS')
        if (
          (status === 'queued' || status === 'waiting-maintenance') &&
          !(await restoreQueueOwnedAdmission(tx, {
            agentId: current.agentId,
            executionId: current.id,
            state: status,
          }))
        )
          throw new Error('Runtime effect recovery lost its queue-owned admission repair')
        recovered.push({ executionId: current.id, agentId: current.agentId, status })
      }
      return recovered
    })
  }

  async markExpiredOpenEffectsUnknown(): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!clock) return 0
      const updated = await tx
        .update(executionAdmissionReservations)
        .set({
          state: 'unknown',
          phase: sql`CASE
            WHEN ${executionAdmissionReservations.state} = 'settling' THEN 'settlement'
            ELSE ${executionAdmissionReservations.phase}
          END`,
          updatedAt: new Date(clock.now),
        })
        .where(
          and(
            inArray(executionAdmissionReservations.state, ['starting', 'settling']),
            sql`${executionAdmissionReservations.leaseExpiresAt} <= ${clock.now}`
          )
        )
        .returning({ id: executionAdmissionReservations.executionId })
      return updated.length
    })
  }

  /**
   * Close an open phase. A phase that lapsed to `unknown` while its owner was
   * still inside it (the heartbeat could not renew in time) is closed the same
   * way when the FULL exact identity plus phase/sequence/operation match — the
   * finisher IS the live owner, so the phase really did complete. Recovery
   * consumers of `unknown` rewrite state under the row lock first, in which
   * case this exact CAS simply matches nothing.
   */
  async finishWritePhase(
    lease: AdmissionLease,
    phase: OpenPhase,
    nextState: 'requested' | 'running' | 'settling'
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!clock) return false
      const now = new Date(clock.now)
      const predicates = [
        ...exactLeasePredicates(lease),
        inArray(executionAdmissionReservations.state, ['starting', 'unknown']),
        eq(executionAdmissionReservations.phase, phase.phase as AdmissionWritePhase),
        eq(executionAdmissionReservations.phaseSequence, phase.phaseSequence),
      ]
      if (phase.operationId !== null) predicates.push(eq(executionAdmissionReservations.operationId, phase.operationId))
      if (phase.resourceKey !== null) predicates.push(eq(executionAdmissionReservations.resourceKey, phase.resourceKey))
      const [updated] = await tx
        .update(executionAdmissionReservations)
        .set({
          state: nextState,
          phase: 'none',
          operationId: null,
          resourceKey: null,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          updatedAt: now,
          lastHeartbeatAt: now,
        })
        .where(and(...predicates))
        .returning({ id: executionAdmissionReservations.executionId })
      return !!updated
    })
  }

  async beginWritePhase(lease: AdmissionLease, phase: AdmissionWritePhase, resourceKey: string) {
    return (await this.beginWritePhaseDetailed(lease, phase, resourceKey)).phase
  }

  /**
   * Like beginWritePhase, but says WHY a phase was refused so the runner can
   * tell a closed maintenance fence (park the execution) from a lease this
   * owner no longer holds (fail durably; never leave the row `running` and
   * unheld for the abandoned-lease sweep to re-queue as a duplicate).
   */
  async beginWritePhaseDetailed(
    lease: AdmissionLease,
    phase: AdmissionWritePhase,
    resourceKey: string
  ): Promise<{ phase: LeaseBearingReservation | null; refusal: AdmissionPhaseRefusal | null }> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [maintenance] = await tx
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const [reservation] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, lease.executionId))
        .for('update')
      if (!maintenance) return { phase: null, refusal: 'fence-closed' }
      if (!reservation || !isLeaseBearingReservation(reservation)) return { phase: null, refusal: 'lease-lost' }
      const [clock] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      const now = new Date(clock!.now)
      const leaseActive = maintenance.platformLeaseExpiresAt !== null && maintenance.platformLeaseExpiresAt > now
      const identityMatches =
        reservation.token === lease.token &&
        reservation.claimEpoch === lease.claimEpoch &&
        reservation.ownerId === lease.ownerId &&
        reservation.ownerIncarnation === lease.ownerIncarnation &&
        reservation.leaseExpiresAt > now
      const fenceMatches =
        maintenance.generation === lease.generation &&
        maintenance.holderRevision === lease.holderRevision &&
        !maintenance.adminHold &&
        !leaseActive
      const expectedState = phase === 'agent-session' || phase === 'settlement' ? 'running' : 'requested'
      const canBegin = reservation.state === expectedState && reservation.phase === 'none'
      if (!identityMatches || !fenceMatches || !canBegin) {
        if (identityMatches && canBegin && !fenceMatches) {
          await tx
            .update(executionAdmissionReservations)
            .set({ state: 'revoked', updatedAt: now })
            .where(
              and(
                ...exactLeasePredicates(lease),
                eq(executionAdmissionReservations.state, expectedState),
                eq(executionAdmissionReservations.phase, 'none')
              )
            )
        }
        const refusal: AdmissionPhaseRefusal = !fenceMatches
          ? 'fence-closed'
          : !identityMatches
            ? 'lease-lost'
            : 'phase-conflict'
        return { phase: null, refusal }
      }
      // A fresh phase starts with a full lease: renewal is otherwise heartbeat-
      // only, and a phase begun near the end of the previous lease would lapse
      // (and be marked unknown) before its first heartbeat.
      const [started] = await tx
        .update(executionAdmissionReservations)
        .set({
          state: 'starting',
          phase,
          phaseSequence: sql`${executionAdmissionReservations.phaseSequence} + 1`,
          operationId: crypto.randomUUID(),
          resourceKey,
          updatedAt: now,
          lastHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
        })
        .where(
          and(
            eq(executionAdmissionReservations.executionId, lease.executionId),
            eq(executionAdmissionReservations.token, lease.token),
            eq(executionAdmissionReservations.claimEpoch, lease.claimEpoch),
            eq(executionAdmissionReservations.ownerId, lease.ownerId),
            eq(executionAdmissionReservations.ownerIncarnation, lease.ownerIncarnation),
            eq(executionAdmissionReservations.admittedGeneration, lease.generation),
            eq(executionAdmissionReservations.admittedHolderRevision, lease.holderRevision),
            eq(executionAdmissionReservations.state, expectedState),
            eq(executionAdmissionReservations.phase, 'none')
          )
        )
        .returning()
      if (!started || !isLeaseBearingReservation(started)) return { phase: null, refusal: 'phase-conflict' }
      return { phase: started, refusal: null }
    })
  }
}
