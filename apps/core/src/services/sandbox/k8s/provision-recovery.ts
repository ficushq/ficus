import { isLiveAgentStatus } from '@ficus/shared'
import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db as defaultDb } from '../../../db'
import {
  agents,
  executions,
  k8sProvisionControls,
  sandboxProvisionRecoveries,
  squads,
  workStreams,
} from '../../../db/schema'
import { Execution } from '../../../entities/Execution'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { createLogger } from '../../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { isK8sRuntime } from '../runtime'
import { PostgresProvisionStore } from './provision-store'
import {
  computeProvisionRecoveryTiming,
  PostgresProvisionRecoveryStore,
  PROVISION_RECOVERY_MAX_ATTEMPTS,
  type ProvisionRecoveryLease,
} from './provision-recovery-store'

const EXHAUSTED_MESSAGE = 'Sandbox capacity did not recover before the retry deadline.'
/**
 * Timer interval for the recovery backstop.
 *
 * The reconcile is EVENT-driven first: every provisioning breaker transition
 * emits `sandbox.provision-transition`, which reconciles immediately (see the
 * subscription in {@link startSandboxProvisionRecovery}). The timer only bounds
 * how long a MISSED event (or a lease whose retry deadline simply came due)
 * can linger, so it does not need to be tight — at 5s it was ≥3 unconditional
 * queries every 5s on every tenant, k8s or not.
 */
const RECONCILE_INTERVAL_MS = 30_000
const log = createLogger('sandbox-provision-recovery')
const PERMANENT_CONTROL_REASONS = new Set(['cluster_authorization'])
type Database = typeof defaultDb

let recoveryRunner: PeriodicRunner | null = null
let recoveryService: SandboxProvisionRecoveryService | null = null
let unsubscribeTransition: (() => void) | null = null

export function startSandboxProvisionRecovery(): void {
  if (recoveryRunner) return
  recoveryService = new SandboxProvisionRecoveryService({
    ownerId: `sandbox-provision-recovery-${process.pid}-${randomUUID()}`,
  })
  recoveryRunner = createPeriodicRunner({
    name: 'sandbox-provision-recovery',
    intervalMs: RECONCILE_INTERVAL_MS,
    runImmediately: true,
    // Every row this reconcile touches is written by the k8s provisioning
    // path (k8s_provision_controls / sandbox_provision_recoveries), so on a
    // vm/docker runtime the tick can only ever read empty tables. Skip its DB
    // work entirely rather than paying for it on every non-k8s tenant. The
    // transition-hint subscription below is unaffected: only k8s code emits it.
    task: async () => {
      if (!isK8sRuntime()) return
      await recoveryService!.reconcileOnce()
    },
  })
  unsubscribeTransition = eventEmitter.on('sandbox.provision-transition', () => {
    void recoveryService?.reconcileOnce()
  })
  recoveryRunner.start()
}

export async function stopSandboxProvisionRecovery(): Promise<void> {
  unsubscribeTransition?.()
  unsubscribeTransition = null
  if (recoveryRunner) await recoveryRunner.stop()
  recoveryRunner = null
  recoveryService = null
}

export async function getSandboxProvisionRecoveryDiagnostics() {
  if (recoveryService) return recoveryService.getDiagnostics()
  return SandboxProvisionRecoveryService.readDiagnostics(defaultDb, {
    claimed: 0,
    resumed: 0,
    postponed: 0,
    cancelled: 0,
    exhausted: 0,
    leaseLost: 0,
    errors: 0,
  })
}

export class SandboxProvisionRecoveryService {
  private readonly db: Database
  private readonly store: PostgresProvisionRecoveryStore
  private readonly provisionStore: PostgresProvisionStore
  private inFlight: Promise<void> | null = null
  private readonly counters = {
    claimed: 0,
    resumed: 0,
    postponed: 0,
    cancelled: 0,
    exhausted: 0,
    leaseLost: 0,
    errors: 0,
  }

  constructor(
    private readonly options: {
      ownerId: string
      db?: Database
      store?: PostgresProvisionRecoveryStore
      provisionStore?: PostgresProvisionStore
      testHooks?: { beforeProcessLease?: (lease: ProvisionRecoveryLease) => Promise<void> | void }
    }
  ) {
    this.db = options.db ?? defaultDb
    this.store = options.store ?? new PostgresProvisionRecoveryStore(this.db)
    this.provisionStore = options.provisionStore ?? new PostgresProvisionStore({ db: this.db })
  }

  reconcileOnce(now: Date = new Date()): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.reconcile(now).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async reconcile(now: Date): Promise<void> {
    const halfOpenScopes = await this.db
      .select({ scope: k8sProvisionControls.scope })
      .from(k8sProvisionControls)
      .where(eq(k8sProvisionControls.state, 'half_open'))
    for (const { scope } of halfOpenScopes) {
      const transition = await this.provisionStore.reconcileExpiredHalfOpenProbe(scope, now)
      if (transition) {
        log.warn('Kubernetes provisioning breaker transition', { scopeHash: scope, ...transition })
        eventEmitter.emit('sandbox.provision-transition', {
          scopeHash: scope,
          from: transition.from,
          to: transition.to,
          version: transition.version,
          reasonCode: transition.reasonCode,
          retryAfterMs: transition.retryAfterMs,
        })
      }
    }
    await this.reconcileProbeReservations(now)
    const leases = await this.store.claimDue(this.options.ownerId, now)
    this.counters.claimed += leases.length
    await Promise.all(
      leases.map(async (lease) => {
        try {
          await this.options.testHooks?.beforeProcessLease?.(lease)
          await this.processLease(lease, now)
        } catch (error) {
          this.counters.errors++
          log.warn('Sandbox recovery lease processing failed', {
            executionId: lease.executionId,
            generation: lease.generation,
            outcome: 'retry',
            errorName: error instanceof Error ? error.name : 'Error',
          })
          const timing = computeProvisionRecoveryTiming({
            executionId: lease.executionId,
            generation: lease.generation,
            attemptCount: lease.attemptCount,
            now,
            deadlineAt: lease.deadlineAt,
          })
          if (await this.store.releaseLease(lease, timing.nextAttemptAt, now)) this.counters.postponed++
          else this.counters.leaseLost++
        }
      })
    )
  }

  private async processLease(lease: ProvisionRecoveryLease, now: Date): Promise<void> {
    const [executionRow] = await this.db.select().from(executions).where(eq(executions.id, lease.executionId))
    if (!executionRow) return this.cancelLease(lease)
    const execution = new Execution(executionRow)

    if (lease.deadlineAt <= now || lease.attemptCount >= PROVISION_RECOVERY_MAX_ATTEMPTS) {
      const exhausted = await execution.transitionTo({
        kind: 'sandbox-recovery-exhausted',
        generation: lease.generation,
        leaseOwner: lease.leaseOwner,
        error: EXHAUSTED_MESSAGE,
      })
      if (exhausted) this.counters.exhausted++
      else this.counters.leaseLost++
      return
    }

    const [agent] = await this.db.select().from(agents).where(eq(agents.id, lease.agentId))
    const permanentlyIneligible =
      !agent ||
      !isLiveAgentStatus(agent.status) ||
      agent.pendingDormancyAt ||
      executionRow.status !== 'waiting-sandbox' ||
      !(await this.isSquadEligible(agent.squadId)) ||
      !(await this.isWorkStreamEligible(lease.workStreamId, lease.agentId))
    if (permanentlyIneligible) {
      if (executionRow.status === 'waiting-sandbox') {
        const cancelled = await execution.transitionTo({
          kind: 'sandbox-recovery-cancelled',
          generation: lease.generation,
          leaseOwner: lease.leaseOwner,
        })
        if (cancelled) this.counters.cancelled++
        else this.counters.leaseLost++
      } else {
        await this.cancelLease(lease)
      }
      return
    }

    const control = await this.getControl(lease.scope)
    if (control?.reasonCode && PERMANENT_CONTROL_REASONS.has(control.reasonCode)) {
      const exhausted = await execution.transitionTo({
        kind: 'sandbox-recovery-exhausted',
        generation: lease.generation,
        leaseOwner: lease.leaseOwner,
        error: 'Sandbox provisioning requires operator authorization.',
      })
      if (exhausted) this.counters.exhausted++
      else this.counters.leaseLost++
      return
    }
    const controlEligible =
      control &&
      (lease.claimKind === 'ordinary'
        ? control.state === 'closed'
        : control.state === 'open' && Boolean(control.retryAt && control.retryAt <= now))
    if (!controlEligible) {
      const retryAfterMs = control?.retryAt ? Math.max(0, control.retryAt.getTime() - now.getTime()) : 5_000
      const timing = computeProvisionRecoveryTiming({
        executionId: lease.executionId,
        generation: lease.generation,
        attemptCount: lease.attemptCount,
        retryAfterMs,
        now,
        deadlineAt: lease.deadlineAt,
      })
      if (await this.store.releaseLease(lease, timing.nextAttemptAt, now)) this.counters.postponed++
      else this.counters.leaseLost++
      return
    }

    const resumed = await execution.transitionTo({
      kind: 'sandbox-recovered',
      generation: lease.generation,
      leaseOwner: lease.leaseOwner,
      claimKind: lease.claimKind,
    })
    if (resumed) {
      this.counters.resumed++
      return
    }

    const timing = computeProvisionRecoveryTiming({
      executionId: lease.executionId,
      generation: lease.generation,
      attemptCount: lease.attemptCount,
      now,
      deadlineAt: lease.deadlineAt,
    })
    if (await this.store.releaseLease(lease, timing.nextAttemptAt, now)) this.counters.postponed++
    else this.counters.leaseLost++
  }

  async getDiagnostics() {
    return SandboxProvisionRecoveryService.readDiagnostics(this.db, this.counters)
  }

  static async readDiagnostics(db: Database, counters: Record<string, number>) {
    const [counts] = (await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
        COUNT(*) FILTER (WHERE status = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE status = 'exhausted')::int AS exhausted,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'waiting'))) * 1000, 0)::bigint AS oldest_age_ms
      FROM sandbox_provision_recoveries
    `)) as unknown as Array<{ waiting: number; leased: number; exhausted: number; oldest_age_ms: string | number }>
    return {
      recoveryWaiting: Number(counts?.waiting ?? 0),
      recoveryLeased: Number(counts?.leased ?? 0),
      recoveryExhausted: Number(counts?.exhausted ?? 0),
      recoveryOldestAgeMs: Number(counts?.oldest_age_ms ?? 0),
      recoveryCounters: { ...counters },
    }
  }

  private async isSquadEligible(squadId: string | null): Promise<boolean> {
    if (!squadId) return true
    const [squad] = await this.db.select({ status: squads.status }).from(squads).where(eq(squads.id, squadId))
    return squad?.status === 'active'
  }

  private async isWorkStreamEligible(workStreamId: string | null, agentId: string): Promise<boolean> {
    if (!workStreamId) return true
    const [workStream] = await this.db
      .select({ status: workStreams.status, assigneeAgentId: workStreams.assigneeAgentId })
      .from(workStreams)
      .where(eq(workStreams.id, workStreamId))
    return workStream?.status === 'active' && workStream.assigneeAgentId === agentId
  }

  private async getControl(scope: string) {
    const [control] = await this.db.select().from(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scope))
    return control
  }

  private async cancelLease(lease: ProvisionRecoveryLease): Promise<void> {
    await this.db
      .update(sandboxProvisionRecoveries)
      .set({ status: 'cancelled', leaseOwner: null, leaseExpiresAt: null, claimKind: null, updatedAt: new Date() })
      .where(
        and(
          eq(sandboxProvisionRecoveries.executionId, lease.executionId),
          eq(sandboxProvisionRecoveries.generation, lease.generation),
          eq(sandboxProvisionRecoveries.leaseOwner, lease.leaseOwner),
          eq(sandboxProvisionRecoveries.status, 'leased')
        )
      )
  }

  private async reconcileProbeReservations(now: Date): Promise<void> {
    const probes = await this.db
      .select({ recovery: sandboxProvisionRecoveries, control: k8sProvisionControls })
      .from(sandboxProvisionRecoveries)
      .innerJoin(k8sProvisionControls, eq(k8sProvisionControls.scope, sandboxProvisionRecoveries.scope))
      .where(
        and(
          eq(sandboxProvisionRecoveries.status, 'leased'),
          eq(sandboxProvisionRecoveries.claimKind, 'half_open_probe')
        )
      )

    for (const { recovery, control } of probes) {
      if (control.state === 'closed') {
        await this.db
          .update(sandboxProvisionRecoveries)
          .set({ status: 'resumed', leaseOwner: null, leaseExpiresAt: null, claimKind: null, updatedAt: now })
          .where(
            and(
              eq(sandboxProvisionRecoveries.executionId, recovery.executionId),
              eq(sandboxProvisionRecoveries.generation, recovery.generation),
              eq(sandboxProvisionRecoveries.status, 'leased'),
              eq(sandboxProvisionRecoveries.claimKind, 'half_open_probe')
            )
          )
      } else if (control.state === 'open' && recovery.leaseExpiresAt && recovery.leaseExpiresAt <= now) {
        const execution = await Execution.find(recovery.executionId)
        if (execution) {
          await execution.transitionTo({
            kind: 'sandbox-retry-deferred',
            generation: recovery.generation,
            leaseOwner: recovery.leaseOwner!,
            retryAfterMs: control.retryAt ? Math.max(0, control.retryAt.getTime() - now.getTime()) : undefined,
            now,
          })
        }
      }
    }
  }
}
