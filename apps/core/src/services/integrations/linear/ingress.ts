import { and, eq } from 'drizzle-orm'
import type { IntegrationOutputFact } from '@ficus/shared'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { integrationEnabledPredicate } from '../provider-state'
import { publishIntegrationOutputs } from '../outputs/runtime'
import type { VerifiedIngressEvent } from '../types'
import { linearOutputAdapter } from './outputs'
import { linearQuery } from './plugin'
import { resolveLinearConnection } from './resolve-connection'

export interface LinearIssueAccess {
  viewer: { id: string }
  issue: {
    id: string
    team: { id: string }
    assignee: { id: string } | null
    delegate?: { id: string } | null
  } | null
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
  const facts = linearOutputAdapter.normalize(event)
  const [fact] = facts
  if (!fact) return
  const identity = factIdentity(fact)
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
    // The agent app has its own webhook, probe and trust check (app-ingress.ts); the organization
    // webhook serves API-key connections only, so the two authorities never mix.
    if (!resolved || resolved.connection.authorizationKind === 'oauth2') continue
    let access: LinearIssueAccess
    try {
      access = await linearQuery<LinearIssueAccess>(
        resolved.authorization,
        'query IssueAccess($id: String!) { viewer { id } issue(id: $id) { id team { id } assignee { id } delegate { id } } }',
        { id: identity.issueId }
      )
    } catch {
      continue
    }
    // Each fact of the delivery is checked on its own: a squad that may not see the assignment can
    // still receive a delegation change from the same update.
    const receivable = (item: IntegrationOutputFact) => canReceiveLinearEvent(access, factIdentity(item))
    if (!facts.some(receivable)) continue
    const handled = await publishIntegrationOutputs(
      'linear',
      event,
      {
        kind: 'connection',
        squadId,
        connectionId: resolved.connection.id,
        connectionRevision: resolved.connection.materialRevision,
        // Rule audiences and self-comment suppression bind to the probed viewer, never to payload claims.
        accountId: access.viewer.id,
        // API-key connections have no author check (design 5.6 applies to the agent app); say so explicitly.
        actorTrust: 'trusted',
      },
      (normalized) => normalized.filter(receivable).map((item) => withIssueInvolvement(item, access))
    )
    // Only assignments carry the legacy team-metadata path; other outputs are subscription-only.
    if (identity.output === 'issue.assigned' && receivable(fact) && !handled.includes(squadId)) await fallback(squadId)
  }
}

/**
 * A comment payload names only the issue, so the probed team, assignee and delegate complete it for
 * team routing and `assigned-or-mentioned` audiences. Assignment and delegation facts keep the user who changed.
 */
function withIssueInvolvement(fact: IntegrationOutputFact, access: LinearIssueAccess): IntegrationOutputFact {
  if (fact.output !== 'issue.comment' || !access.issue) return fact
  return {
    ...fact,
    data: {
      ...fact.data,
      teamId: (fact.data.teamId as string) || access.issue.team?.id || '',
      assignee: (fact.data.assignee as string) || access.issue.assignee?.id || '',
      delegate: (fact.data.delegate as string) || access.issue.delegate?.id || '',
    },
  }
}

function factIdentity(fact: IntegrationOutputFact): LinearEventIdentity {
  const data = fact.data as { issue: { id: string }; teamId?: string; assignee?: string }
  return {
    output: fact.output,
    issueId: data.issue.id,
    teamId: typeof data.teamId === 'string' ? data.teamId : '',
    assignee: typeof data.assignee === 'string' ? data.assignee : '',
  }
}
