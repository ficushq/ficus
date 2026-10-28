import { AsyncLocalStorage } from 'node:async_hooks'
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { vmBoxProvisionAttempts as attempts, machineCapacityClaims } from '../../../db/schema'
import { MachineNotReadyError } from '../../machines/queries'
import { startupRetryCode } from '../../execution/startup-retry'
import { withVmSetupLease, type VmSetupLeaseWait } from './setup-state'

const physicalGeneration = new AsyncLocalStorage<number>()

/** The physical owner only; followers/health-only reconnects own no host lane. */
export function currentVmProvisionAttemptId(): number | undefined {
  return physicalGeneration.getStore()
}

type Attempt = typeof attempts.$inferSelect
const activeProvision = new AsyncLocalStorage<string>()
// More than the 15-minute acquisition budget. Do not delete a result a waiter
// still needs, even if newer requests have already created another generation.
const RESULT_RETENTION_MS = 60 * 60_000

export function provisionBackoffMs(failureCount: number): number {
  return Math.min(30_000 * 2 ** Math.min(Math.max(0, failureCount - 1), 5), 15 * 60_000)
}

/** Sanitized shared failure: remote stderr and configuration stay in the owner
 * log/error, never in this table or the follower's public error. */
export class VmProvisionFailedError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly attemptId: number,
    readonly retryAt: Date | null,
    cause?: Error
  ) {
    super(
      `Sandbox ${sandboxId} provision attempt ${attemptId} failed; retry after ${retryAt?.toISOString() ?? 'placement refresh'}`,
      cause ? { cause } : undefined
    )
    this.name = 'VmProvisionFailedError'
  }
}

async function latestAttempt(sandboxId: string): Promise<Attempt | undefined> {
  const [row] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.sandboxId, sandboxId))
    .orderBy(desc(attempts.id))
    .limit(1)
  return row
}

function sharedFailure(row: Attempt): never {
  const retryCode = row.failureClass?.split(':')[1]
  const cause = new Error('Shared physical provisioning failed')
  if (retryCode === 'box_port_busy') cause.name = 'BoxPortBusyError'
  else if (retryCode?.startsWith('machine_')) {
    cause.name = 'MachineNotReadyError'
    Object.assign(cause, { machineStatus: retryCode.slice('machine_'.length) })
  } else if (retryCode) Object.assign(cause, { code: retryCode })
  if (row.failureClass?.startsWith('placement')) {
    throw new MachineNotReadyError(
      'Machine stopped accepting binds during shared ensure',
      startupRetryCode(cause)?.startsWith('machine_') ? retryCode!.slice('machine_'.length) : undefined
    )
  }
  // Only the allowlisted structured startup code survives; never raw names,
  // messages or stderr. This preserves existing DB/machine/busy-port retries.
  throw new VmProvisionFailedError(row.sandboxId, row.id, row.retryAt, startupRetryCode(cause) ? cause : undefined)
}

/**
 * Cross-PROCESS single flight, not just a mutex. Snapshot before waiting for the
 * existing lifecycle lease, then consume that generation's immutable result.
 * The successful follower only attaches its own transport; it never provisions.
 *
 * Uses short main-pool queries and ONE existing direct-session setup lease. No
 * open DB transaction spans SSH, no pooled session advisory lock, and no second
 * dedicated connection is acquired inside the lease. Acquisition cancellation
 * never cancels another owner's callback. Once owned, await work/cleanup fully:
 * racing a callback timeout would release exclusion while SSH still mutates.
 */
export async function coalesceVmProvision<T>(
  sandboxId: string,
  provision: () => Promise<T>,
  join: () => Promise<T>,
  options: {
    wait?: VmSetupLeaseWait
    withLease?: (fn: (assertOwned?: () => void) => Promise<T>) => Promise<T>
  } = {}
): Promise<T> {
  const nested = activeProvision.getStore()
  if (nested) throw new Error(`Nested VM provisioning is not supported (${nested} -> ${sandboxId})`)
  options.wait?.signal?.throwIfAborted()
  const before = await latestAttempt(sandboxId)
  const withLease: NonNullable<typeof options.withLease> =
    options.withLease ?? ((fn) => withVmSetupLease(sandboxId, fn, options.wait))
  return withLease((assertOwned) =>
    activeProvision.run(sandboxId, async () => {
      // Join the observed running generation (or first since entry). Successful
      // results are immutable; stale failures defer to subsequent recovery.
      let [joined] = await db
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.sandboxId, sandboxId),
            before?.status === 'running' ? eq(attempts.id, before.id) : gt(attempts.id, before?.id ?? 0)
          )
        )
        .orderBy(asc(attempts.id))
        .limit(1)
      let latest = await latestAttempt(sandboxId)
      assertOwned?.()
      if (latest?.status === 'running') {
        // We now own the same authoritative session lock, so the old Core owner
        // died/lost its connection. Use the normal failure cooldown before retry.
        // A remote script may still run: its host flock remains the final fence.
        const failureCount = latest.failureCount + 1
        const [abandoned] = await db
          .update(attempts)
          .set({
            status: 'failed',
            failureClass: 'abandoned',
            failureCount,
            retryAt: new Date(Date.now() + provisionBackoffMs(failureCount)),
            completedAt: new Date(),
          })
          .where(and(eq(attempts.id, latest.id), eq(attempts.status, 'running')))
          .returning()
        if (abandoned) {
          latest = abandoned
          if (joined?.id === abandoned.id) joined = abandoned
        } else {
          // A lost owner may have finished before its disconnect was observed.
          // Never replace an already-terminal result with abandonment.
          latest = await latestAttempt(sandboxId)
          if (joined) [joined] = await db.select().from(attempts).where(eq(attempts.id, joined.id))
        }
      }
      if (joined) {
        if (joined.status === 'succeeded') return join()
        const newerSuccess = latest?.status === 'succeeded' && latest.id > joined.id
        const expired = joined.status === 'failed' && joined.retryAt && joined.retryAt.getTime() <= Date.now()
        if (!expired && !newerSuccess) sharedFailure(joined)
        // A delayed failed follower must not mask subsequent recovery or
        // renew an already-expired failure. We still hold the lifecycle lease.
        if (latest?.status === 'succeeded') return join()
      }
      if (latest?.status === 'failed' && latest.retryAt && latest.retryAt.getTime() > Date.now()) sharedFailure(latest)

      const [current] = await db
        .insert(attempts)
        .values({
          sandboxId,
          failureCount: latest?.status === 'failed' ? latest.failureCount : 0,
        })
        .returning()
      try {
        assertOwned?.()
        const value = await physicalGeneration.run(current!.id, provision)
        assertOwned?.()
        const published = await db
          .update(attempts)
          .set({ status: 'succeeded', completedAt: new Date() })
          .where(and(eq(attempts.id, current!.id), eq(attempts.status, 'running')))
          .returning({ id: attempts.id })
        if (!published.length) throw new Error(`VM provision lost generation ownership for ${sandboxId}`)
        return value
      } catch (error) {
        // The bind/reaper placement race occurs BEFORE provisioning and is safe
        // for the existing one-shot re-placement loop to retry immediately.
        const placement = error instanceof MachineNotReadyError
        const retryCode = startupRetryCode(error)
        const failureCount = placement ? 0 : current!.failureCount + 1
        assertOwned?.()
        await db
          .update(attempts)
          .set({
            status: 'failed',
            failureClass: placement
              ? `placement${retryCode ? `:${retryCode}` : ''}`
              : retryCode
                ? `retry:${retryCode}`
                : 'provision',
            failureCount,
            retryAt: placement ? null : new Date(Date.now() + provisionBackoffMs(failureCount)),
            completedAt: new Date(),
          })
          .where(and(eq(attempts.id, current!.id), eq(attempts.status, 'running')))
        throw error
      } finally {
        // Only this leased box's old terminal generations. Never fail an ensure
        // just because opportunistic retention cleanup could not run.
        try {
          assertOwned?.()
          await db.delete(attempts).where(
            and(
              eq(attempts.sandboxId, sandboxId),
              lt(attempts.completedAt, new Date(Date.now() - RESULT_RETENTION_MS)),
              sql`NOT EXISTS (SELECT 1 FROM ${machineCapacityClaims}
                  WHERE ${machineCapacityClaims.provisionAttemptId} = ${attempts.id})`
            )
          )
        } catch {
          /* Session loss or optional retention failure must not mask the outcome. */
        }
      }
    })
  )
}
