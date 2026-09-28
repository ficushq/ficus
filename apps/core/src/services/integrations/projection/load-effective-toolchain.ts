import { integrationEnabledPredicate } from '../provider-state'
import { and, eq, gt } from 'drizzle-orm'
import type { SandboxToolchainConfig } from '@ficus/shared'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { resolveOAuthAuthority } from '../authorization/authority'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'
import { resolveEffectiveToolchain } from './effective-toolchain'
import { projectIntegrationAssignments } from './projector'
import type { IntegrationProjectionInput } from './types'

export async function loadEffectiveToolchain(
  squadId: string,
  squadConfig: SandboxToolchainConfig | undefined
): Promise<ReturnType<typeof resolveEffectiveToolchain> & { integrationFingerprint: string }> {
  const rows = await db
    .select({ connection: integrationConnections })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnectionAssignments.connectionId, integrationConnections.id))
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, squadId),
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
  return {
    ...resolveEffectiveToolchain(squadConfig, projection.publicDeclaration),
    integrationFingerprint: projection.fingerprint,
  }
}
