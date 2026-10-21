/**
 * Display names of managed vault read connections.
 *
 * Names are labels, never identity: a connection belongs to a vault by the vault row's
 * `connection_id` (or, for an unbound import, its configuration's `vaultId`). The connection pool
 * keeps provider display names unique, but a vault name is unique only among LIVE vaults, and a
 * deleted vault keeps its (disabled) connection so a restore can bring its squads back. Without
 * this, creating a vault under a deleted vault's name could never import its read credential.
 *
 * So each live vault's connection carries its vault's name, and a connection standing on that name
 * is moved aside first: one whose vault is gone or deleted gets a "retired" label; one linked to
 * another live vault (mid-rename) gets a temporary label that its own synchronization replaces.
 */
import { and, eq } from 'drizzle-orm'
import { db, integrationConnections, managedBigbrainVaults } from '../../../../db'

const PROVIDER = 'bigbrain'

export interface ManagedConnectionNames {
  /** Move any other connection off `name` (keeping `keepId`'s) so it can be used. */
  free(name: string, keepId: string | null): Promise<void>
  /** Give a vault's connection its vault's name. Call `free` first. */
  rename(connectionId: string, name: string): Promise<void>
}

async function taken(name: string): Promise<boolean> {
  const [row] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.providerKey, PROVIDER), eq(integrationConnections.displayName, name)))
    .limit(1)
  return Boolean(row)
}

async function setName(connectionId: string, name: string, expectedName?: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ displayName: name, updatedAt: new Date() })
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.providerKey, PROVIDER),
        ...(expectedName === undefined ? [] : [eq(integrationConnections.displayName, expectedName)])
      )
    )
}

export const managedConnectionNames: ManagedConnectionNames = {
  async free(name, keepId) {
    const [holder] = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(and(eq(integrationConnections.providerKey, PROVIDER), eq(integrationConnections.displayName, name)))
      .limit(1)
    if (!holder || holder.id === keepId) return
    const [owner] = await db
      .select({ state: managedBigbrainVaults.state, displayName: managedBigbrainVaults.displayName })
      .from(managedBigbrainVaults)
      .where(eq(managedBigbrainVaults.connectionId, holder.id))
      .limit(1)
    const short = holder.id.slice(0, 8)
    const base = owner && owner.state !== 'deleted' ? `${owner.displayName} (${short})` : `${name} (retired ${short})`
    let label = base
    if (await taken(label)) label = `${base.slice(0, 150)} ${holder.id}`
    await setName(holder.id, label, name)
  },
  async rename(connectionId, name) {
    await setName(connectionId, name)
  },
}
