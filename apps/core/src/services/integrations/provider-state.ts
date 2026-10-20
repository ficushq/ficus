import { bigbrainHostAvailability } from './bigbrain/availability'
import { eq, sql, type SQL } from 'drizzle-orm'
import {
  db,
  settings,
  integrationConnections,
  integrationConnectionAssignments,
  integrationProjectionStates,
  type DbTx,
} from '../../db'

// Separate from each account's enabled flag: toggling a provider preserves account choices.
export const INTEGRATION_ENABLED_PREFIX = '__integration-enabled:'
export function integrationEnabledPredicate(
  provider: string | SQL = sql`${integrationConnections.providerKey}`
): SQL<boolean> {
  const supported = bigbrainHostAvailability().available
  return sql<boolean>`(${supported} or ${provider} <> 'bigbrain') and coalesce((select ${settings.value} = 'true' from ${settings} where ${settings.key} = ${INTEGRATION_ENABLED_PREFIX} || ${provider}), false)`
}
export function effectiveConnectionEnabled(): SQL<boolean> {
  return sql<boolean>`${integrationConnections.enabled} and ${integrationEnabledPredicate()}`
}
export async function isIntegrationEnabled(providerKey: string, store: typeof db | DbTx = db): Promise<boolean> {
  const [row] = await store
    .select({ enabled: integrationEnabledPredicate(providerKey) })
    .from(sql`(values (1)) as singleton`)
  return row.enabled
}
export async function setIntegrationEnabled(providerKey: string, enabled: boolean, actor: string): Promise<string[]> {
  if (providerKey === 'bigbrain' && enabled) {
    const availability = bigbrainHostAvailability()
    if (!availability.available) throw new Error(availability.reason)
  }
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: INTEGRATION_ENABLED_PREFIX + providerKey, value: String(enabled), updatedBy: actor })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: String(enabled), updatedBy: actor, updatedAt: new Date() },
      })
    const assigned = await tx
      .selectDistinct({ squadId: integrationConnectionAssignments.squadId })
      .from(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.providerKey, providerKey))
    for (const { squadId } of assigned) await invalidateProjection(tx, squadId, providerKey)
    return assigned.map(({ squadId }) => squadId)
  })
}

export async function invalidateProjection(tx: DbTx, squadId: string, providerKey: string): Promise<void> {
  const now = new Date()
  await tx
    .insert(integrationProjectionStates)
    .values({ squadId, providerKey, nextAttemptAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [integrationProjectionStates.squadId, integrationProjectionStates.providerKey],
      set: {
        generation: sql`${integrationProjectionStates.generation} + 1`,
        status: 'pending',
        nextAttemptAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: now,
      },
    })
}
