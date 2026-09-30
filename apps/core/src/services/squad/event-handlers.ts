import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { WorkStream } from '../../entities/WorkStream'
import {
  notifyWorkStreamAssigned,
  notifyWorkStreamBlocked,
  notifyWorkStreamCanceled,
  notifyWorkStreamDone,
  notifyWorkStreamResponded,
  notifyWorkStreamReview,
} from './work-stream-notifications'
export { resolveWorkStreamRecipient } from './work-stream-notifications'

const log = createLogger('squad')

let initialized = false

/**
 * Initialize event handlers for squad-related events.
 * These handlers are idempotent fallbacks for durable side effects now invoked
 * directly by WorkStream state transitions.
 */
export function initSquadEventHandlers(): void {
  if (initialized) return
  initialized = true

  // Every handler forwards `actorAgentId` from the payload. These handlers are
  // idempotent FALLBACKS for the direct calls in WorkStream's transitions and
  // may run in the OTHER PROCESS, so if the actor did not survive in the
  // payload the fallback would happily send the very message the direct call
  // suppressed — dedupe would not catch it, because nothing was sent first.
  eventEmitter.on('workStream.blocked', async ({ workStreamId, waitId, actorAgentId }) => {
    const workStream = await WorkStream.find(workStreamId)
    // The wait's actor is re-read from its row by id, so an older emitter's
    // payload without `waitActor` cannot route an owner wait to humans.
    if (workStream)
      await notifyWorkStreamBlocked(
        workStream,
        waitId ? { waitId, actionId: `workstream-blocked:${workStreamId}:${waitId}` } : undefined,
        actorAgentId
      )
  })

  eventEmitter.on('workStream.review', async ({ workStreamId, waitId, actorAgentId }) => {
    const workStream = await WorkStream.find(workStreamId)
    if (workStream)
      await notifyWorkStreamReview(
        workStream,
        waitId ? { waitId, actionId: `workstream-review:${workStreamId}:${waitId}` } : undefined,
        actorAgentId
      )
  })

  eventEmitter.on('workStream.done', async ({ workStreamId, actorAgentId }) => {
    const workStream = await WorkStream.find(workStreamId)
    if (workStream) await notifyWorkStreamDone(workStream, { actorAgentId })
  })

  eventEmitter.on('workStream.canceled', async ({ workStreamId, agentIds, actorAgentId }) => {
    const workStream = await WorkStream.find(workStreamId)
    if (workStream) await notifyWorkStreamCanceled(workStream, agentIds ?? [], actorAgentId)
  })

  eventEmitter.on('workStream.assigned', async ({ workStreamId, agentId, actorAgentId }) => {
    const workStream = await WorkStream.find(workStreamId)
    if (workStream) await notifyWorkStreamAssigned(workStream, agentId, actorAgentId)
  })

  eventEmitter.on(
    'workStream.responded',
    async ({ workStreamId, resolvedWaitType, reviewResolution, actorAgentId }) => {
      if (resolvedWaitType !== 'manual' && resolvedWaitType !== 'review') return
      const workStream = await WorkStream.find(workStreamId)
      // Pass the review resolution through so a checkpoint approval never
      // renders send-back ("needs further work") wording — and so its dedupe
      // subject matches the direct notify call from approveReview.
      if (workStream)
        await notifyWorkStreamResponded(
          workStream,
          resolvedWaitType,
          undefined,
          reviewResolution ?? 'sent_back',
          actorAgentId
        )
    }
  )

  log.info('Squad event handlers initialized')
}
