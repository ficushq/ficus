import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainHostReceipt,
} from '@ficus/shared/managed-bigbrain'
import {
  db,
  integrationConnectionAssignments,
  integrationConnections,
  managedBigbrainVaults,
  squads,
  users,
} from '../../../../db'
import { useEnabledIntegrationFixtures } from '../../../../test-utils/enabled-integrations'
import { squadIntegrationRoutesService } from '../../runtime'
import { managedVaultStore as store, type ManagedVault } from './store'

/**
 * Managed shared vaults offer, list and show as attached only connections of LIVE vaults. A deleted
 * vault keeps its (renamed-aside) read connection and its squad attachments for a restore; those
 * stay hidden until the vault is live again. Every vault, connection and squad is a synthetic
 * fixture; no host or network is reached.
 */
const created = { users: [] as string[], squads: [] as string[], connections: [] as string[] }

const receipt = (row: ManagedVault): ManagedBigbrainHostReceipt => ({
  receiptId: crypto.randomUUID(),
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  vaultId: row.id,
  hostEpoch: 1,
  generation: row.desiredGeneration,
  upstreamVaultId: '33333333-3333-4333-8333-333333333333',
  displayName: row.displayName,
  state: 'ready',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  localPort: null,
  origin: row.origin,
  readAccess: 'active',
})

/** An enabled read connection named `name`. */
async function connection(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: name,
    configuration: {},
    credentialRef: `ref:${id}`,
    enabled: true,
  })
  created.connections.push(id)
  return id
}

/** A ready vault bound to a fresh read connection. */
async function vault(name: string): Promise<{ vaultId: string; connectionId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  created.users.push(user!.id)
  const vaultId = crypto.randomUUID()
  const requested = await store.request({
    vaultId,
    requestId: crypto.randomUUID(),
    displayName: name,
    hostOwnerUserId: user!.id,
    ownerHandle: 'ada',
    ownerDisplay: 'Ada',
    actorUserId: user!.id,
    recipe: {
      origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    },
  })
  await store.applyReceipt(receipt(requested))
  const connectionId = await connection(name)
  await store.bindConnection(vaultId, connectionId)
  return { vaultId, connectionId }
}

const setState = (vaultId: string, state: 'deleted' | 'ready') =>
  db.update(managedBigbrainVaults).set({ state }).where(eq(managedBigbrainVaults.id, vaultId))

async function squad(): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({ name: `live-vaults-${crypto.randomUUID()}`, purpose: 'managed vault fixture' })
    .returning()
  created.squads.push(row!.id)
  return row!.id
}

const attach = (squadId: string, connectionId: string) =>
  db.insert(integrationConnectionAssignments).values({
    squadId,
    providerKey: 'bigbrain',
    connectionId,
    isDefault: false,
  })

const ids = (rows: readonly { id: string }[] | undefined, among: string[]) =>
  (rows ?? []).map((row) => row.id).filter((id) => among.includes(id))

afterEach(async () => {
  if (created.connections.length)
    await db
      .delete(integrationConnectionAssignments)
      .where(inArray(integrationConnectionAssignments.connectionId, created.connections))
  if (created.users.length)
    await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.hostOwnerUserId, created.users))
  if (created.connections.length)
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, created.connections.splice(0)))
  if (created.squads.length) await db.delete(squads).where(inArray(squads.id, created.squads.splice(0)))
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)))
})

test('live connection IDs are those of non-deleted vaults; a deleted vault keeps its connection outside the set', async () => {
  const live = await vault(`Research ${crypto.randomUUID()}`)
  const gone = await vault(`Old ${crypto.randomUUID()}`)
  await setState(gone.vaultId, 'deleted')
  const unbound = await connection(`Orphan ${crypto.randomUUID()}`)
  const set = await store.liveConnectionIds()
  expect(set.has(live.connectionId)).toBe(true)
  expect(set.has(gone.connectionId)).toBe(false)
  expect(set.has(unbound)).toBe(false)
  // The deleted vault's connection is kept (for a restore), just never live.
  expect((await store.get(gone.vaultId))?.connectionId).toBe(gone.connectionId)
})

describe('squad shared-vault selection on Ficus Cloud', () => {
  useEnabledIntegrationFixtures('bigbrain')
  const previousManaged = process.env.FICUS_MANAGED
  beforeAll(() => {
    process.env.FICUS_MANAGED = '1'
  })
  afterAll(() => {
    if (previousManaged === undefined) delete process.env.FICUS_MANAGED
    else process.env.FICUS_MANAGED = previousManaged
  })

  test('managers are offered only live vaults: a retired connection under a reused name is never listed', async () => {
    const name = `ficus-shared ${crypto.randomUUID()}`
    const old = await vault(name)
    await setState(old.vaultId, 'deleted')
    await db
      .update(integrationConnections)
      .set({ displayName: `${name} (retired ${old.connectionId.slice(0, 8)})` })
      .where(eq(integrationConnections.id, old.connectionId))
    const reused = await vault(name)
    const other = await vault(`chlea-shared ${crypto.randomUUID()}`)
    const orphan = await connection(`Orphan ${crypto.randomUUID()}`)
    const squadId = await squad()
    await attach(squadId, other.connectionId)
    const mine = [old.connectionId, reused.connectionId, other.connectionId, orphan]

    const selection = await squadIntegrationRoutesService.selection(squadId, 'bigbrain', { audience: 'manager' })
    expect(ids(selection.connections, mine).sort()).toEqual([reused.connectionId, other.connectionId].sort())
    expect(ids(selection.attached, mine)).toEqual([other.connectionId])
  })

  test('an attachment to a deleted vault is hidden (but kept) for managers and readers, and a restore shows it again', async () => {
    const live = await vault(`Live ${crypto.randomUUID()}`)
    const gone = await vault(`Gone ${crypto.randomUUID()}`)
    const squadId = await squad()
    await attach(squadId, live.connectionId)
    await attach(squadId, gone.connectionId)
    await setState(gone.vaultId, 'deleted')
    const mine = [live.connectionId, gone.connectionId]

    for (const audience of ['manager', 'assigned'] as const) {
      const selection = await squadIntegrationRoutesService.selection(squadId, 'bigbrain', { audience })
      expect([audience, ids(selection.connections, mine)]).toEqual([audience, [live.connectionId]])
      expect([audience, ids(selection.attached, mine)]).toEqual([audience, [live.connectionId]])
    }
    // Not detached: the assignment row survives the delete.
    const kept = await db
      .select()
      .from(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.connectionId, gone.connectionId))
    expect(kept).toHaveLength(1)

    // The vault comes back (restore): its squad attachment is shown again, unchanged.
    await setState(gone.vaultId, 'ready')
    const restored = await squadIntegrationRoutesService.selection(squadId, 'bigbrain', { audience: 'assigned' })
    expect(ids(restored.attached, mine).sort()).toEqual([...mine].sort())
  })

  test('a deleted vault connection cannot be attached, even while its connection is enabled', async () => {
    const gone = await vault(`Gone ${crypto.randomUUID()}`)
    await setState(gone.vaultId, 'deleted')
    const orphan = await connection(`Orphan ${crypto.randomUUID()}`)
    const squadId = await squad()
    for (const connectionId of [gone.connectionId, orphan])
      await expect(squadIntegrationRoutesService.assign(squadId, 'bigbrain', connectionId)).rejects.toThrow(
        'Assignment requires a live shared vault'
      )
    const rows = await db
      .select()
      .from(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.squadId, squadId))
    expect(rows).toHaveLength(0)
  })
})

test('local (Desktop) BigBrain is unchanged: connections without a managed vault are listed', async () => {
  const previousManaged = process.env.FICUS_MANAGED
  delete process.env.FICUS_MANAGED
  try {
    const local = await connection(`Local ${crypto.randomUUID()}`)
    const squadId = await squad()
    const selection = await squadIntegrationRoutesService.selection(squadId, 'bigbrain', { audience: 'manager' })
    expect(ids(selection.connections, [local])).toEqual([local])
  } finally {
    if (previousManaged !== undefined) process.env.FICUS_MANAGED = previousManaged
  }
})
