import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { getSecretStore } from '../../secrets'
import { resolveOAuthAuthority } from '../authorization/authority'
import { isFencedOAuthConnection } from '../oauth-plugin-view'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, integrationConnections } from '../../../db'
import type { IntegrationConnectionRecord } from '../connection-repository'
import {
  isLinearAppConfiguration,
  linearAuthorization,
  linearCredentialCodec,
  linearPlugin,
  parseLinearConfiguration,
} from './plugin'

/**
 * The squad's usable Linear connection and the `Authorization` header value
 * for it: the raw key for an API-key connection, `Bearer <token>` for the app.
 * App connections are also refused while fenced to another OAuth authority or
 * once their access token has expired (the refresh worker renews it first).
 */
export async function resolveLinearConnection(squadId: string, now = new Date()) {
  const connection = await new DbIntegrationConnectionRepository().getAssigned(squadId, 'linear')
  return connection ? usableLinearConnection(connection, now) : null
}

/**
 * The enabled, healthy Linear agent app connection for a workspace, whether or not any squad is
 * assigned to it: every session the app receives is acknowledged, routed or not.
 */
export async function resolveLinearAppConnection(organizationId: string, now = new Date()) {
  const [row] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        eq(integrationConnections.authorizationKind, 'oauth2'),
        eq(integrationConnections.enabled, true),
        sql`${integrationConnections.configuration}->>'organizationId' = ${organizationId}`
      )
    )
    .orderBy(desc(integrationConnections.updatedAt))
    .limit(1)
  if (!row) return null
  const connection = await new DbIntegrationConnectionRepository().get(row.id)
  if (!connection) return null
  const configuration = (() => {
    try {
      return parseLinearConfiguration(connection.configuration)
    } catch {
      return null
    }
  })()
  if (!configuration || !isLinearAppConfiguration(configuration)) return null
  const usable = await usableLinearConnection(connection, now)
  return usable ? { ...usable, configuration } : null
}

/** The `Authorization` value for a connection that is enabled, validated, unfenced and unexpired. */
async function usableLinearConnection(connection: IntegrationConnectionRecord, now: Date) {
  if (
    !connection.enabled ||
    connection.authState !== 'authenticated' ||
    connection.healthState !== 'healthy' ||
    connection.materialRevision !== connection.validatedRevision ||
    !connection.validationExpiresAt ||
    connection.validationExpiresAt.getTime() <= now.getTime() ||
    isFencedOAuthConnection(linearPlugin, connection, resolveOAuthAuthority())
  )
    return null
  const store = getSecretStore()
  await store.refreshKey(connection.credentialRef)
  const raw = store.get(connection.credentialRef)
  if (!raw) return null
  let credential
  try {
    credential = linearCredentialCodec.parse(raw)
  } catch {
    return null
  }
  if (
    credential.kind === 'oauth' &&
    credential.bundle.expiresAt !== null &&
    Date.parse(credential.bundle.expiresAt) <= now.getTime()
  )
    return null
  return { connection, authorization: linearAuthorization(credential) }
}

/**
 * A declared Linear assignment, for authorization checks that need no credential. Validation
 * freshness is deliberately not required: losing it suspends delivery, not the squad's interest.
 */
export async function resolveLinearAssignment(squadId: string) {
  const connection = await new DbIntegrationConnectionRepository().getAssigned(squadId, 'linear')
  if (!connection?.enabled || connection.authState !== 'authenticated') return undefined
  return { id: connection.id }
}
