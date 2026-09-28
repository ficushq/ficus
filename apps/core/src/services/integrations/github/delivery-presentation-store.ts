import { and, eq, inArray } from 'drizzle-orm'
import { deliveryPullRequests } from '@ficus/shared'
import { db, workStreams, workStreamFlowRuns } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { awaitsCodeHostDelivery } from '../../workflows/delivery-state'
import type { EventPollingWatch } from '../event-polling-runner'
import { readGitHubDeliverySnapshot, type GitHubDeliverySnapshot } from './delivery-presentation'

/** Notify read models only; snapshots never enter activity, agent inboxes or flow transitions. */
export async function notifyDeliverySnapshotChanged(
  watch: EventPollingWatch,
  previous: unknown,
  next: unknown
): Promise<void> {
  if (watch.providerKey !== 'github') return
  const current = readGitHubDeliverySnapshot(next)
  // A cleared/unavailable observation must also invalidate a previous human gate.
  // Stale identity is used only for invalidation, never to classify readiness.
  const snapshot = current ?? readGitHubDeliverySnapshot(previous, Date.now(), true)
  if (!snapshot || snapshot.squadId !== watch.connection.squadId || snapshot.connectionId !== watch.connection.id)
    return
  const before = readGitHubDeliverySnapshot(previous)
  const semantic = (value: GitHubDeliverySnapshot) => {
    const { observedAt: _observedAt, ...fields } = value
    return JSON.stringify(fields)
  }
  if (before && current && semantic(before) === semantic(current)) return
  const candidates = await db
    .select({
      id: workStreams.id,
      squadId: workStreams.squadId,
      metadata: workStreams.metadata,
      state: workStreamFlowRuns.state,
    })
    .from(workStreams)
    .innerJoin(workStreamFlowRuns, eq(workStreamFlowRuns.workStreamId, workStreams.id))
    .where(
      and(
        eq(workStreams.squadId, snapshot.squadId),
        inArray(workStreams.status, ['active', 'queued']),
        eq(workStreamFlowRuns.activated, true)
      )
    )
  for (const stream of candidates) {
    if (!awaitsCodeHostDelivery(stream.state, stream.metadata)) continue
    if (
      !deliveryPullRequests(stream.metadata).some(
        (resource) =>
          resource.integration === 'github' &&
          resource.repository.toLowerCase() === snapshot.repository &&
          resource.number === snapshot.number &&
          (!resource.connectionId || resource.connectionId === snapshot.connectionId)
      )
    )
      continue
    eventEmitter.emit('workStream.updated', { workStreamId: stream.id, squadId: stream.squadId })
  }
}
