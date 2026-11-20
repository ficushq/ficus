import { and, eq, sql } from 'drizzle-orm'
import { db, integrationConnections, integrationConnectionAssignments, type DbTx } from '../../../db'
import { isIntegrationEnabled } from '../provider-state'
import type { IntegrationOutputAuthority } from './types'
type Store = typeof db | DbTx

export async function authorized(
  store: Store,
  integration: string,
  authority: IntegrationOutputAuthority,
  squadId: string
): Promise<boolean> {
  if (!(await isIntegrationEnabled(integration, store))) return false
  if (authority.kind === 'instance') return true // Authenticated legacy instance ingress; no user-supplied authority.
  if (authority.squadId !== squadId) return false
  const [row] = await store
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .innerJoin(
      integrationConnectionAssignments,
      and(
        eq(integrationConnectionAssignments.connectionId, integrationConnections.id),
        eq(integrationConnectionAssignments.providerKey, integration)
      )
    )
    .where(
      and(
        eq(integrationConnections.id, authority.connectionId),
        authority.connectionRevision
          ? eq(integrationConnections.materialRevision, authority.connectionRevision)
          : undefined,
        eq(integrationConnections.providerKey, integration),
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnections.enabled, true),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.healthState, 'healthy'),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        sql`${integrationConnections.validationExpiresAt} > clock_timestamp()`
      )
    )
  return !!row
}

/**
 * The account rule audiences compare against: the probed account on the event's authority, else the
 * connection's configured GitHub login or Linear app user.
 */
export function outputAccount(configuration: unknown, authority: IntegrationOutputAuthority): string {
  if (authority.kind === 'connection' && authority.accountId) return authority.accountId
  const config = (configuration ?? {}) as { login?: unknown; appUserId?: unknown }
  if (typeof config.login === 'string') return config.login
  return typeof config.appUserId === 'string' ? config.appUserId : ''
}

/** Linear agent app events whose author is not a trusted workspace member never start work on their own. */
export function isUntrustedOutputActor(integration: string, authority: IntegrationOutputAuthority): boolean {
  return integration === 'linear' && authority.kind === 'connection' && authority.actorTrust === 'untrusted'
}
