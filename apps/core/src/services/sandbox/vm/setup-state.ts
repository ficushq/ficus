import { createHash } from 'crypto'
import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm'
import { db } from '../../../db'
import { createPostgresConnection, getConnectionString, withDedicatedConnectionSlot } from '../../../db/connection'
import { fleetIncidents, machineBoxes, vmBoxSetupStates } from '../../../db/schema'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { observeSandboxDegradation, type SandboxDegradationObservation } from '../../fleet-alerts/store'

export type VmSetupReadiness = 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
export type VmSetupReasonCode =
  | 'devbox_unavailable'
  | 'bashrc_unavailable'
  | 'git_credentials_unavailable'
  | 'transport_recovery_failed'
  | 'callback_transport_degraded'
  | 'command_outcome_ambiguous'

export interface VmSetupState {
  sandboxId: string
  desiredFingerprint: string
  readiness: VmSetupReadiness
  reasons: VmSetupReasonCode[]
  attemptCount: number
  nextAttemptAt: Date | null
  pendingInvocationId: string | null
  pendingInvocationKind: string | null
  lastFailureClass: string | null
  lastAttemptAt: Date | null
  updatedAt: Date
}

export interface PublicVmSetupState {
  readiness: VmSetupReadiness
  reasons: VmSetupReasonCode[]
  attemptCount: number
  nextAttemptAt?: string
}

const REASON_CODES = new Set<VmSetupReasonCode>([
  'devbox_unavailable',
  'bashrc_unavailable',
  'git_credentials_unavailable',
  'transport_recovery_failed',
  'callback_transport_degraded',
  'command_outcome_ambiguous',
])

function boundedReasons(values: readonly string[]): VmSetupReasonCode[] {
  return [...new Set(values)]
    .filter((value): value is VmSetupReasonCode => REASON_CODES.has(value as VmSetupReasonCode))
    .slice(0, 5)
}

export function computeVmSetupBackoffMs(sandboxId: string, attemptCount: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(attemptCount - 1, 0), 15 * 60_000)
  const digest = createHash('sha256').update(`${sandboxId}\0${attemptCount}`).digest().readUInt32BE(0)
  return base + (digest % (Math.floor(base * 0.2) + 1))
}

export const VM_SETUP_RECONCILE_STALE_MS = 12 * 60_000

export function isVmSetupDue(state: VmSetupState, now: Date): boolean {
  if (state.readiness === 'pending') return true
  if (state.readiness === 'ready_degraded') return Boolean(state.nextAttemptAt && state.nextAttemptAt <= now)
  if (state.readiness === 'reconciling') {
    return Boolean(state.lastAttemptAt && state.lastAttemptAt.getTime() + VM_SETUP_RECONCILE_STALE_MS <= now.getTime())
  }
  return false
}

export function projectVmSetupState(state: VmSetupState): PublicVmSetupState {
  return {
    readiness: state.readiness,
    reasons: boundedReasons(state.reasons),
    attemptCount: state.attemptCount,
    ...(state.nextAttemptAt ? { nextAttemptAt: state.nextAttemptAt.toISOString() } : {}),
  }
}

function mapState(row: typeof vmBoxSetupStates.$inferSelect): VmSetupState {
  return { ...row, readiness: row.readiness as VmSetupReadiness, reasons: boundedReasons(row.reasons) }
}

function emit(sandboxId: string): void {
  eventEmitter.emit('sandbox.status', { sandboxId })
}

export async function getVmSetupState(sandboxId: string): Promise<VmSetupState | null> {
  const [row] = await db.select().from(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId)).limit(1)
  return row ? mapState(row) : null
}

export async function ensureVmSetupFingerprint(sandboxId: string, desiredFingerprint: string): Promise<VmSetupState> {
  const now = new Date()
  const changed = await db
    .insert(vmBoxSetupStates)
    .values({ sandboxId, desiredFingerprint, readiness: 'pending', updatedAt: now })
    .onConflictDoUpdate({
      target: vmBoxSetupStates.sandboxId,
      set: {
        desiredFingerprint,
        readiness: 'pending',
        reasons: [],
        attemptCount: 0,
        nextAttemptAt: null,
        lastFailureClass: null,
        updatedAt: now,
      },
      setWhere: ne(vmBoxSetupStates.desiredFingerprint, desiredFingerprint),
    })
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  const state = await getVmSetupState(sandboxId)
  if (!state) throw new Error(`Failed to initialize VM setup state for ${sandboxId}`)
  if (changed.length) emit(sandboxId)
  return state
}

export async function setVmSetupPendingInvocation(
  sandboxId: string,
  fingerprint: string,
  invocationId: string,
  kind: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({
      pendingInvocationId: invocationId.slice(0, 128),
      pendingInvocationKind: kind.slice(0, 40),
      updatedAt: now,
    })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, fingerprint),
        or(isNull(vmBoxSetupStates.pendingInvocationId), eq(vmBoxSetupStates.pendingInvocationId, invocationId))
      )
    )
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) emit(sandboxId)
  return rows.length > 0
}

export async function clearVmSetupPendingInvocation(
  sandboxId: string,
  fingerprint: string,
  invocationId: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({
      pendingInvocationId: null,
      pendingInvocationKind: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, fingerprint),
        eq(vmBoxSetupStates.pendingInvocationId, invocationId)
      )
    )
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) emit(sandboxId)
  return rows.length > 0
}

export async function restoreVmSetupAfterRequiredAssets(
  sandboxId: string,
  fingerprint: string,
  prior: VmSetupState,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({
      readiness: prior.readiness,
      reasons: prior.reasons,
      attemptCount: prior.attemptCount,
      nextAttemptAt: prior.nextAttemptAt,
      lastFailureClass: prior.lastFailureClass,
      lastAttemptAt: prior.lastAttemptAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, fingerprint),
        eq(vmBoxSetupStates.readiness, 'pending'),
        isNull(vmBoxSetupStates.pendingInvocationId)
      )
    )
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) emit(sandboxId)
  return rows.length > 0
}

export async function markVmSetupPending(sandboxId: string, fingerprint: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({ readiness: 'pending', reasons: [], nextAttemptAt: null, updatedAt: now })
    .where(and(eq(vmBoxSetupStates.sandboxId, sandboxId), eq(vmBoxSetupStates.desiredFingerprint, fingerprint)))
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) emit(sandboxId)
  return rows.length > 0
}

export async function markVmSetupReconciling(
  sandboxId: string,
  fingerprint: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({ readiness: 'reconciling', lastAttemptAt: now, updatedAt: now })
    .where(and(eq(vmBoxSetupStates.sandboxId, sandboxId), eq(vmBoxSetupStates.desiredFingerprint, fingerprint)))
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) emit(sandboxId)
  return rows.length > 0
}

export async function markVmSetupRepairNeeded(
  sandboxId: string,
  fingerprint: string,
  reason: VmSetupReasonCode,
  now = new Date()
): Promise<VmSetupState | null> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({
      readiness: 'ready_degraded',
      reasons: [reason],
      attemptCount: 0,
      nextAttemptAt: now,
      lastFailureClass: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, fingerprint),
        eq(vmBoxSetupStates.readiness, 'ready')
      )
    )
    .returning()
  if (rows.length) {
    emit(sandboxId)
    return mapState(rows[0])
  }
  return getVmSetupState(sandboxId)
}

export async function mergeVmSetupObservedReasons(
  sandboxId: string,
  fingerprint: string,
  reasons: VmSetupReasonCode[],
  now = new Date()
): Promise<VmSetupState | null> {
  const current = await getVmSetupState(sandboxId)
  if (!current || current.desiredFingerprint !== fingerprint || current.readiness !== 'ready_degraded') return null
  const merged = boundedReasons([...current.reasons, ...reasons])
  const rows = await db
    .update(vmBoxSetupStates)
    .set({ reasons: merged, updatedAt: now })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, fingerprint),
        eq(vmBoxSetupStates.readiness, 'ready_degraded'),
        eq(vmBoxSetupStates.attemptCount, current.attemptCount)
      )
    )
    .returning()
  if (!rows.length) return null
  emit(sandboxId)
  return mapState(rows[0])
}

export async function markVmSetupDegraded(input: {
  sandboxId: string
  fingerprint: string
  reasons: VmSetupReasonCode[]
  lastFailureClass?: string
  squadId?: string
  now?: Date
}): Promise<VmSetupState | null> {
  const current = await getVmSetupState(input.sandboxId)
  if (!current || current.desiredFingerprint !== input.fingerprint) return null
  const now = input.now ?? new Date()
  const attemptCount = current.attemptCount + 1
  const nextAttemptAt = new Date(now.getTime() + computeVmSetupBackoffMs(input.sandboxId, attemptCount))
  const [row] = await db
    .update(vmBoxSetupStates)
    .set({
      readiness: 'ready_degraded',
      reasons: boundedReasons(input.reasons),
      attemptCount,
      nextAttemptAt,
      lastFailureClass: input.lastFailureClass?.slice(0, 64) ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(vmBoxSetupStates.sandboxId, input.sandboxId),
        eq(vmBoxSetupStates.desiredFingerprint, input.fingerprint),
        eq(vmBoxSetupStates.attemptCount, current.attemptCount)
      )
    )
    .returning()
  if (row) {
    emit(input.sandboxId)
    void observeSandboxDegradation({
      status: 'degraded',
      sandboxId: input.sandboxId,
      attemptCount,
      reasons: boundedReasons(input.reasons),
      squadId: input.squadId,
      nextAttemptAt,
      now,
    }).catch(() => {})
  }
  return row ? mapState(row) : null
}

export async function markVmSetupReady(sandboxId: string, fingerprint: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(vmBoxSetupStates)
    .set({
      readiness: 'ready',
      reasons: [],
      attemptCount: 0,
      nextAttemptAt: null,
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      updatedAt: now,
    })
    .where(and(eq(vmBoxSetupStates.sandboxId, sandboxId), eq(vmBoxSetupStates.desiredFingerprint, fingerprint)))
    .returning({ sandboxId: vmBoxSetupStates.sandboxId })
  if (rows.length) {
    emit(sandboxId)
    void observeSandboxDegradation({ status: 'ready', sandboxId, now }).catch(() => {})
  }
  return rows.length > 0
}

export async function listReadyBoxesMissingVmSetup(limit = 8): Promise<string[]> {
  const rows = await db
    .select({ sandboxId: machineBoxes.sandboxId })
    .from(machineBoxes)
    .leftJoin(vmBoxSetupStates, eq(vmBoxSetupStates.sandboxId, machineBoxes.sandboxId))
    .where(and(eq(machineBoxes.status, 'ready'), isNull(vmBoxSetupStates.sandboxId)))
    .orderBy(asc(machineBoxes.updatedAt))
    .limit(Math.max(1, Math.min(limit, 32)))
  return rows.map((row) => row.sandboxId)
}

/**
 * Remove a box's durable setup row. For retiring a box whose owner is gone:
 * nothing else ever deletes these rows, so without this a terminated agent's
 * pending/degraded setup row keeps the box in listDueVmSetups forever and the
 * recovery sweep re-stops it every tick.
 */
export async function deleteVmSetupState(sandboxId: string): Promise<void> {
  await db.delete(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId))
}

export async function listDueVmSetups(now = new Date(), limit = 8): Promise<VmSetupState[]> {
  const staleBefore = new Date(now.getTime() - VM_SETUP_RECONCILE_STALE_MS)
  const rows = await db
    .select()
    .from(vmBoxSetupStates)
    .where(
      or(
        eq(vmBoxSetupStates.readiness, 'pending'),
        and(eq(vmBoxSetupStates.readiness, 'ready_degraded'), lte(vmBoxSetupStates.nextAttemptAt, now)),
        and(eq(vmBoxSetupStates.readiness, 'reconciling'), lte(vmBoxSetupStates.lastAttemptAt, staleBefore))
      )
    )
    .orderBy(asc(vmBoxSetupStates.nextAttemptAt))
    .limit(Math.max(1, Math.min(limit, 32)))
  return rows.map(mapState)
}

/** Acquisition budget exceeds the ten-minute streamed devbox install budget. */
const VM_SETUP_LEASE_WAIT_TIMEOUT_MS = 15 * 60_000

type VmSetupLeaseWait = {
  signal?: AbortSignal
  /** Injectable acquisition clock/sleep for deterministic contention tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function withVmSetupLease<T>(
  sandboxId: string,
  reconcile: () => Promise<T>,
  wait: VmSetupLeaseWait = {}
): Promise<T> {
  const now = wait.now ?? Date.now
  const deadline = now() + VM_SETUP_LEASE_WAIT_TIMEOUT_MS
  const sleep = wait.sleep ?? ((ms: number) => Bun.sleep(ms))
  const checkWaiting = () => {
    wait.signal?.throwIfAborted()
    if (now() >= deadline) throw new Error('VM setup lease acquisition timed out')
  }
  const key = `vm-box-setup:${sandboxId}`
  let delayMs = 250
  for (;;) {
    checkWaiting()
    const attempt = await withDedicatedConnectionSlot(async () => {
      // The global slot queue can itself be busy; never start stale work after it drains.
      checkWaiting()
      const connection = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0 })
      try {
        const session = await connection.reserve()
        try {
          const [lock] = await session<
            { acquired: boolean }[]
          >`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`
          if (!lock?.acquired) return { acquired: false } as const
          try {
            checkWaiting()
            return { acquired: true, value: await reconcile() } as const
          } finally {
            await session`select pg_advisory_unlock(hashtextextended(${key}, 0))`
          }
        } finally {
          session.release()
        }
      } finally {
        await connection.end({ timeout: 5 })
      }
    })
    if (attempt.acquired) return attempt.value
    // A contended box must not occupy either of the two shared dedicated slots
    // while waiting for its owner. The callback runs only once, under the lock.
    checkWaiting()
    await sleep(Math.min(delayMs, deadline - now()))
    delayMs = Math.min(delayMs * 2, 1_000)
  }
}

export function projectVmSetupIncidents(
  states: VmSetupState[],
  openSandboxIds: string[],
  now: Date
): SandboxDegradationObservation[] {
  const observations: SandboxDegradationObservation[] = []
  const durableIds = new Set(states.map((state) => state.sandboxId))
  const openIds = new Set(openSandboxIds)
  for (const state of states) {
    if (state.readiness === 'ready_degraded') {
      observations.push({
        status: 'degraded',
        sandboxId: state.sandboxId,
        attemptCount: state.attemptCount,
        reasons: state.reasons,
        ...(state.sandboxId.startsWith('squad_') ? { squadId: state.sandboxId.slice('squad_'.length) } : {}),
        ...(state.nextAttemptAt ? { nextAttemptAt: state.nextAttemptAt } : {}),
        now,
      })
    } else if (state.readiness === 'ready' && openIds.has(state.sandboxId)) {
      observations.push({ status: 'ready', sandboxId: state.sandboxId, now })
    }
  }
  for (const sandboxId of openSandboxIds) {
    if (!durableIds.has(sandboxId)) observations.push({ status: 'ready', sandboxId, now })
  }
  return observations
}

/** Replay setup-to-incident projection after transient/crash observation loss. */
export async function reconcileVmSetupIncidents(now = new Date()): Promise<void> {
  const [degradedRows, openIncidents] = await Promise.all([
    db.select().from(vmBoxSetupStates).where(eq(vmBoxSetupStates.readiness, 'ready_degraded')),
    db
      .select({ scopeKey: fleetIncidents.scopeKey })
      .from(fleetIncidents)
      .where(and(eq(fleetIncidents.kind, 'sandbox_degraded'), isNull(fleetIncidents.resolvedAt))),
  ])
  const openSandboxIds = openIncidents
    .map((incident) => (incident.scopeKey.startsWith('sandbox:') ? incident.scopeKey.slice('sandbox:'.length) : ''))
    .filter(Boolean)
  const openStates = openSandboxIds.length
    ? await db.select().from(vmBoxSetupStates).where(inArray(vmBoxSetupStates.sandboxId, openSandboxIds))
    : []
  const statesById = new Map<string, VmSetupState>()
  for (const row of [...degradedRows, ...openStates]) statesById.set(row.sandboxId, mapState(row))
  const observations = projectVmSetupIncidents([...statesById.values()], openSandboxIds, now)
  for (let offset = 0; offset < observations.length; offset += 8) {
    await Promise.allSettled(observations.slice(offset, offset + 8).map(observeSandboxDegradation))
  }
}
