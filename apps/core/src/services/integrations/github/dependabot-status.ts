import { and, eq } from 'drizzle-orm'
import { db, squads, integrationConnections, integrationConnectionAssignments } from '../../../db'
import { InboxMessage } from '../../../entities/InboxMessage'
import { isIntegrationEnabled } from '../provider-state'
import { DbIntegrationAuditRecorder } from '../db-audit'

/** A failed discovery is not a report of zero alerts. No token or vulnerability details enter this notice. */
export async function reportDependabotUnavailable(squadId: string, connectionId: string) {
  if (!(await isIntegrationEnabled('github'))) return
  const [squad] = await db
    .select({ managerId: squads.managerAgentId })
    .from(squads)
    .innerJoin(integrationConnectionAssignments, eq(integrationConnectionAssignments.squadId, squads.id))
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(squads.id, squadId),
        eq(squads.status, 'active'),
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.enabled, true)
      )
    )
  if (!squad) return
  await new DbIntegrationAuditRecorder().record({
    connectionId,
    squadId,
    capability: 'event_polling',
    action: 'dependabot_discovery',
    outcome: 'failed',
    code: 'discovery_unavailable',
    at: new Date(),
  })
  if (!squad.managerId) return
  await InboxMessage.sendOnce(
    {
      recipientId: squad.managerId,
      senderType: 'system',
      subject: 'Dependabot discovery unavailable',
      content:
        'GitHub dependency-security discovery could not read alerts for a configured repository. This does NOT mean there are no vulnerabilities. Check the connected account’s repository access and Dependabot alerts read permission. Discovery retries automatically; no alert or repository security settings have been changed.',
      metadata: { source: 'integration-notification' },
      wakeEligible: true,
    },
    `dependabot-unavailable:${squadId}:${connectionId}:${new Date().toISOString().slice(0, 10)}`
  )
}
