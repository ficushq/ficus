import { db, type integrationOutputEvents } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { authorized } from '../outputs/authority'
import { captureGitHubFeedback } from './feedback-store'

type Event = typeof integrationOutputEvents.$inferSelect

/**
 * OFF is not an author filter, but it is still a version observer. Capture only normalized native
 * snapshots; never fetch GitHub, resolve trust, queue screening or manufacture canonical approval.
 * Capturing before routing ensures every raw acceptance has a watermark and later captures can
 * fence it under the existing authority lock. Accepted effects keep their ordinary raw receipts.
 */
export async function observeUnfilteredGitHubFeedback(event: Event): Promise<boolean> {
  if (event.fact.github?.revisionId || event.sourceKey.startsWith('github-status:')) return true
  const content = event.fact.github?.content
  if (!content) return true // content-free outputs and pre-rollout facts without native identity
  // Old action envelopes cannot prove the freshness of the raw parent prose they carry.
  if (content.objectKind === 'action' && !event.fact.github?.rawParent) return false
  const parts = event.fact.github?.rawParent ? (['content', 'parent'] as const) : (['content'] as const)
  for (const unfiltered of parts) {
    const captured = await captureGitHubFeedback(event.id, {
      unfiltered,
      authorizeSource: (source) =>
        source.authority.kind === 'connection'
          ? authorized(db, 'github', source.authority, source.authority.squadId)
          : Promise.resolve(false),
    })
    if (captured.obsoleteCount) eventEmitter.emit('githubFeedback.updated', { squadId: captured.revision.squadId })
  }
  return true
}
