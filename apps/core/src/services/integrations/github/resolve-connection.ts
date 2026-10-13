import { reconcileSquadIntegration } from '../scope-settings'
import { integrationEnabledPredicate } from '../provider-state'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { db, integrationConnections, integrationConnectionAssignments } from '../../../db'
import { getSecretStore } from '../../secrets'
import { resolveOAuthAuthority } from '../authorization/authority'
import { parseOAuthCredential } from '../authorization/credential-bundle'
import { parseGitHubConfiguration } from '@ficus/shared/oauth-providers/github/config'

async function assignedGitHubConnection(
  squadId: string,
  expectedConnectionId: string | undefined,
  requireFreshValidation: boolean
) {
  await reconcileSquadIntegration(squadId, 'github')
  const [row] = await db
    .select({ connection: integrationConnections })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.providerKey, 'github'),
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.adapterVersion, 1),
        eq(integrationConnections.clientAuthority, resolveOAuthAuthority()),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.healthState, 'healthy'),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        requireFreshValidation ? gt(integrationConnections.validationExpiresAt, sql`clock_timestamp()`) : undefined,
        expectedConnectionId
          ? eq(integrationConnections.id, expectedConnectionId)
          : eq(integrationConnectionAssignments.isDefault, true)
      )
    )
    .limit(1)
  return row?.connection
}

/** Preserve a declared relay interest across validation expiry; this never returns credentials or authorizes delivery. */
export async function resolveGitHubRelayAssignment(squadId: string, expectedConnectionId?: string) {
  const connection = await assignedGitHubConnection(squadId, expectedConnectionId, false)
  return connection ? { id: connection.id } : undefined
}

/**
 * The squad's default GitHub account for git AUTHOR ATTRIBUTION only: the row's
 * non-secret configuration, never a credential, and never authority to call
 * GitHub (that is {@link resolveGitHubConnection}, unchanged and strict).
 *
 * Who a squad commits as is decided by which enabled account is assigned to it,
 * not by whether that account's token happens to be mid-refresh. So this keeps
 * resolving through the transient states a healthy connection passes through:
 * `refresh_validation_pending` (authState `invalid`, health `degraded`, for the
 * few seconds a rotated token is being validated), a failed periodic validation
 * (health `degraded`, validation cleared) and a lapsed validation window.
 * Resolving them to nothing dropped the author from every box env and
 * reprovisioned the squad's boxes on each token refresh.
 *
 * It still resolves to nothing when the account must not be used: unassigned,
 * disabled (connection or provider), a different client authority, never
 * authorized (`pending`), `reauthorization_required`, or rejected by GitHub
 * (`unreachable`, which is how `invalid_auth` is recorded).
 */
export async function resolveGitHubAuthorAssignment(squadId: string) {
  await reconcileSquadIntegration(squadId, 'github')
  const [row] = await db
    .select({ id: integrationConnections.id, configuration: integrationConnections.configuration })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.providerKey, 'github'),
        eq(integrationConnectionAssignments.isDefault, true),
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.adapterVersion, 1),
        eq(integrationConnections.clientAuthority, resolveOAuthAuthority()),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        inArray(integrationConnections.authState, ['authenticated', 'invalid']),
        inArray(integrationConnections.healthState, ['healthy', 'degraded'])
      )
    )
    .limit(1)
  if (!row) return undefined
  try {
    return { id: row.id, configuration: parseGitHubConfiguration(row.configuration) }
  } catch {
    return undefined
  }
}

/** Runtime authority comes only from the squad's live, validated assignment. */
export async function resolveGitHubConnection(squadId: string, expectedConnectionId?: string) {
  const connection = await assignedGitHubConnection(squadId, expectedConnectionId, true)
  if (!connection) return undefined
  const store = getSecretStore()
  await store.refreshKey(connection.credentialRef)
  try {
    const credential = parseOAuthCredential(store.get(connection.credentialRef))
    if (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now()) return undefined
    return {
      connection,
      configuration: parseGitHubConfiguration(connection.configuration),
      credential,
    }
  } catch {
    return undefined
  }
}

/** Non-secret identities used by onboarding and compatibility webhook routing. */
export async function connectedGitHubLogins(): Promise<string[]> {
  const rows = await db
    .select({ configuration: integrationConnections.configuration })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.healthState, 'healthy'),
        eq(integrationConnections.clientAuthority, resolveOAuthAuthority()),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        gt(integrationConnections.validationExpiresAt, sql`clock_timestamp()`)
      )
    )
  return [
    ...new Set(
      rows.flatMap((row) => {
        try {
          return [parseGitHubConfiguration(row.configuration).login.toLowerCase()]
        } catch {
          return []
        }
      })
    ),
  ]
}

/** Privileged instance operations select explicitly when the pool is ambiguous. */
export async function resolveInstanceGitHubConnection(connectionId?: string) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.adapterVersion, 1),
        eq(integrationConnections.clientAuthority, resolveOAuthAuthority()),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.healthState, 'healthy'),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        gt(integrationConnections.validationExpiresAt, sql`clock_timestamp()`),
        connectionId ? eq(integrationConnections.id, connectionId) : undefined
      )
    )
    .limit(2)
  if (rows.length !== 1) return undefined
  const connection = rows[0]!
  const store = getSecretStore()
  await store.refreshKey(connection.credentialRef)
  try {
    const credential = parseOAuthCredential(store.get(connection.credentialRef))
    if (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now()) return undefined
    return { connection, credential }
  } catch {
    return undefined
  }
}
