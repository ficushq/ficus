import { normalizeDependabot } from './dependabot-output'
import { dependabotRepositoryInterest } from './dependabot-authority'
import { listGitHubPrWorkStreamCandidates, listGitHubTriggerSquads } from './database-watch-source'
import { reportDependabotUnavailable } from './dependabot-status'
import { integrationEnabledPredicate } from '../provider-state'
import { and, eq } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { githubApiGet } from '../../github/api-client'
import { publishIntegrationOutputs } from '../outputs/runtime'
import type { VerifiedIngressEvent } from '../types'

/** A signed tenant webhook proves origin, not which connected account can read its repository. */
export async function publishGitHubWebhookOutputs(event: VerifiedIngressEvent): Promise<string[]> {
  const repository = (event.payload as { repository?: { full_name?: unknown } } | null)?.repository?.full_name
  if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) return []
  const assignments = await db
    .select({ squadId: integrationConnectionAssignments.squadId, connectionId: integrationConnections.id })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate()
      )
    )
  const fact = event.type === 'dependabot_alert' ? normalizeDependabot(event)[0] : undefined
  if (event.type === 'dependabot_alert' && !fact) return []
  const scopedSquads = fact ? await listGitHubTriggerSquads() : []
  const streams = fact ? await listGitHubPrWorkStreamCandidates() : []
  const handled = new Set<string>()
  for (const assignment of assignments) {
    if (fact) {
      if (!(await canObserveGitHubDependabot(event, assignment, { squads: scopedSquads, streams }))) continue
    } else {
      // The API helper rechecks live assignment and credential. Correlation never grants access.
      const access = await githubApiGet<{ full_name: string }>(
        `/repos/${repository}`,
        assignment.squadId,
        assignment.connectionId
      )
      if (!access || access.full_name.toLowerCase() !== repository.toLowerCase()) continue
    }
    for (const squadId of await publishIntegrationOutputs('github', event, { kind: 'connection', ...assignment }))
      handled.add(squadId)
  }
  return [...handled]
}

/** Common direct / hosted ingress gate; a Platform envelope is not squad security authorization. */
export async function canObserveGitHubDependabot(
  event: VerifiedIngressEvent,
  assignment: { squadId: string; connectionId: string },
  scope?: {
    squads: Awaited<ReturnType<typeof listGitHubTriggerSquads>>
    streams: Awaited<ReturnType<typeof listGitHubPrWorkStreamCandidates>>
  }
): Promise<boolean> {
  const fact = normalizeDependabot(event)[0]
  if (!fact) return false
  const scoped = scope ?? { squads: await listGitHubTriggerSquads(), streams: await listGitHubPrWorkStreamCandidates() }
  if (
    !dependabotRepositoryInterest(
      scoped.squads.find((squad) => squad.id === assignment.squadId)?.metadata,
      scoped.streams.filter((stream) => stream.squadId === assignment.squadId),
      fact,
      assignment.connectionId
    )
  )
    return false
  const repository = await githubApiGet<{ id: number; full_name: string }>(
    `/repositories/${fact.data.repositoryId}`,
    assignment.squadId,
    assignment.connectionId
  )
  if (!repository || repository.id !== fact.data.repositoryId || !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name))
    return false
  const number = (fact.data.alert as { number: number }).number
  const alert = await githubApiGet<{ number: number }>(
    `/repos/${repository.full_name}/dependabot/alerts/${number}`,
    assignment.squadId,
    assignment.connectionId
  )
  if (alert?.number !== number) {
    await reportDependabotUnavailable(assignment.squadId, assignment.connectionId)
    return false
  }
  return true
}
