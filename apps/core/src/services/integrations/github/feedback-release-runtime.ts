import { and, eq } from 'drizzle-orm'
import { db, githubFeedbackRevisions, githubFeedbackSources, integrationOutputEvents, type DbTx } from '../../../db'
import { authorized } from '../outputs/authority'
import { githubContentHash } from './feedback-envelope'
import { isGitHubOutputAdmitted, isOriginalGitHubRoute, matchesOriginalGitHubRoutes } from './feedback-routing'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'
import { releaseGitHubFeedback, type GitHubFeedbackReleaseDependencies } from './feedback-release'
import { renewKnownGitHubOutputs } from './feedback-renewal'
import { readGitHubResource, reserveGitHubEvent, withGitHubOutputPass } from './feedback-pass'

type Event = typeof integrationOutputEvents.$inferSelect
type Store = typeof db | DbTx
const snapshot = (event: Event) => githubContentHash([event.fact, event.authority, event.sourceKey, event.eventKey])

/** Production adapter: provider preparation and immutable LOCAL factory callbacks are separate. */
export async function reconcileGitHubFeedbackRelease(route: GitHubFeedbackReleaseDependencies['route']) {
  return withGitHubOutputPass(async () => {
    const witnesses = new Map<string, { hash: string; expiresAt: number }>()
    async function sourceReason(event: Event, store: Store) {
      if (
        event.authority.kind !== 'connection' ||
        !(await authorized(store, 'github', event.authority, event.authority.squadId))
      )
        return 'source_unavailable' as const
      const [row] = await store
        .select({ revision: githubFeedbackRevisions })
        .from(githubFeedbackSources)
        .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
        .where(
          and(eq(githubFeedbackSources.eventId, event.id), eq(githubFeedbackSources.squadId, event.authority.squadId))
        )
      const revision = row?.revision
      if (
        !revision ||
        !['automatic', 'allow_once', 'allow_trust'].includes(revision.decision) ||
        (revision.decision === 'automatic' &&
          !(await isTrustedGitHubFeedbackContent(store, revision.squadId, revision)))
      )
        return 'source_unavailable' as const
      return (await matchesOriginalGitHubRoutes(store, event, revision.routingProvenance, event))
        ? null
        : ('routing_changed' as const)
    }
    return releaseGitHubFeedback({
      async prepareSource(event) {
        if (!reserveGitHubEvent(event.id)) return false
        if (event.fact.github?.revisionId) {
          if (
            event.authority.kind !== 'connection' ||
            !(await authorized(db, 'github', event.authority, event.authority.squadId))
          )
            return false
          if (!(await isOriginalGitHubRoute(db, event))) return { state: 'obsolete', reason: 'routing_changed' }
          await renewKnownGitHubOutputs([event.id])
          return (await isGitHubOutputAdmitted(db, event)) && (await isOriginalGitHubRoute(db, event))
        }
        const reason = await sourceReason(event, db)
        if (reason === 'routing_changed') return { state: 'obsolete', reason }
        if (reason) return false
        const access = await readGitHubResource(event)
        if (!access?.nativeAuthorized) return false
        witnesses.set(event.id, { hash: snapshot(event), expiresAt: access.checkedAt.getTime() + 60_000 })
        return true
      },
      async authorizeSource(event, store = db) {
        if (event.fact.github?.revisionId)
          return (await isGitHubOutputAdmitted(store, event)) && (await isOriginalGitHubRoute(store, event))
        const witness = witnesses.get(event.id)
        if (!witness || witness.expiresAt <= Date.now() || witness.hash !== snapshot(event)) return false
        const [current] = await store
          .select()
          .from(integrationOutputEvents)
          .where(eq(integrationOutputEvents.id, event.id))
        return !!current && snapshot(current) === witness.hash && (await sourceReason(current, store)) === null
      },
      route,
    })
  })
}
