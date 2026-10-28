import { integrationEnabledPredicate } from '../provider-state'
import { and, eq, gt } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { resolveOAuthAuthority } from '../authorization/authority'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'
import { projectIntegrationAssignments } from './projector'
import type { IntegrationProjection, IntegrationProjectionInput } from './types'

export async function resolveProtectedBindings(
  projection: IntegrationProjection
): Promise<readonly (readonly [string, string])[]> {
  const values: Array<readonly [string, string]> = []
  for (const [name, resolve] of [...projection.privateMaterial.bindings].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    values.push([name, await resolve()])
  }
  return values
}

export async function loadProtectedIntegrationBindings(
  squadId: string
): Promise<readonly (readonly [string, string])[]> {
  const rows = await db
    .select({ connection: integrationConnections })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnectionAssignments.connectionId, integrationConnections.id))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.isDefault, true),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        gt(integrationConnections.validationExpiresAt, new Date())
      )
    )
  const inputs: IntegrationProjectionInput[] = []
  for (const { connection } of rows) {
    const plugin = firstPartyIntegrationPlugin(connection.providerKey)
    if (!plugin || plugin.adapterVersion !== connection.adapterVersion) continue
    if (plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== resolveOAuthAuthority()) continue
    inputs.push({ plugin, connection })
  }
  const projection = projectIntegrationAssignments(inputs)
  return resolveProtectedBindings(projection)
}
