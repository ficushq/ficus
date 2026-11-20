import { integrationEnabledPredicate } from '../provider-state'
import { and, eq, gt } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { resolveOAuthAuthority } from '../authorization/authority'
import { isFencedOAuthConnection, type OAuthConnectionFacts } from '../oauth-plugin-view'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'

export interface AgentIntegrationRefs {
  skills: readonly string[]
  extensions: readonly string[]
}

export async function resolveAssignedIntegrationRefs(
  squadId: string | null | undefined
): Promise<AgentIntegrationRefs> {
  if (!squadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(squadId)) {
    return { skills: [], extensions: [] }
  }
  const rows = await db
    .select({
      providerKey: integrationConnections.providerKey,
      adapterVersion: integrationConnections.adapterVersion,
      clientAuthority: integrationConnections.clientAuthority,
      authorizationKind: integrationConnections.authorizationKind,
    })
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
  const skills = new Set<string>()
  const extensions = new Set<string>()
  for (const row of rows.sort((left, right) => left.providerKey.localeCompare(right.providerKey))) {
    const plugin = firstPartyIntegrationPlugin(row.providerKey)
    if (!plugin || plugin.adapterVersion !== row.adapterVersion) continue
    if (isFencedOAuthConnection(plugin, row as OAuthConnectionFacts, resolveOAuthAuthority())) continue
    for (const skill of plugin.sandbox.skills) skills.add(skill)
    for (const extension of plugin.sandbox.extensions) extensions.add(extension)
  }
  return { skills: [...skills].sort(), extensions: [...extensions].sort() }
}

export function mergeAgentRefs(...groups: readonly (readonly string[] | null | undefined)[]): string[] | undefined {
  const values = [...new Set(groups.flatMap((group) => group ?? []))]
  return values.length > 0 ? values : undefined
}
