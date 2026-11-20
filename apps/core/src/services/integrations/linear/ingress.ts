import { and, eq } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { integrationEnabledPredicate } from '../provider-state'
import { publishIntegrationOutputs } from '../outputs/runtime'
import type { VerifiedIngressEvent } from '../types'
import { linearOutputAdapter } from './outputs'
import { linearQuery } from './plugin'
import { resolveLinearConnection } from './resolve-connection'

export interface LinearIssueAccess {
  viewer: { id: string }
  issue: { id: string; team: { id: string }; assignee: { id: string } | null } | null
}
export interface LinearEventIdentity {
  output: string
  issueId: string
  teamId: string
  assignee: string
}
/** Readability by the connected account is the floor; assignment outputs additionally bind that account. */
export function canReceiveLinearEvent(access: LinearIssueAccess, event: LinearEventIdentity) {
  if (access.issue?.id !== event.issueId) return false
  if (event.teamId && access.issue.team?.id !== event.teamId) return false
  if (event.output === 'issue.assigned')
    return !!event.assignee && access.viewer.id === event.assignee && access.issue.assignee?.id === event.assignee
  if (event.output === 'issue.unassigned') return !!event.assignee && access.viewer.id === event.assignee
  return true
}

/** A valid signature proves origin; each connected account must also be able to read the issue. */
export async function routeLinearEvent(event: VerifiedIngressEvent, fallback: (squadId: string) => Promise<void>) {
  const [fact] = linearOutputAdapter.normalize(event)
  if (!fact) return
  const data = fact.data as { issue: { id: string }; teamId?: string; assignee?: string }
  const identity: LinearEventIdentity = {
    output: fact.output,
    issueId: data.issue.id,
    teamId: typeof data.teamId === 'string' ? data.teamId : '',
    assignee: typeof data.assignee === 'string' ? data.assignee : '',
  }
  const assignments = await db
    .select({ squadId: integrationConnectionAssignments.squadId })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        integrationEnabledPredicate(),
        eq(integrationConnections.enabled, true)
      )
    )
  for (const { squadId } of assignments) {
    const resolved = await resolveLinearConnection(squadId)
    if (!resolved) continue
    let access: LinearIssueAccess
    try {
      access = await linearQuery<LinearIssueAccess>(
        resolved.authorization,
        'query IssueAccess($id: String!) { viewer { id } issue(id: $id) { id team { id } assignee { id } } }',
        { id: identity.issueId }
      )
    } catch {
      continue
    }
    if (!canReceiveLinearEvent(access, identity)) continue
    const handled = await publishIntegrationOutputs('linear', event, {
      kind: 'connection',
      squadId,
      connectionId: resolved.connection.id,
      connectionRevision: resolved.connection.materialRevision,
    })
    // Only assignments carry the legacy team-metadata path; other outputs are subscription-only.
    if (identity.output === 'issue.assigned' && !handled.includes(squadId)) await fallback(squadId)
  }
}
