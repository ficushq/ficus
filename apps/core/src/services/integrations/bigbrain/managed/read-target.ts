/**
 * Resolve the bounded read client for one managed shared vault connection from Core's own state:
 * the live Platform capability snapshot, the synchronized vault row, its imported token-free
 * read material, and the connection's credential (the read token). Nothing here accepts an
 * endpoint, path or token from an agent or API caller.
 */
import { managedBigbrainStateSchema } from '@ficus/shared/managed-bigbrain'
import { BigbrainError } from '../errors'
import { BigbrainSharedClient, type ManagedReadVault } from '../shared-client'
import { currentManagedBigbrainCapabilities } from './availability'
import type { ManagedSharedConfig } from './config'
import { managedReadMaterialSchema, managedVaultStore, type ManagedVault } from './store'

export function managedReadVault(row: ManagedVault): ManagedReadVault | null {
  const state = managedBigbrainStateSchema.safeParse(row.state)
  if (!state.success || !['pending', 'active', 'revoked'].includes(row.readAccess)) return null
  return {
    vaultId: row.id,
    upstreamVaultId: row.upstreamVaultId,
    origin: row.origin,
    appliedGeneration: row.appliedGeneration,
    state: state.data,
    readAccess: row.readAccess as ManagedReadVault['readAccess'],
  }
}

export async function resolveManagedReadClient(input: {
  configuration: ManagedSharedConfig
  connectionId?: string
  token: string
  beforeCall: () => Promise<void>
  store?: Pick<typeof managedVaultStore, 'get'>
  capabilities?: typeof currentManagedBigbrainCapabilities
}): Promise<{ client: BigbrainSharedClient; vault: ManagedVault }> {
  const row = await (input.store ?? managedVaultStore).get(input.configuration.vaultId)
  const capabilities = (input.capabilities ?? currentManagedBigbrainCapabilities)()
  const material = managedReadMaterialSchema.safeParse(row?.readMaterial)
  const vault = row ? managedReadVault(row) : null
  if (
    !row ||
    !vault ||
    !capabilities ||
    !material.success ||
    row.upstreamVaultId !== input.configuration.upstreamVaultId ||
    // Before the first bind the row has no connection yet; afterwards only that connection reads.
    (input.connectionId !== undefined && row.connectionId !== null && row.connectionId !== input.connectionId)
  )
    throw new BigbrainError('binding_unavailable')
  const client = new BigbrainSharedClient({
    capabilities,
    vault,
    material: { ...material.data, token: input.token },
    beforeCall: input.beforeCall,
  })
  return { client, vault: row }
}
