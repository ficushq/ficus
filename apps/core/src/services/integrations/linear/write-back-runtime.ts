import { eq } from 'drizzle-orm'
import type { EventMap } from '@ficus/shared'
import { agentQuestionWorkStreamOrigins, db } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { drainLinearOutbox, pruneLinearOutbox } from './outbox'
import { linearWriteBackSweepCandidates, projectLinearWriteBack, streamHasLinearWriteBack } from './session-projector'

const log = createLogger('linear-write-back')

/** Coalesces the burst of events one stream change emits, like the Live Activity fan-out. */
export const LINEAR_PROJECTION_DEBOUNCE_MS = 3_000
/** The reconcile sweep keeps write-back durable when an in-process event is lost. */
export const LINEAR_RECONCILE_INTERVAL_MS = 60_000
const DRAIN_INTERVAL_MS = 5_000

const STREAM_EVENTS = [
  'workStream.created',
  'workStream.updated',
  'workStream.assigned',
  'workStream.blocked',
  'workStream.review',
  'workStream.responded',
  'workStream.done',
  'workStream.canceled',
  'workStream.reopened',
] as const
const QUESTION_EVENTS = ['agent-question.created', 'agent-question.answered', 'agent-question.dismissed'] as const

interface Emitter {
  on<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): () => void
}

export interface LinearWriteBackRuntime {
  /** Projects a stream now and drains what it enqueued (tests and the binding path). */
  flush(workStreamId: string): Promise<void>
  stop(): void
}

let draining: Promise<unknown> | null = null
/** One drain at a time per process; a drain requested during another simply waits for it. */
export function drainLinearOutboxSoon(): Promise<unknown> {
  if (draining) return draining
  draining = (async () => {
    try {
      for (let pass = 0; pass < 8; pass++) {
        const result = await drainLinearOutbox()
        if (result.sent + result.deferred + result.failed < 25) break
      }
    } catch (error) {
      log.warn(`Linear outbox drain failed: ${error instanceof Error ? error.message : 'error'}`)
    } finally {
      draining = null
    }
  })()
  return draining
}

async function projectAndDrain(workStreamId: string) {
  if (!(await streamHasLinearWriteBack(workStreamId))) return
  if ((await projectLinearWriteBack(workStreamId)) > 0) await drainLinearOutboxSoon()
}

/**
 * Wires the session projector (6.3): stream and question events wake a debounced projection per
 * stream, a 60-second sweep reconciles every bound session, and a 5-second loop drains the outbox.
 */
export function registerLinearWriteBack(emitter: Emitter): LinearWriteBackRuntime {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const schedule = (workStreamId: string) => {
    const existing = timers.get(workStreamId)
    if (existing) clearTimeout(existing)
    timers.set(
      workStreamId,
      setTimeout(() => {
        timers.delete(workStreamId)
        void projectAndDrain(workStreamId).catch((error) =>
          log.warn(`Linear projection failed: ${error instanceof Error ? error.message : 'error'}`)
        )
      }, LINEAR_PROJECTION_DEBOUNCE_MS)
    )
  }
  const unsubscribers: Array<() => void> = []
  for (const event of STREAM_EVENTS)
    unsubscribers.push(emitter.on(event, (payload) => schedule((payload as { workStreamId: string }).workStreamId)))
  for (const event of QUESTION_EVENTS)
    unsubscribers.push(
      emitter.on(event, (payload) => {
        void db
          .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
          .from(agentQuestionWorkStreamOrigins)
          .where(eq(agentQuestionWorkStreamOrigins.questionId, (payload as { questionId: string }).questionId))
          .then((rows) => rows.forEach((row) => schedule(row.workStreamId)))
          .catch(() => undefined)
      })
    )
  const sweep: PeriodicRunner = createPeriodicRunner({
    name: 'linear-write-back-reconcile',
    intervalMs: LINEAR_RECONCILE_INTERVAL_MS,
    task: async () => {
      for (const id of await linearWriteBackSweepCandidates()) await projectLinearWriteBack(id)
      await drainLinearOutboxSoon()
      await pruneLinearOutbox().catch(() => undefined)
    },
  })
  const drain: PeriodicRunner = createPeriodicRunner({
    name: 'linear-write-back-outbox',
    intervalMs: DRAIN_INTERVAL_MS,
    task: async () => {
      await drainLinearOutboxSoon()
    },
  })
  sweep.start()
  drain.start()
  return {
    async flush(workStreamId) {
      await projectLinearWriteBack(workStreamId)
      await drainLinearOutboxSoon()
    },
    stop() {
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      void sweep.stop()
      void drain.stop()
    },
  }
}
