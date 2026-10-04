import { randomUUID } from 'node:crypto'
import { and, eq, lte, or, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { liveActivityRelayInstallations as rows } from '../../db/schema'
import { encrypt, decrypt, getEncryptionKey } from '../secrets/crypto'
import { shouldShowLiveActivity, type LiveActivityState } from '@ficus/shared'
import {
  coreLiveActivityRegistrationSchema,
  relayLiveActivitySendSchema,
  projectRelayLiveActivityState,
  type CoreLiveActivityRegistration,
  type RelayLiveActivitySend,
} from '@ficus/shared/live-activity-relay'
import { sendRelayLiveActivity, type LiveActivityRelayResult } from './live-activity-relay'
import { loadWorkInterestSnapshot } from './work-interest'
import { pushRelayConfig } from './relay'

interface State {
  start?: CoreLiveActivityRegistration & { kind: 'start' }
  update?: CoreLiveActivityRegistration & { kind: 'update' }
  activityKey?: string
  sequence: number
  ended?: boolean
  pending?: RelayLiveActivitySend
  lastState?: LiveActivityState
  blocked?: string
  attempts: number
}
const encode = (state: State) => JSON.stringify(encrypt(JSON.stringify(state), getEncryptionKey()))
const decode = (value: string): State => {
  const { encrypted, iv } = JSON.parse(value)
  return JSON.parse(decrypt(encrypted, iv, getEncryptionKey()))
}
const clock = async (tx: Pick<typeof db, 'execute'>) => {
  const [row] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`)
  return new Date(row!.now)
}
export const liveActivityRelayEnabled = () => process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED === 'true'

export async function registerActivityRelay(userId: string, raw: CoreLiveActivityRegistration) {
  const input = coreLiveActivityRegistrationSchema.parse(raw)
  return db.transaction(async (tx) => {
    // Serializes first insert too; the installation UUID is already validated.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.activationId}, 927))`)
    const [row] = await tx.select().from(rows).where(eq(rows.activationId, input.activationId)).for('update')
    if (row && row.userId !== userId) throw new Error('Registration belongs to another user')
    const state: State = row ? decode(row.stateEnc) : { sequence: 0, attempts: 0 }
    if (row && input.generation <= row.generation) {
      const previous = input.kind === 'start' ? state.start : state.update
      if (JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('Stale registration')
      return { id: input.activationId }
    }
    if (input.kind === 'start') state.start = input
    else {
      const changed = state.activityKey !== input.activityKey
      if (!changed && state.ended) throw new Error('Activity has ended')
      if (changed) {
        state.activityKey = input.activityKey
        state.sequence = 0
        state.pending = undefined
        state.lastState = undefined
        state.ended = false
      } else if (state.pending?.event === 'start') {
        // Signed device observation proves creation, not delivery of future update/end events.
        state.pending = undefined
      }
      state.update = input
    }
    state.blocked = undefined
    state.attempts = 0
    const at = await clock(tx)
    await tx
      .insert(rows)
      .values({ activationId: input.activationId, userId, generation: input.generation, stateEnc: encode(state) })
      .onConflictDoUpdate({
        target: rows.activationId,
        set: {
          generation: input.generation,
          stateEnc: encode(state),
          leaseId: null,
          leaseUntil: null,
          nextAttemptAt: at,
          updatedAt: at,
        },
      })
    return { id: input.activationId }
  })
}

/** Core removal stops delivery immediately. Device-signed Cloud revocation is a separate, mandatory cleanup. */
export async function unregisterActivityRelay(userId: string, activationId: string) {
  await db.delete(rows).where(and(eq(rows.activationId, activationId), eq(rows.userId, userId)))
}

/** Each invocation claims one installation. Leases fence late completions; payloads survive restarts. */
export async function pumpActivityRelay(
  deps: {
    send?: (input: RelayLiveActivitySend) => Promise<LiveActivityRelayResult>
    snapshot?: (userId: string) => Promise<LiveActivityState>
  } = {}
): Promise<boolean> {
  const claim = await db.transaction(async (tx) => {
    const at = await clock(tx)
    const [row] = await tx
      .select()
      .from(rows)
      .where(and(lte(rows.nextAttemptAt, at), or(isNull(rows.leaseUntil), lte(rows.leaseUntil, at))))
      .orderBy(rows.nextAttemptAt)
      .limit(1)
      .for('update', { skipLocked: true })
    if (!row) return null
    const leaseId = randomUUID()
    await tx
      .update(rows)
      .set({ leaseId, leaseUntil: new Date(at.getTime() + 60_000) })
      .where(eq(rows.activationId, row.activationId))
    return { ...row, leaseId }
  })
  if (!claim) return false
  const state = decode(claim.stateEnc)
  let delay = 30_000
  try {
    const fresh = projectRelayLiveActivityState(
      deps.snapshot ? await deps.snapshot(claim.userId) : (await loadWorkInterestSnapshot(claim.userId)).liveActivity,
      true
    )
    const show = shouldShowLiveActivity(fresh)
    if (
      state.pending &&
      state.pending.event !== 'end' &&
      JSON.stringify(state.pending.contentState) !== JSON.stringify(fresh)
    ) {
      // Do not replay stale content after permissions/interest changed. An update capability can
      // send a content-free successor end; otherwise wait for the device to reconcile creation.
      if (state.update && state.activityKey) {
        state.pending = {
          version: 1,
          bindingToken: state.update.bindingToken,
          activityKey: state.activityKey,
          sequence: ++state.sequence,
          eventId: randomUUID(),
          ...(show ? { event: 'update', contentState: fresh } : { event: 'end' }),
        }
      } else {
        state.blocked = 'state_changed'
        state.pending = undefined
      }
    }
    if (!state.pending && !state.blocked) {
      if (state.update && !state.ended && state.activityKey) {
        if (!show || JSON.stringify(fresh) !== JSON.stringify(state.lastState)) {
          state.pending = {
            version: 1,
            bindingToken: state.update.bindingToken,
            activityKey: state.activityKey,
            sequence: ++state.sequence,
            eventId: randomUUID(),
            ...(show ? { event: 'update', contentState: fresh } : { event: 'end' }),
          }
        }
      } else if (state.start && show && (!state.activityKey || state.ended)) {
        state.activityKey = randomUUID()
        state.sequence = 1
        state.ended = false
        state.update = undefined
        state.pending = {
          version: 1,
          bindingToken: state.start.bindingToken,
          activityKey: state.activityKey,
          sequence: state.sequence,
          eventId: randomUUID(),
          event: 'start',
          contentState: fresh,
        }
      }
    }
    if (state.pending) {
      const event = relayLiveActivitySendSchema.parse(state.pending)
      // Durable BEFORE I/O. A replaced registration/removal invalidates the old lease.
      const saved = await db
        .update(rows)
        .set({ stateEnc: encode(state) })
        .where(and(eq(rows.activationId, claim.activationId), eq(rows.leaseId, claim.leaseId)))
        .returning({ id: rows.activationId })
      if (!saved.length) return true
      const result = await (deps.send ?? sendRelayLiveActivity)(event)
      if (result.ok && result.status === 'superseded') {
        state.blocked = 'superseded'
        state.pending = undefined
      } else if (result.ok) {
        state.pending = undefined
        state.attempts = 0
        if (event.event === 'end') {
          state.ended = true
          state.update = undefined
          state.lastState = undefined
        } else state.lastState = event.contentState
      } else if (result.retryable) {
        state.attempts++
        delay = Math.min(30 * 60_000, 5000 * 2 ** Math.min(state.attempts, 9))
      } else {
        state.blocked = result.reason
        state.pending = undefined
        delay = 30 * 60_000
      }
    }
  } catch {
    // Snapshot/DB errors are retryable, without leaking capabilities or rendered content into logs.
    delay = 60_000
  }
  await db
    .update(rows)
    .set({
      stateEnc: encode(state),
      leaseId: null,
      leaseUntil: null,
      nextAttemptAt: sql`clock_timestamp() + ${delay} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(rows.activationId, claim.activationId), eq(rows.leaseId, claim.leaseId)))
  return true
}

/** Polling is a durable backstop for missed events and restarts, bounded to eight deliveries per tick. */
export function startActivityRelayRunner() {
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running || !liveActivityRelayEnabled()) return
    running = true
    try {
      if (!pushRelayConfig()) return
      for (let i = 0; i < 8 && !stopped; i++) if (!(await pumpActivityRelay())) break
    } catch {
      /* Retry next tick; no provider diagnostics or capabilities in logs. */
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), 5000)
  timer.unref()
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
