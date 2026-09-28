import { and, asc, desc, eq, inArray, InferSelectModel, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '../db'
import { databaseClockNow } from '../db/clock'
import {
  executions,
  agents,
  executionAdmissionReservations,
  sandboxProvisionRecoveries,
  workStreams,
} from '../db/schema'
import { Execution as ExecutionJson, ExecutionStatus, SessionUsage, AgentStatus, QuestionData } from '@ficus/shared'
import type { SandboxProvisionErrorCode } from '../services/sandbox/k8s/provision-errors'
import type { ProvisionFailureCode } from '../services/sandbox/k8s/provision-failure'
import type { AdmissionLease } from '../services/maintenance/admission-reservation'
import {
  admissionLeaseFromError,
  isExactAdmissionLeaseTerminal,
  settleExactAdmissionLease,
} from '../services/maintenance/admission-reservation'
import { eventEmitter } from '../lib/infra/event-emitter'
import { BaseEntity } from './base'
import { createLogger } from '../lib/infra/logger'
import { routeFailure } from '../services/execution/failure-routing'
import {
  CAPACITY_REFUSAL_FAILURE,
  SANDBOX_RECOVERY_EXHAUSTED_FAILURE,
  classifySetupFailure,
  type ExecutionFailure,
} from '../services/execution/failure-classification'
import { isActiveExecutionStatus } from '../services/execution/status'
import {
  STARTUP_RETRY_DELAYS_MS,
  startupRetryCode,
  isExecutionStartupFailure,
} from '../services/execution/startup-retry'
import { restoreQueueOwnedAdmission } from '../services/execution/agent-admission'
import { maintenanceStore } from '../services/maintenance/store'
import {
  computeProvisionRecoveryTiming,
  PROVISION_RECOVERY_DEADLINE_MS,
} from '../services/sandbox/k8s/provision-recovery-store'

const log = createLogger('execution')

// Forward declaration to avoid circular import at module load time
import type { Agent } from './Agent'

function safeRunnerTypeForTiming(agent: Agent): string {
  try {
    return agent.runnerType
  } catch {
    return agent.agentTypeId
  }
}

export type ExecutionRow = InferSelectModel<typeof executions>

export interface UpdateExecutionInput {
  status?: ExecutionStatus
  usage?: SessionUsage | null
  imageIds?: string[] | null
  endedAt?: Date
  error?: string | null
  failureClass?: ExecutionFailure['failureClass'] | null
  failureReason?: string | null
  maintenanceGeneration?: number | null
  maintenanceQueuedAt?: Date | null
}

/**
 * The terminal-transition form of {@link UpdateExecutionInput}: `endedAt` is written by the
 * database clock (a SQL expression), not by the caller. See {@link databaseClockNow}.
 */
type ExecutionTerminalUpdate = Omit<UpdateExecutionInput, 'endedAt'> & { endedAt?: Date | SQL }

export interface ListExecutionsFilters {
  agentId?: string
  status?: ExecutionStatus
}

/**
 * The agent-side disposition a transition carries. `questionData` is only
 * ever set alongside `status: 'waiting-input'` in practice (via
 * {@link routeFailure}), but the type doesn't enforce that pairing.
 */
export interface AgentDisposition {
  status: AgentStatus
  questionData?: QuestionData | null
}

/**
 * The outcomes `Execution.transitionTo` knows how to apply. Every public
 * transition method (start/complete/fail/stop/forceStop/supersede/requeue) is
 * a thin wrapper over one of these. See the maintained lifecycle overview:
 * docs/wiki/agents-and-executions.md#execution-transitions
 */
export interface SandboxProvisionRecoveryInput {
  scope: string
  sandboxKey: string
  circuitVersion?: number
  refusalId: string
  errorCode: SandboxProvisionErrorCode
  reasonCode?: ProvisionFailureCode
  workStreamId?: string | null
  retryAfterMs?: number
  now?: Date
  nextAttemptAt?: Date
  deadlineAt?: Date
}

export type TransitionOutcome =
  | { kind: 'started' }
  | { kind: 'waiting-sandbox'; recovery: SandboxProvisionRecoveryInput }
  | {
      kind: 'sandbox-recovered'
      generation: number
      leaseOwner: string
      claimKind: 'ordinary' | 'half_open_probe'
    }
  | {
      kind: 'sandbox-retry-deferred'
      generation: number
      leaseOwner: string
      retryAfterMs?: number
      nextAttemptAt?: Date
      now?: Date
    }
  | { kind: 'sandbox-recovery-exhausted'; generation: number; leaseOwner: string; error: string }
  | { kind: 'sandbox-recovery-cancelled'; generation: number; leaseOwner: string }
  | { kind: 'completed'; usage?: SessionUsage; agent?: AgentDisposition }
  | {
      kind: 'failed'
      error: string
      /** Structural classification, persisted with the terminal write. */ failure?: ExecutionFailure
    }
  | { kind: 'stopped' }
  | { kind: 'force-stopped'; reason?: string }
  | { kind: 'superseded' }
  | { kind: 'requeued'; imageIds?: string[] | null; startupRetryDelayMs?: number }

/**
 * The drizzle transaction handle `db.transaction` passes to its callback —
 * what {@link TransitionOptions.startGuard} receives so a guard's locking
 * reads run INSIDE the claim transaction (same definition as
 * services/machines/queries.ts's `DbTransaction`).
 */
export type TransactionHandle = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface TransitionOptions {
  /**
   * Pre-claim guard for `{ kind: 'started' }` ONLY (ignored for every other
   * kind): runs INSIDE the claim transaction, on its own tx handle, BEFORE
   * the queued→running CAS. Return `false` to refuse the claim — nothing is
   * written (execution or agent), no events fire, and `transitionTo` returns
   * `false`, exactly like a lost CAS race; the caller distinguishes the two
   * via its own closure state.
   *
   * Exists for guards whose correctness depends on a row lock being held
   * through the claim's COMMIT — e.g. the execution-pickup migration fence,
   * whose `SELECT ... FOR UPDATE` on the `machine_boxes` row must serialize
   * with `fenceBoxForMigration`'s own locked set-then-recheck (see
   * services/machines/queries.ts). A plain read outside this transaction
   * races: the claim could commit moments after reading a stale
   * `migrating = false`. Guards run while the claim transaction holds a pool
   * connection (and any locks they take), so they must be fast and DB-only,
   * and must never lock rows some OTHER path locks before the ones this
   * transaction writes (`executions`, `agents`) — see the lock-ordering notes
   * on `fenceBoxForMigration`.
   */
  startGuard?: (tx: TransactionHandle) => Promise<boolean>
  /** Runs after the queued→running CAS in the same transaction. */
  afterStarted?: (tx: TransactionHandle, row: ExecutionRow) => Promise<void>
  /** Exact runner admission identity required for runner-owned terminal/requeue transitions. */
  admissionLease?: AdmissionLease
  /** Test barrier after execution lock/CAS and before reservation settlement. */
  afterExecutionLocked?: (tx: TransactionHandle, row: ExecutionRow) => Promise<void>
}

/** The disposition to apply to the agent for a given outcome, or null when the agent is untouched. */
function agentDispositionFor(
  outcome: TransitionOutcome,
  failureDisposition?: AgentDisposition
): AgentDisposition | null {
  switch (outcome.kind) {
    case 'started':
      return { status: 'active' }
    case 'waiting-sandbox':
      return { status: 'idle' }
    case 'sandbox-recovered':
    case 'sandbox-retry-deferred':
      return null
    case 'sandbox-recovery-exhausted':
    case 'sandbox-recovery-cancelled':
      return { status: 'idle' }
    case 'completed':
      return outcome.agent ?? { status: 'idle' }
    case 'failed':
      return failureDisposition!
    case 'stopped':
    case 'force-stopped':
      return { status: 'idle' }
    case 'superseded':
      return null
    case 'requeued':
      return outcome.startupRetryDelayMs !== undefined ? { status: 'idle' } : null
  }
}

/** Kinds that release the provider concurrency slot post-commit (best-effort). */
async function releaseProviderSlot(executionId: string): Promise<void> {
  try {
    const { concurrencyLimiter } = await import('../services/execution/concurrency-limiter-instance')
    concurrencyLimiter.release(executionId)
  } catch {
    // Best-effort: durable transition success must not depend on the in-memory limiter.
  }
}

const SLOT_RELEASING_KINDS = new Set<TransitionOutcome['kind']>([
  'completed',
  'failed',
  'stopped',
  'force-stopped',
  'requeued',
  'waiting-sandbox',
])

export class Execution extends BaseEntity<ExecutionJson, UpdateExecutionInput> implements ExecutionRow {
  // Row fields
  declare id: string
  declare agentId: string
  declare status: ExecutionStatus
  declare maintenanceGeneration: number | null
  declare maintenanceQueuedAt: Date | null
  declare runnerClaimToken: string | null
  declare runnerClaimGeneration: number | null
  declare executionVersion: number
  declare startupRetryCount: number
  declare startupRetryAt: Date | null
  declare message: string | null
  declare imageIds: string[] | null
  declare wakeEligible: boolean
  declare flowContext: ExecutionRow['flowContext']
  declare usage: SessionUsage | null
  declare error: string | null
  declare failureClass: ExecutionRow['failureClass']
  declare failureReason: ExecutionRow['failureReason']
  declare startedAt: Date
  declare runStartedAt: Date | null
  declare endedAt: Date | null

  // Cached relation (set via setAgent or eager loaded)
  private _agent: Agent | null = null

  constructor(data: ExecutionRow) {
    super()
    Object.assign(this, data)
  }

  /**
   * Get the agent relation. Throws if not loaded.
   */
  get agent(): Agent {
    if (!this._agent) {
      throw new Error('Agent relation not loaded. Use mustGetAgent() or setAgent() first.')
    }
    return this._agent
  }

  /**
   * Set the agent relation (used for eager loading).
   */
  setAgent(agent: Agent): this {
    this._agent = agent
    return this
  }

  /**
   * Check if the agent relation is loaded.
   */
  get hasAgent(): boolean {
    return this._agent !== null
  }

  /**
   * Load and return the agent, or return cached if already loaded.
   */
  async mustGetAgent(): Promise<Agent> {
    if (this._agent) return this._agent
    // Dynamic import to avoid circular dependency
    const { Agent } = await import('./Agent')
    this._agent = await Agent.mustFind(this.agentId)
    return this._agent
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Find an execution by ID.
   */
  static async find(id: string): Promise<Execution | null> {
    const [row] = await db.select().from(executions).where(eq(executions.id, id))
    return row ? new Execution(row) : null
  }

  /**
   * Find an execution by ID, throwing if not found.
   */
  static async mustFind(id: string): Promise<Execution> {
    const execution = await this.find(id)
    if (!execution) throw new Error(`Execution ${id} not found`)
    return execution
  }

  /**
   * List executions with optional filters.
   */
  static async list(filters?: ListExecutionsFilters): Promise<Execution[]> {
    const conditions = []

    if (filters?.agentId) {
      conditions.push(eq(executions.agentId, filters.agentId))
    }
    if (filters?.status) {
      conditions.push(eq(executions.status, filters.status))
    }

    const results = db
      .select()
      .from(executions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
    const ordered =
      filters?.status === 'queued'
        ? await results.orderBy(asc(executions.startedAt), asc(executions.id))
        : await results.orderBy(desc(executions.startedAt), desc(executions.id))

    return ordered.map((row) => new Execution(row))
  }

  /**
   * Update an execution by ID.
   */
  static async update(id: string, input: UpdateExecutionInput): Promise<Execution> {
    const safeError = input.error
    input = { ...input, error: safeError }
    // Fetch previous status before update
    const previous = await Execution.find(id)
    const previousStatus = previous?.status

    const [row] = await db.update(executions).set(input).where(eq(executions.id, id)).returning()
    if (!row) throw new Error(`Execution ${id} not found`)

    const execution = new Execution(row)

    const payload = { executionId: execution.id, agentId: execution.agentId, status: execution.status }

    // Always emit the generic updated event
    eventEmitter.emit('execution.updated', payload)

    // Emit specific status events for targeted listeners
    if (input.status === 'completed') {
      eventEmitter.emit('execution.completed', payload)
    } else if (input.status === 'failed') {
      eventEmitter.emit('execution.failed', payload)
    } else if (input.status === 'stopped') {
      eventEmitter.emit('execution.stopped', payload)
    } else if (input.status === 'queued' && previousStatus !== 'queued') {
      eventEmitter.emit('execution.queued', payload)
    }
    // execution.started is emitted exclusively by transitionTo's CAS-gated
    // 'started' path (see below) — this is the single emit site.

    return execution
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Update this execution in-place.
   */
  override async update(input: UpdateExecutionInput): Promise<this> {
    const updated = await Execution.update(this.id, input)
    Object.assign(this, updated)
    return this
  }

  /**
   * Reload this execution from the database.
   */
  override async reload(): Promise<this> {
    const fresh = await Execution.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  /**
   * Check if this execution is active (queued, running, or stopping).
   */
  get isActive(): boolean {
    return isActiveExecutionStatus(this.status)
  }

  /**
   * Check if this execution is terminal (completed, failed, or stopped).
   */
  get isTerminal(): boolean {
    return ['completed', 'failed', 'stopped'].includes(this.status)
  }

  /**
   * Serialize to JSON.
   */
  toJson(): ExecutionJson {
    return {
      id: this.id,
      agentId: this.agentId,
      status: this.status,
      message: this.message,
      imageIds: this.imageIds,
      wakeEligible: this.wakeEligible,
      usage: this.usage,
      error: this.error,
      failureClass: this.failureClass,
      failureReason: this.failureReason,
      startedAt: this.startedAt,
      runStartedAt: this.runStartedAt,
      endedAt: this.endedAt,
    }
  }

  // ---------------------------------------------------------------------------
  // State Transitions
  // ---------------------------------------------------------------------------

  /**
   * The transactional owner of every paired execution/agent status write. The
   * execution-row write (CAS-gated for `started`) and the agent-row write
   * happen in one `db.transaction`, so a mid-pair crash can no longer strand
   * an agent. Events are emitted once, after commit.
   *
   * Returns `false` only for the `started` claim not landing — a CAS lost
   * race (queued→running already claimed by another worker) or an
   * `options.startGuard` refusal — and nothing is written in either case.
   * Throws if the execution row doesn't exist for any other kind (matching
   * today's `Execution.update`).
   */
  async transitionTo(outcome: TransitionOutcome, options?: TransitionOptions): Promise<boolean> {
    // Failure routing is pure and doesn't touch the DB — compute it up front
    // so the disposition is known before entering the transaction.
    const route = outcome.kind === 'failed' ? routeFailure(outcome.error) : undefined
    const disposition = agentDispositionFor(outcome, route?.disposition)

    // Capture the agent's pre-write snapshot BEFORE the transaction — needed
    // by finishAgentWrite post-commit to detect transitions into waiting-input.
    // Read-only; safe even if a CAS below
    // ultimately loses the race and nothing gets written.
    let agentBefore: { status: AgentStatus } | undefined
    if (disposition) {
      const agent = await this.mustGetAgent()
      agentBefore = { status: agent.status }
    }

    // Only 'requeued' needs a genuine pre-write read of the execution's
    // current status (to conditionally emit execution.queued) — 'started'
    // is CAS-gated by construction (queued -> running), and every other kind
    // emits its specific event unconditionally, matching Execution.update.
    const previousStatus = this.status

    const forceStopReason =
      outcome.kind === 'force-stopped' ? outcome.reason || `Force-stopped from ${previousStatus} state` : undefined
    const outcomeError = 'error' in outcome ? outcome.error : undefined

    // Distinguishes an options.startGuard refusal from the lost-CAS `null`
    // inside the transaction result; both surface as `return false` (nothing
    // written, no events).
    const GUARD_REFUSED = Symbol('guard-refused')
    const IDEMPOTENT_SUCCESS = Symbol('idempotent-success')

    let result: ExecutionRow | typeof GUARD_REFUSED | typeof IDEMPOTENT_SUCCESS | null
    try {
      result = await db.transaction(
        async (tx): Promise<ExecutionRow | typeof GUARD_REFUSED | typeof IDEMPOTENT_SUCCESS | null> => {
          let row: ExecutionRow | undefined
          const settlesAdmission =
            outcome.kind === 'requeued' ||
            ['completed', 'failed', 'stopped', 'force-stopped', 'superseded'].includes(outcome.kind)
          if (settlesAdmission)
            await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)

          if (outcome.kind === 'waiting-sandbox') {
            // Execution is always the first lock/CAS in every recovery transition.
            const [suspended] = await tx
              .update(executions)
              .set({ status: 'waiting-sandbox' })
              .where(and(eq(executions.id, this.id), eq(executions.status, 'running')))
              .returning()
            if (!suspended) {
              const [duplicate] = await tx
                .select({ executionStatus: executions.status })
                .from(executions)
                .innerJoin(sandboxProvisionRecoveries, eq(sandboxProvisionRecoveries.executionId, executions.id))
                .where(
                  and(
                    eq(executions.id, this.id),
                    eq(executions.status, 'waiting-sandbox'),
                    eq(sandboxProvisionRecoveries.refusalId, outcome.recovery.refusalId),
                    eq(sandboxProvisionRecoveries.status, 'waiting')
                  )
                )
              return duplicate ? IDEMPOTENT_SUCCESS : null
            }
            const [existing] = await tx
              .select()
              .from(sandboxProvisionRecoveries)
              .where(eq(sandboxProvisionRecoveries.executionId, this.id))
              .for('update')
            const [assignedStream] =
              outcome.recovery.workStreamId === undefined
                ? await tx
                    .select({ id: workStreams.id })
                    .from(workStreams)
                    .where(and(eq(workStreams.assigneeAgentId, this.agentId), eq(workStreams.status, 'active')))
                    .limit(1)
                : []
            const generation = existing ? existing.generation + 1 : 1
            const timingNow = outcome.recovery.now ?? new Date()
            const deadlineAt =
              existing?.deadlineAt ??
              outcome.recovery.deadlineAt ??
              new Date(timingNow.getTime() + PROVISION_RECOVERY_DEADLINE_MS)
            const timing = computeProvisionRecoveryTiming({
              executionId: this.id,
              generation,
              attemptCount: existing?.attemptCount ?? 0,
              retryAfterMs: outcome.recovery.retryAfterMs,
              now: timingNow,
              deadlineAt,
            })
            const values = {
              executionId: this.id,
              agentId: this.agentId,
              workStreamId: outcome.recovery.workStreamId ?? assignedStream?.id ?? null,
              scope: outcome.recovery.scope,
              sandboxKey: outcome.recovery.sandboxKey,
              circuitVersion: outcome.recovery.circuitVersion,
              refusalId: outcome.recovery.refusalId,
              generation,
              status: 'waiting' as const,
              errorCode: outcome.recovery.errorCode,
              reasonCode: outcome.recovery.reasonCode,
              attemptCount: existing?.attemptCount ?? 0,
              nextAttemptAt: timing.nextAttemptAt,
              deadlineAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              claimKind: null,
              updatedAt: new Date(),
            }
            await tx
              .insert(sandboxProvisionRecoveries)
              .values(values)
              .onConflictDoUpdate({ target: sandboxProvisionRecoveries.executionId, set: values })
            row = suspended
          } else if (outcome.kind === 'sandbox-recovered') {
            const [queued] = await tx
              .update(executions)
              .set({ status: 'queued' })
              .where(and(eq(executions.id, this.id), eq(executions.status, 'waiting-sandbox')))
              .returning()
            if (!queued) return null
            const recoverySet =
              outcome.claimKind === 'ordinary'
                ? { status: 'resumed' as const, leaseOwner: null, leaseExpiresAt: null, claimKind: null }
                : { status: 'leased' as const }
            const [recovery] = await tx
              .update(sandboxProvisionRecoveries)
              .set({
                ...recoverySet,
                attemptCount: sql`${sandboxProvisionRecoveries.attemptCount} + 1`,
                lastAttemptAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(sandboxProvisionRecoveries.executionId, this.id),
                  eq(sandboxProvisionRecoveries.generation, outcome.generation),
                  eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner),
                  eq(sandboxProvisionRecoveries.status, 'leased'),
                  eq(sandboxProvisionRecoveries.claimKind, outcome.claimKind)
                )
              )
              .returning()
            if (!recovery) throw new Error('SANDBOX_RECOVERY_FENCE_LOST')
            if (!(await restoreQueueOwnedAdmission(tx, { agentId: queued.agentId, executionId: queued.id })))
              throw new Error('SANDBOX_RECOVERY_ADMISSION_REPAIR_LOST')
            row = queued
          } else if (outcome.kind === 'sandbox-retry-deferred') {
            const [waiting] = await tx
              .update(executions)
              .set({ status: 'waiting-sandbox' })
              .where(and(eq(executions.id, this.id), eq(executions.status, 'queued')))
              .returning()
            if (!waiting) return null
            const deferralNow = outcome.now ?? new Date()
            const [leasedRecovery] = await tx
              .select()
              .from(sandboxProvisionRecoveries)
              .where(
                and(
                  eq(sandboxProvisionRecoveries.executionId, this.id),
                  eq(sandboxProvisionRecoveries.generation, outcome.generation),
                  eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner),
                  eq(sandboxProvisionRecoveries.status, 'leased'),
                  eq(sandboxProvisionRecoveries.claimKind, 'half_open_probe'),
                  lte(sandboxProvisionRecoveries.leaseExpiresAt, deferralNow)
                )
              )
              .for('update')
            if (!leasedRecovery) throw new Error('SANDBOX_RECOVERY_FENCE_LOST')
            const timing = computeProvisionRecoveryTiming({
              executionId: this.id,
              generation: leasedRecovery.generation,
              attemptCount: leasedRecovery.attemptCount,
              retryAfterMs:
                outcome.retryAfterMs ??
                (outcome.nextAttemptAt
                  ? Math.max(0, outcome.nextAttemptAt.getTime() - deferralNow.getTime())
                  : undefined),
              now: deferralNow,
              deadlineAt: leasedRecovery.deadlineAt,
            })
            const [recovery] = await tx
              .update(sandboxProvisionRecoveries)
              .set({
                status: 'waiting',
                nextAttemptAt: timing.nextAttemptAt,
                leaseOwner: null,
                leaseExpiresAt: null,
                claimKind: null,
                updatedAt: deferralNow,
              })
              .where(
                and(
                  eq(sandboxProvisionRecoveries.executionId, this.id),
                  eq(sandboxProvisionRecoveries.generation, outcome.generation),
                  eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner)
                )
              )
              .returning()
            if (!recovery) throw new Error('SANDBOX_RECOVERY_FENCE_LOST')
            row = waiting
          } else if (outcome.kind === 'sandbox-recovery-exhausted' || outcome.kind === 'sandbox-recovery-cancelled') {
            const exhausted = outcome.kind === 'sandbox-recovery-exhausted'
            const [terminal] = await tx
              .update(executions)
              .set(
                exhausted
                  ? {
                      status: 'failed',
                      endedAt: databaseClockNow(),
                      error: outcomeError,
                      failureClass: SANDBOX_RECOVERY_EXHAUSTED_FAILURE.failureClass,
                      failureReason: SANDBOX_RECOVERY_EXHAUSTED_FAILURE.failureReason,
                    }
                  : { status: 'stopped', endedAt: databaseClockNow() }
              )
              .where(and(eq(executions.id, this.id), eq(executions.status, 'waiting-sandbox')))
              .returning()
            if (!terminal) return null
            const [recovery] = await tx
              .update(sandboxProvisionRecoveries)
              .set({
                status: exhausted ? 'exhausted' : 'cancelled',
                leaseOwner: null,
                leaseExpiresAt: null,
                claimKind: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(sandboxProvisionRecoveries.executionId, this.id),
                  eq(sandboxProvisionRecoveries.generation, outcome.generation),
                  eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner),
                  eq(sandboxProvisionRecoveries.status, 'leased')
                )
              )
              .returning()
            if (!recovery) throw new Error('SANDBOX_RECOVERY_FENCE_LOST')
            row = terminal
          } else if (outcome.kind === 'started') {
            // Pre-claim guard, BEFORE the CAS and inside this transaction, so any
            // row lock it takes (e.g. the migration fence's machine_boxes FOR
            // UPDATE) is held through this claim's commit. Refusal writes nothing;
            // the empty transaction just commits.
            if (options?.startGuard && !(await options.startGuard(tx))) return GUARD_REFUSED

            // CAS as the first statement: if another worker already claimed it,
            // nothing is written (execution or agent) and we bail out below.
            const [claimed] = await tx
              .update(executions)
              .set({
                status: 'running',
                maintenanceGeneration: null,
                maintenanceQueuedAt: null,
                runnerClaimToken: crypto.randomUUID(),
                runnerClaimGeneration: maintenanceStore.cachedGeneration(),
                runStartedAt: sql`clock_timestamp()`,
                executionVersion: sql`${executions.executionVersion} + 1`,
                startupRetryAt: null,
              })
              .where(
                and(
                  eq(executions.id, this.id),
                  eq(executions.status, 'queued'),
                  sql`(${executions.startupRetryAt} IS NULL OR ${executions.startupRetryAt} <= clock_timestamp())`
                )
              )
              .returning()
            if (!claimed) return null
            await options?.afterStarted?.(tx, claimed)
            row = claimed
          } else {
            const set: ExecutionTerminalUpdate = (() => {
              switch (outcome.kind) {
                case 'completed':
                  return { status: 'completed', endedAt: databaseClockNow(), usage: outcome.usage ?? null }
                case 'failed':
                  return {
                    status: 'failed',
                    endedAt: databaseClockNow(),
                    error: outcomeError,
                    failureClass: outcome.failure?.failureClass ?? null,
                    failureReason: outcome.failure?.failureReason ?? null,
                  }
                case 'stopped':
                  return { status: 'stopped', endedAt: databaseClockNow() }
                case 'force-stopped':
                  return { status: 'failed', endedAt: databaseClockNow(), error: forceStopReason }
                case 'superseded':
                  return { status: 'completed', endedAt: databaseClockNow() }
                case 'requeued':
                  return { status: 'queued', imageIds: outcome.imageIds ?? this.imageIds }
              }
            })()

            const executionPredicates = [eq(executions.id, this.id)]
            const startupRetry = outcome.kind === 'requeued' && outcome.startupRetryDelayMs !== undefined
            if (startupRetry) {
              executionPredicates.push(
                eq(executions.status, 'running'),
                eq(executions.executionVersion, this.executionVersion),
                sql`${executions.startupRetryCount} < ${STARTUP_RETRY_DELAYS_MS.length}`
              )
            }
            if (options?.admissionLease) {
              executionPredicates.push(
                eq(executions.runnerClaimToken, options.admissionLease.token),
                eq(executions.runnerClaimGeneration, options.admissionLease.generation)
              )
            }
            const [updated] = await tx
              .update(executions)
              .set({
                ...set,
                maintenanceGeneration: null,
                maintenanceQueuedAt: null,
                ...(startupRetry
                  ? {
                      startupRetryCount: sql`${executions.startupRetryCount} + 1`,
                      startupRetryAt: sql`clock_timestamp() + ${outcome.startupRetryDelayMs!} * interval '1 millisecond'`,
                    }
                  : {}),
              })
              .where(and(...executionPredicates))
              .returning()
            if (!updated) {
              if (options?.admissionLease || startupRetry) return null
              throw new Error(`Execution ${this.id} not found`)
            }
            row = updated
            await options?.afterExecutionLocked?.(tx, updated)
          }

          if (outcome.kind === 'requeued') {
            const lease = options?.admissionLease
            if (
              !(await restoreQueueOwnedAdmission(tx, {
                agentId: row.agentId,
                executionId: row.id,
                ...(lease
                  ? {
                      expectedLease: {
                        token: lease.token,
                        claimEpoch: lease.claimEpoch,
                        ownerId: lease.ownerId,
                        ownerIncarnation: lease.ownerIncarnation,
                        admittedGeneration: lease.generation,
                        admittedHolderRevision: lease.holderRevision,
                      },
                    }
                  : {}),
              }))
            )
              throw new Error('ADMISSION_RESERVATION_FENCE_LOST')
          }

          if (['completed', 'failed', 'stopped', 'force-stopped', 'superseded'].includes(outcome.kind)) {
            if (options?.admissionLease) {
              if (
                !(await settleExactAdmissionLease(tx, options.admissionLease, 'released')) &&
                !(await isExactAdmissionLeaseTerminal(tx, options.admissionLease))
              )
                throw new Error('ADMISSION_RESERVATION_FENCE_LOST')
            } else {
              const [currentReservation] = await tx
                .select()
                .from(executionAdmissionReservations)
                .where(eq(executionAdmissionReservations.executionId, this.id))
                .for('update')
              if (currentReservation && !['released', 'revoked'].includes(currentReservation.state)) {
                if (['queued', 'waiting-maintenance'].includes(currentReservation.state)) {
                  const [released] = await tx
                    .update(executionAdmissionReservations)
                    .set({ state: 'released', updatedAt: new Date() })
                    .where(
                      and(
                        eq(executionAdmissionReservations.executionId, this.id),
                        eq(executionAdmissionReservations.state, currentReservation.state)
                      )
                    )
                    .returning({ executionId: executionAdmissionReservations.executionId })
                  if (!released) throw new Error('ADMISSION_RESERVATION_FENCE_LOST')
                } else {
                  const { token, claimEpoch, admittedGeneration, admittedHolderRevision, ownerId, ownerIncarnation } =
                    currentReservation
                  if (
                    token === null ||
                    claimEpoch === null ||
                    admittedGeneration === null ||
                    admittedHolderRevision === null ||
                    ownerId === null ||
                    ownerIncarnation === null
                  )
                    throw new Error('ADMISSION_RESERVATION_IDENTITY_INCOMPLETE')
                  const currentLease: AdmissionLease = {
                    executionId: currentReservation.executionId,
                    token,
                    claimEpoch,
                    generation: admittedGeneration,
                    holderRevision: admittedHolderRevision,
                    ownerId,
                    ownerIncarnation,
                  }
                  if (!(await settleExactAdmissionLease(tx, currentLease, 'released')))
                    throw new Error('ADMISSION_RESERVATION_FENCE_LOST')
                }
              }
            }
            await tx
              .update(sandboxProvisionRecoveries)
              .set({
                status: 'cancelled',
                leaseOwner: null,
                leaseExpiresAt: null,
                claimKind: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(sandboxProvisionRecoveries.executionId, this.id),
                  inArray(sandboxProvisionRecoveries.status, ['waiting', 'leased'])
                )
              )
          }

          if (disposition) {
            await tx
              .update(agents)
              .set({
                status: disposition.status,
                ...(disposition.questionData !== undefined ? { questionData: disposition.questionData } : {}),
                updatedAt: new Date(),
              })
              .where(eq(agents.id, this.agentId))
          }

          return row
        }
      )
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'SANDBOX_RECOVERY_FENCE_LOST',
          'SANDBOX_RECOVERY_ADMISSION_REPAIR_LOST',
          'ADMISSION_RESERVATION_FENCE_LOST',
        ].includes(error.message)
      )
        return false
      throw error
    }

    if (result === null || result === GUARD_REFUSED) return false
    if (result === IDEMPOTENT_SUCCESS) {
      await this.reload()
      await releaseProviderSlot(this.id)
      return true
    }

    Object.assign(this, result)

    const payload = { executionId: this.id, agentId: this.agentId, status: this.status }

    if (outcome.kind === 'started') {
      eventEmitter.emit('execution.started', payload)
    } else {
      eventEmitter.emit('execution.updated', payload)
      if (outcome.kind === 'completed' || outcome.kind === 'superseded') {
        eventEmitter.emit('execution.completed', payload)
      } else if (outcome.kind === 'failed' || outcome.kind === 'force-stopped') {
        eventEmitter.emit(
          'execution.failed',
          // Additive fields: listeners that predate classification ignore them.
          // force-stopped stays unclassified (NULL), surfacing as legacy execution_failure.
          {
            ...payload,
            ...(this.failureClass ? { failureClass: this.failureClass } : {}),
            ...(this.failureReason ? { failureReason: this.failureReason } : {}),
          }
        )
      } else if (outcome.kind === 'stopped' || outcome.kind === 'sandbox-recovery-cancelled') {
        eventEmitter.emit('execution.stopped', payload)
      } else if (outcome.kind === 'sandbox-recovery-exhausted') {
        eventEmitter.emit(
          'execution.failed',
          // Additive fields: listeners that predate classification ignore them.
          {
            ...payload,
            failureClass: SANDBOX_RECOVERY_EXHAUSTED_FAILURE.failureClass,
            failureReason: SANDBOX_RECOVERY_EXHAUSTED_FAILURE.failureReason,
          }
        )
      } else if ((outcome.kind === 'requeued' || outcome.kind === 'sandbox-recovered') && previousStatus !== 'queued') {
        eventEmitter.emit('execution.queued', payload)
      }
    }

    // Failure system message, recorded post-commit but BEFORE the agent
    // write's events — matches today's user-visible ordering (the message
    // was always recorded before the agent status write completed).
    if (outcome.kind === 'failed' && route!.systemMessage) {
      const agent = await this.mustGetAgent()
      await agent.recordMessage({ role: 'assistant', content: route!.systemMessage }).catch(() => {})
    }

    if (disposition) {
      const { finishAgentWrite } = await import('./Agent')
      const updatedAgent = await finishAgentWrite(this.agentId, agentBefore!, { status: disposition.status })
      // Mirror Agent.prototype.update's Object.assign(this, ...): callers holding
      // the cached agent relation (e.g. via mustGetAgent/execution.agent) must see
      // the write reflected in-place, same as before this raw tx write bypassed
      // the Agent entity's own update() path.
      if (this._agent) Object.assign(this._agent, updatedAgent)
    }

    if (SLOT_RELEASING_KINDS.has(outcome.kind)) await releaseProviderSlot(this.id)

    return true
  }

  /**
   * Start this execution (queued → running, agent → active).
   * Test convenience only; production pickup additionally supplies the box
   * migration guard. The global maintenance fence is still authoritative here
   * so no claim path can bypass an acquired instance pause.
   */
  async start(): Promise<boolean> {
    const { maintenanceStore } = await import('../services/maintenance')
    return this.transitionTo(
      { kind: 'started' },
      {
        startGuard: async (tx) =>
          !(await maintenanceStore.isPausedLocked(tx as Parameters<typeof maintenanceStore.isPausedLocked>[0])),
      }
    )
  }

  /**
   * Complete this execution (running → completed, agent → idle).
   */
  async complete(usage?: SessionUsage, admissionLease?: AdmissionLease): Promise<void> {
    await this.transitionTo({ kind: 'completed', usage }, { admissionLease })
  }

  /**
   * Fail this execution (→ failed, agent → idle or waiting-input for rate limits
   * or all-providers-exhausted). `failure` is the structural classification
   * from the failure site; absent it stays NULL (legacy/unclassified).
   */
  async fail(error: string, admissionLease?: AdmissionLease, failure?: ExecutionFailure): Promise<boolean> {
    return this.transitionTo({ kind: 'failed', error, ...(failure ? { failure } : {}) }, { admissionLease })
  }

  /** Only called before runner startup has dispatched a model prompt. */
  async retryStartupFailure(error: unknown, admissionLease?: AdmissionLease): Promise<boolean> {
    const code = startupRetryCode(error)
    const delayMs = STARTUP_RETRY_DELAYS_MS[this.startupRetryCount]
    if (!code || delayMs === undefined) return false
    const requeued = await this.transitionTo({ kind: 'requeued', startupRetryDelayMs: delayMs }, { admissionLease })
    if (!requeued) return false
    log.warn('Retrying execution startup after a transient database failure', {
      executionId: this.id,
      agentId: this.agentId,
      code,
      attempt: this.startupRetryCount,
      maxRetries: STARTUP_RETRY_DELAYS_MS.length,
      retryAt: this.startupRetryAt?.toISOString(),
    })
    return true
  }

  /**
   * Stop this execution (→ stopped, agent → idle).
   */
  async stop(admissionLease?: AdmissionLease): Promise<void> {
    await this.transitionTo({ kind: 'stopped' }, { admissionLease })
  }

  /**
   * Request stop (running → stopping). Worker will call stop() when ready.
   * Internal method - use requestStopWithSignal() from routes.
   */
  private async requestStop(): Promise<void> {
    await this.update({ status: 'stopping' })
  }

  /**
   * Abort the currently running bash command without stopping the execution.
   * Returns false if execution is not running.
   */
  async abortToolWithSignal(): Promise<boolean> {
    if (this.status !== 'running') return false

    const { notify } = await import('../lib/infra/local-events')
    await notify('agent_control', JSON.stringify({ action: 'abort-tool', agentId: this.agentId }))
    return true
  }

  /**
   * Stop an execution. Handles queued and running states.
   * Returns false if execution cannot be stopped.
   */
  async requestStopWithSignal(): Promise<boolean> {
    if (!isActiveExecutionStatus(this.status)) {
      return false
    }

    if (this.status === 'queued' || this.status === 'waiting-maintenance' || this.status === 'waiting-sandbox') {
      // Directly stop — no active session to notify
      await this.stop()
      return true
    }

    if (this.status === 'running') {
      await this.requestStop()
    }

    const { notify } = await import('../lib/infra/local-events')
    await notify('agent_control', JSON.stringify({ action: 'stop', agentId: this.agentId, executionId: this.id }))
    return true
  }

  /**
   * Supersede this execution (marks as completed when being replaced by a new execution).
   * Used when a waiting-input agent receives a new message that starts a fresh execution.
   * Does NOT update agent status (caller handles that separately).
   */
  async supersede(): Promise<void> {
    await this.transitionTo({ kind: 'superseded' })
  }

  /**
   * Force-stop this execution. Used to recover from stuck transitional states
   * (stopping) when the worker is unresponsive or has crashed.
   * Also works on running/queued executions as a last resort.
   * Sets status to 'failed' with an appropriate error message.
   */
  async forceStop(reason?: string): Promise<void> {
    await this.transitionTo({ kind: 'force-stopped', reason })
  }

  /**
   * Requeue this execution (→ queued).
   * Does NOT update agent status (caller handles that separately).
   * @param imageIds - Optional image IDs to merge into the execution.
   * TODO: why does this take imageIds?
   */
  async requeue(imageIds?: string[] | null, admissionLease?: AdmissionLease): Promise<void> {
    await this.transitionTo({ kind: 'requeued', imageIds }, { admissionLease })
  }

  /**
   * Park queued/running work only while this authoritative generation remains effective.
   * Lock hierarchy: maintenance -> execution -> admission reservation. Any path
   * acquiring both execution and reservation rows must keep this order.
   */
  async parkForMaintenance(
    generation: number,
    options?: { afterExecutionLocked?: (tx: TransactionHandle) => Promise<void> }
  ): Promise<boolean> {
    const updated = await db.transaction(async (tx) => {
      const locked = await maintenanceStore.readLocked(tx)
      if (!locked.state.effective || locked.state.generation !== generation) return undefined
      const [current] = await tx.select().from(executions).where(eq(executions.id, this.id)).for('update')
      if (!current) return undefined
      await options?.afterExecutionLocked?.(tx)
      const [reservation] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, this.id))
        .for('update')
      const [row] = await tx
        .update(executions)
        .set({
          status: 'waiting-maintenance',
          maintenanceGeneration: generation,
          maintenanceQueuedAt: locked.databaseNow,
          runnerClaimToken: null,
          runnerClaimGeneration: null,
          executionVersion: sql`${executions.executionVersion} + 1`,
        })
        .where(and(eq(executions.id, this.id), inArray(executions.status, ['queued', 'running'])))
        .returning()
      if (row) {
        if (reservation && !['released', 'revoked'].includes(reservation.state)) {
          const identityPredicates = ['queued', 'waiting-maintenance'].includes(reservation.state)
            ? [eq(executionAdmissionReservations.state, reservation.state)]
            : reservation.token !== null && reservation.claimEpoch !== null
              ? [
                  eq(executionAdmissionReservations.token, reservation.token),
                  eq(executionAdmissionReservations.claimEpoch, reservation.claimEpoch),
                ]
              : null
          if (!identityPredicates) throw new Error('ADMISSION_RESERVATION_IDENTITY_INCOMPLETE')
          const [revoked] = await tx
            .update(executionAdmissionReservations)
            .set({
              state: 'revoked',
              phase: 'none',
              operationId: null,
              resourceKey: null,
              updatedAt: locked.databaseNow,
            })
            .where(and(eq(executionAdmissionReservations.executionId, this.id), ...identityPredicates))
            .returning({ executionId: executionAdmissionReservations.executionId })
          if (!revoked) throw new Error('ADMISSION_RESERVATION_FENCE_LOST')
        }
        return row
      }
      const [duplicate] = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.id, this.id),
            eq(executions.status, 'waiting-maintenance'),
            eq(executions.maintenanceGeneration, generation)
          )
        )
      return duplicate
    })
    if (!updated) return false
    Object.assign(this, new Execution(updated))
    const { concurrencyLimiter } = await import('../services/execution/concurrency-limiter-instance')
    concurrencyLimiter.release(this.id)
    eventEmitter.emit('execution.updated', {
      executionId: this.id,
      agentId: this.agentId,
      status: 'waiting-maintenance',
    })
    return true
  }

  /** Backward-compatible controller entry point, now durably parks instead of requeueing. */
  async requeueIfRunningForMaintenance(
    _generationGuard?: (tx: TransactionHandle) => Promise<boolean>
  ): Promise<boolean> {
    const generation = maintenanceStore.cachedGeneration()
    return this.parkForMaintenance(generation)
  }

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  /**
   * Run this execution.
   * This is the main entry point called by the worker, exclusively via
   * `services/execution/pickup.ts`'s `attemptPickup`, which has already won
   * the queued→running CAS (via `transitionTo`) before calling this — so,
   * unlike before B2, `run()` no longer attempts its own `start()`/CAS.
   * Requires the agent relation to be loaded (via setAgent or mustGetAgent).
   */
  async run(): Promise<void> {
    const { reserveSession, removeSession } = await import('../services/execution/session-state')

    if (!reserveSession(this.agentId, this.id)) {
      log.info(`Execution ${this.id} skipped because agent ${this.agentId} already has active capacity`)
      if (this.runnerClaimToken && this.runnerClaimGeneration !== null) {
        const [{ AdmissionReservationStore }, { admissionProcessIncarnation }] = await Promise.all([
          import('../services/maintenance/admission-reservation'),
          import('../services/maintenance/process-liveness'),
        ])
        await new AdmissionReservationStore('worker', admissionProcessIncarnation).revokeProvisionalClaim(
          this.id,
          this.runnerClaimToken,
          this.runnerClaimGeneration
        )
      }
      await this.fail('Execution session capacity reservation was refused', undefined, CAPACITY_REFUSAL_FAILURE)
      return
    }

    const agent = await this.mustGetAgent()

    try {
      // Ensure agent type is loaded
      await agent.mustGetAgentType()
      const { startRunnerTiming, logRunnerMilestone } = await import('../services/execution/runner-timing')
      const timing = startRunnerTiming({
        executionId: this.id,
        agentId: this.agentId,
        runnerType: safeRunnerTypeForTiming(agent),
      })
      logRunnerMilestone(timing, 'started')

      let runnerCreated = false
      try {
        // Dynamic import to avoid circular dependency
        const { createRunner } = await import('./agent-runners')
        const runner = await createRunner(agent, this)
        runnerCreated = true
        ;(runner as { _timing?: typeof timing })._timing = timing
        await runner.run()
      } catch (err) {
        const { MaintenanceAdmissionPaused } = await import('../services/maintenance/admission')
        if (err instanceof MaintenanceAdmissionPaused) {
          removeSession(this.agentId)
          await this.parkForMaintenance(err.generation)
          const { streamManager } = await import('../services/streaming/buffer')
          let buffer = streamManager.get(this.id)
          if (!buffer) buffer = streamManager.create(this.id)
          buffer.push({ type: 'execution_phase', phase: 'maintenance_queue' })
          buffer.close()
          return
        }
        const { getProvisionRecoveryDisposition } = await import('../services/sandbox/k8s/provision-failure')
        const { isSessionActive } = await import('../services/execution/session-state')
        const recoveryDisposition = getProvisionRecoveryDisposition(err)
        if (recoveryDisposition && !isSessionActive(this.agentId)) {
          removeSession(this.agentId)
          const now = Date.now()
          try {
            const suspended = await this.transitionTo({
              kind: 'waiting-sandbox',
              recovery: {
                ...recoveryDisposition.provision,
                errorCode: recoveryDisposition.errorCode,
                retryAfterMs: recoveryDisposition.retryAfterMs,
                now: new Date(now),
              },
            })
            const { streamManager } = await import('../services/streaming/buffer')
            let buffer = streamManager.get(this.id)
            if (!buffer) buffer = streamManager.create(this.id)
            if (suspended) {
              await this.reload()
              if (this.status === 'waiting-sandbox') {
                buffer.push({ type: 'execution_phase', phase: 'sandbox_recovery_wait' })
                buffer.close()
              } else if (this.isTerminal) {
                buffer.close()
              }
            } else {
              await this.reload()
              if (this.isTerminal) buffer.close()
            }
          } catch (suspensionError) {
            log.warn('Failed to persist sandbox recovery wait', {
              executionId: this.id,
              agentId: this.agentId,
              code: recoveryDisposition.errorCode,
              errorName: suspensionError instanceof Error ? suspensionError.name : 'Error',
            })
          }
          return
        }

        const errorMsg = err instanceof Error ? err.message : String(err)
        removeSession(this.agentId)
        const admissionLease = admissionLeaseFromError(err)
        const failedVersion = this.executionVersion
        const startupFailure = !runnerCreated || isExecutionStartupFailure(err)
        if (startupFailure && (await this.retryStartupFailure(err, admissionLease))) {
          const { streamManager } = await import('../services/streaming/buffer')
          const buffer = streamManager.get(this.id)
          buffer?.push({
            type: 'system_message',
            text: 'Execution startup hit a temporary database connection failure and has been queued for retry.',
          })
          buffer?.close()
          return
        }
        if (startupFailure && startupRetryCode(err)) {
          await this.reload()
          // A stop or newer pickup can win while startup unwinds. Exhausting
          // a retry budget must not terminalize that newer state.
          if (this.status !== 'running' || this.executionVersion !== failedVersion) return
        }
        log.error(`Failed to spawn session for execution ${this.id}:`, err)

        // Push the error to the SSE stream so the frontend shows it instead of hanging.
        const { streamManager } = await import('../services/streaming/buffer')
        let buffer = streamManager.get(this.id)
        if (!buffer) buffer = streamManager.create(this.id)
        buffer.push({ type: 'error', message: errorMsg })
        buffer.fail()

        removeSession(this.agentId)
        const terminalized = await this.fail(errorMsg, admissionLease, classifySetupFailure(err))
        if (admissionLease && !terminalized) throw err
      }
    } catch (err) {
      removeSession(this.agentId)
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error(`Failed to run agent (${agent.id}) execution ${this.id}:`, err)
      if (admissionLeaseFromError(err)) throw err
      await this.fail(errorMsg, undefined, classifySetupFailure(err))
    }
  }
}
