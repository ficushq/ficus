import { randomUUID } from 'node:crypto'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import {
  agents,
  db,
  inbox,
  integrationAuditEvents,
  integrationConnectionAssignments,
  integrationConnections,
  integrationCredentialRetirements,
  integrationEventPollingCursors,
  integrationEventPollingDispatches,
  integrationOutputEvents,
  linearAgentSessions,
  linearTeamAccess,
  squads,
  webhookEvents,
  workStreams,
} from '../../../../db'
import { linearDeliveryKey } from '../delivery-receipts'
import { getSecretStore } from '../../../secrets'
import { SELF_HOSTED_OAUTH_APP_KEY } from '../../authorization/client-credentials'
import { serializeOAuthCredential } from '../../authorization/credential-bundle'

export const APP_TOKEN = 'linear-app-access-token'
export const WEBHOOK_SECRET = 'linear-app-webhook-secret'
export const CLIENT_ID = 'linear-client-id'

/**
 * A Linear agent app connection in the test database, optionally assigned to squads with team routes
 * and event rules, plus the self-hosted app settings the direct webhook verifies against.
 */
export async function createLinearAppFixture(
  input: {
    organizationId?: string
    appUserId?: string
    appSettings?: boolean
    /** `platform_broker` for a hosted (relayed) app connection. */
    clientAuthority?: 'local' | 'platform_broker'
  } = {}
) {
  const store = getSecretStore()
  const organizationId = input.organizationId ?? randomUUID()
  const appUserId = input.appUserId ?? randomUUID()
  const connectionId = randomUUID()
  const revision = randomUUID()
  const credentialRef = `__integration-test:linear-app:${connectionId}`
  const squadIds: string[] = []
  await store.set(
    credentialRef,
    serializeOAuthCredential({
      version: 1,
      accessToken: APP_TOKEN,
      refreshToken: 'linear-refresh-token',
      expiresAt: new Date(Date.now() + 86_000_000).toISOString(),
      tokenRevision: 1,
    }),
    'test'
  )
  if (input.appSettings !== false)
    await store.set(
      SELF_HOSTED_OAUTH_APP_KEY.linear,
      JSON.stringify({
        version: 1,
        clientId: CLIENT_ID,
        clientSecret: 'linear-client-secret',
        webhookSecret: WEBHOOK_SECRET,
        capabilitiesAcknowledged: true,
      }),
      'test'
    )
  await db.insert(integrationConnections).values({
    id: connectionId,
    providerKey: 'linear',
    adapterVersion: 1,
    clientAuthority: input.clientAuthority ?? 'local',
    authorizationKind: 'oauth2',
    displayName: `Acme ${connectionId} (Ficus app)`,
    configuration: {
      version: 2,
      mode: 'app',
      organizationId,
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
      appUserId,
      appUserName: 'Ficus',
      scopes: ['read', 'write', 'app:assignable', 'app:mentionable'],
    },
    credentialRef,
    materialRevision: revision,
    validatedRevision: revision,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 900_000),
  })

  async function addSquad(options: { teamIds?: string[]; rules?: unknown[]; manager?: boolean } = {}) {
    const [squad] = await db
      .insert(squads)
      .values({
        name: `linear-app-${randomUUID()}`,
        purpose: 'Linear app fixtures',
        metadata: {
          linear: (options.teamIds ?? []).map((teamId) => ({ teamId })),
          ...(options.rules ? { integrationRules: { linear: options.rules } } : {}),
        },
      })
      .returning()
    if (options.manager !== false) {
      const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: squad!.id }).returning()
      await db.update(squads).set({ managerAgentId: manager!.id }).where(eq(squads.id, squad!.id))
    }
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId: squad!.id, providerKey: 'linear', connectionId, isDefault: true })
    squadIds.push(squad!.id)
    const [row] = await db.select().from(squads).where(eq(squads.id, squad!.id))
    return row!
  }

  /**
   * Removes every row this connection produced, so a later run against the same test database starts
   * from the same state as a fresh one. Delivery receipts are keyed by session and activity, not by
   * connection: they are found through the connection's sessions and prompt outputs before those go.
   */
  async function cleanup() {
    const sessions = await db
      .select({ id: linearAgentSessions.id })
      .from(linearAgentSessions)
      .where(eq(linearAgentSessions.connectionId, connectionId))
    const ownOutputs = sql`${integrationOutputEvents.authority}->>'connectionId' = ${connectionId}`
    const prompts = await db
      .select({ activityId: sql<string | null>`${integrationOutputEvents.fact}#>>'{data,activity,id}'` })
      .from(integrationOutputEvents)
      .where(ownOutputs)
    const receiptKeys = prompts.flatMap((row) => (row.activityId ? [linearDeliveryKey.prompt(row.activityId)] : []))
    if (receiptKeys.length)
      await db
        .delete(integrationEventPollingDispatches)
        .where(inArray(integrationEventPollingDispatches.eventKey, receiptKeys))
    for (const session of sessions)
      await db
        .delete(integrationEventPollingDispatches)
        .where(like(integrationEventPollingDispatches.eventKey, `linear:session:${session.id}:%`))
    await db.delete(integrationOutputEvents).where(ownOutputs)
    await db
      .delete(integrationEventPollingCursors)
      .where(eq(integrationEventPollingCursors.resourceKey, `linear-app:${connectionId}`))
    await db
      .delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, 'linear-app'),
          sql`${webhookEvents.payload}->>'organizationId' = ${organizationId}`
        )
      )
    await db
      .delete(inbox)
      .where(and(eq(inbox.recipientType, 'system'), sql`${inbox.metadata}->>'connectionId' = ${connectionId}`))
    await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.connectionId, connectionId))
    await db.delete(linearAgentSessions).where(eq(linearAgentSessions.connectionId, connectionId))
    await db.delete(linearTeamAccess).where(eq(linearTeamAccess.connectionId, connectionId))
    if (squadIds.length) {
      const squadAgents = db
        .select({ id: sql<string>`${agents.id}::text` })
        .from(agents)
        .where(inArray(agents.squadId, squadIds))
      await db.delete(inbox).where(and(eq(inbox.recipientType, 'agent'), inArray(inbox.recipientId, squadAgents)))
      await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
      await db
        .delete(integrationConnectionAssignments)
        .where(inArray(integrationConnectionAssignments.squadId, squadIds))
      await db.update(squads).set({ managerAgentId: null }).where(inArray(squads.id, squadIds))
      await db.delete(agents).where(inArray(agents.squadId, squadIds))
      await db.delete(squads).where(inArray(squads.id, squadIds))
    }
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    await store.delete(credentialRef).catch(() => undefined)
    await store.delete(SELF_HOSTED_OAUTH_APP_KEY.linear).catch(() => undefined)
    // Deleting a stored credential keeps its ciphertext for an hour of grace; these are the fixture's own.
    await db
      .delete(integrationCredentialRetirements)
      .where(inArray(integrationCredentialRetirements.credentialKey, [credentialRef, SELF_HOSTED_OAUTH_APP_KEY.linear]))
  }

  return {
    organizationId,
    appUserId,
    connectionId,
    revision,
    credentialRef,
    context: { organizationId, oauthClientId: CLIENT_ID, appUserId },
    addSquad,
    cleanup,
  }
}
