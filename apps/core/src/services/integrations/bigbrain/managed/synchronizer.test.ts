import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainReadHandoff,
  type ManagedBigbrainVaultSummary,
} from '@ficus/shared/managed-bigbrain'
import { db, integrationConnections, managedBigbrainVaults, users } from '../../../../db'
import type { IntegrationConnectionRecord } from '../../connection-repository'
import { clearManagedBigbrainCapabilities, managedBigbrainAvailability } from './availability'
import { managedVaultStore as store } from './store'
import { synchronizeManagedBigbrain, type ManagedSyncConnections } from './synchronizer'

const previousManaged = process.env.FICUS_MANAGED
beforeAll(() => {
  process.env.FICUS_MANAGED = '1'
})
afterAll(() => {
  if (previousManaged === undefined) delete process.env.FICUS_MANAGED
  else process.env.FICUS_MANAGED = previousManaged
})
const owners: string[] = []
const connectionIds: string[] = []
afterEach(async () => {
  clearManagedBigbrainCapabilities()
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.ownerUserId, owners))
  await db.delete(users).where(inArray(users.id, owners.splice(0)))
  await db.delete(integrationConnections).where(inArray(integrationConnections.id, connectionIds.splice(0)))
})

const TENANT = '11111111-1111-4111-8111-111111111111'
const HOST = '77777777-7777-4777-8777-777777777777'
const capabilities = (patch: Partial<ManagedBigbrainCapabilities> = {}): ManagedBigbrainCapabilities => ({
  contractVersion: 1,
  tenantId: TENANT,
  physicalHostBinding: HOST,
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  sharedProtocol: 1,
  hostEpoch: 2,
  hostState: 'active',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: new Date().toISOString(),
  ...patch,
})
const origin = (id: string) => `https://bb-${id.replaceAll('-', '')}.vaults.example.com`
const token = (credentialId: string) => `sv_${credentialId}_${'A'.repeat(43)}`

async function vault(name = `Vault ${crypto.randomUUID()}`) {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  owners.push(user!.id)
  const row = await store.request({
    requestId: crypto.randomUUID(),
    displayName: name,
    ownerUserId: user!.id,
    actorUserId: user!.id,
  })
  const upstreamVaultId = crypto.randomUUID()
  const summary = (patch: Partial<ManagedBigbrainVaultSummary> = {}): ManagedBigbrainVaultSummary => ({
    contractVersion: 1,
    vaultId: row.id,
    displayName: row.displayName,
    ownerUserId: user!.id,
    state: 'ready',
    readAccess: 'active',
    desiredGeneration: 1,
    appliedGeneration: 1,
    upstreamVaultId,
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    origin: origin(row.id),
    operationId: crypto.randomUUID(),
    lastErrorCode: null,
    retryable: false,
    updatedAt: new Date().toISOString(),
    ...patch,
  })
  const handoff = (patch: Partial<ManagedBigbrainReadHandoff> = {}): ManagedBigbrainReadHandoff => {
    const credentialId = patch.credentialId ?? '0123abcd'
    return {
      contractVersion: 1,
      tenantId: TENANT,
      physicalHostBinding: HOST,
      vaultId: row.id,
      hostEpoch: 1,
      generation: 1,
      upstreamVaultId,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      credentialId,
      kind: 'agent',
      scopes: ['read'],
      followsMember: false,
      token: token(credentialId),
      ...patch,
    }
  }
  return { row, summary, handoff }
}

/** In-memory pool standing in for the connection service + repository + credential store. */
function pool(options: { failCreateAfterInsert?: boolean } = {}) {
  const rows = new Map<string, IntegrationConnectionRecord & { enabled: boolean }>()
  const secrets = new Map<string, string>()
  const calls: string[] = []
  let failCreate = options.failCreateAfterInsert ?? false
  const connections: ManagedSyncConnections = {
    async create(input) {
      const id = crypto.randomUUID()
      const credentialRef = `ref:${id}:1`
      // A real pool row: the vault row's connection_id is a foreign key.
      await db.insert(integrationConnections).values({
        id,
        providerKey: input.providerKey,
        adapterVersion: input.adapterVersion,
        displayName: `${input.displayName} ${id}`,
        configuration: input.configuration,
        credentialRef,
      })
      connectionIds.push(id)
      secrets.set(credentialRef, input.credential)
      rows.set(id, {
        id,
        providerKey: input.providerKey,
        configuration: input.configuration,
        credentialRef,
        enabled: false,
      } as never)
      calls.push(`create:${(input.configuration as { vaultId: string }).vaultId}`)
      if (failCreate) {
        failCreate = false
        throw new Error('committed but acknowledgement lost')
      }
      return { id }
    },
    async replaceCredential(id, credential) {
      const ref = `ref:${id}:${crypto.randomUUID()}`
      secrets.set(ref, credential)
      rows.set(id, { ...rows.get(id)!, credentialRef: ref })
      calls.push(`rotate:${id}`)
    },
    async enable(id) {
      rows.set(id, { ...rows.get(id)!, enabled: true })
      calls.push(`enable:${id}`)
    },
    async disable(id) {
      rows.set(id, { ...rows.get(id)!, enabled: false })
      calls.push(`disable:${id}`)
    },
  }
  return {
    rows,
    calls,
    deps: (
      platform: { caps: ManagedBigbrainCapabilities; items: ManagedBigbrainVaultSummary[] },
      handoffs: Map<string, ManagedBigbrainReadHandoff>
    ) => ({
      platform: {
        capabilities: async () => platform.caps,
        listVaults: async () => ({ items: platform.items }),
      },
      readHandoff: async (id: string) => handoffs.get(id) ?? null,
      connections,
      listConnections: async () => [...rows.values()],
      getConnection: async (id: string) => rows.get(id) ?? null,
      credential: (ref: string) => secrets.get(ref),
    }),
  }
}

test('a ready vault with a matching host handoff becomes exactly one enabled pool connection', async () => {
  const a = await vault()
  const p = pool()
  const deps = p.deps({ caps: capabilities(), items: [a.summary()] }, new Map([[a.row.id, a.handoff()]]))
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('imported')
  expect(managedBigbrainAvailability().available).toBe(true)
  const bound = await store.get(a.row.id)
  expect(bound?.connectionId).toBeTruthy()
  expect(JSON.stringify(bound?.readMaterial)).not.toContain('sv_')
  expect(p.rows.get(bound!.connectionId!)?.enabled).toBe(true)
  // Re-running (restart, timer) never duplicates.
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('current')
  expect(p.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1)
})

test('a lost create acknowledgement adopts the orphaned connection instead of creating another', async () => {
  const a = await vault()
  const p = pool({ failCreateAfterInsert: true })
  const deps = p.deps({ caps: capabilities(), items: [a.summary()] }, new Map([[a.row.id, a.handoff()]]))
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('failed')
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('imported')
  expect(p.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1)
  const bound = await store.get(a.row.id)
  expect(p.rows.get(bound!.connectionId!)?.enabled).toBe(true)
})

test('a handoff for another host, tenant, future generation or pin is never imported', async () => {
  const a = await vault()
  for (const bad of [
    a.handoff({ physicalHostBinding: crypto.randomUUID() }),
    a.handoff({ tenantId: crypto.randomUUID() }),
    a.handoff({ generation: 2 }),
    a.handoff({ hostEpoch: 3 }),
    a.handoff({ upstreamVaultId: crypto.randomUUID() }),
  ]) {
    const p = pool()
    const deps = p.deps({ caps: capabilities(), items: [a.summary()] }, new Map([[a.row.id, bad]]))
    expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('handoff_mismatch')
    expect(p.calls).toEqual([])
  }
  expect((await store.get(a.row.id))?.readMaterial).toBeNull()
})

test('revocation and deletion fence: material is forgotten and the connection disabled, not deleted', async () => {
  const a = await vault()
  const b = await vault()
  const p = pool()
  const handoffs = new Map([
    [a.row.id, a.handoff()],
    [b.row.id, b.handoff({ credentialId: '89abcdef' })],
  ])
  const platform = { caps: capabilities(), items: [a.summary(), b.summary()] }
  await synchronizeManagedBigbrain(p.deps(platform, handoffs))
  const connA = (await store.get(a.row.id))!.connectionId!
  const connB = (await store.get(b.row.id))!.connectionId!
  platform.items = [
    a.summary({ readAccess: 'revoked', desiredGeneration: 2, appliedGeneration: 2 }),
    b.summary({ state: 'deleted', desiredGeneration: 3, appliedGeneration: 3 }),
  ]
  const report = await synchronizeManagedBigbrain(p.deps(platform, handoffs))
  expect(report.vaults).toEqual({ [a.row.id]: 'fenced', [b.row.id]: 'fenced' })
  expect((await store.get(a.row.id))?.readMaterial).toBeNull()
  expect([p.rows.get(connA)?.enabled, p.rows.get(connB)?.enabled]).toEqual([false, false])
  expect(p.rows.size).toBe(2)
})

test('a newly minted credential (reconnect) rotates and re-enables; a human disable is not undone', async () => {
  const a = await vault()
  const p = pool()
  const handoffs = new Map([[a.row.id, a.handoff()]])
  const platform = { caps: capabilities(), items: [a.summary()] }
  await synchronizeManagedBigbrain(p.deps(platform, handoffs))
  const id = (await store.get(a.row.id))!.connectionId!
  // A person disables the connection: same credential, so sync leaves it disabled.
  await p.deps(platform, handoffs).connections.disable(id)
  expect((await synchronizeManagedBigbrain(p.deps(platform, handoffs))).vaults[a.row.id]).toBe('current')
  expect(p.rows.get(id)?.enabled).toBe(false)
  // Explicit reconnect minted a new credential at a later generation.
  platform.items = [a.summary({ desiredGeneration: 3, appliedGeneration: 3 })]
  handoffs.set(a.row.id, a.handoff({ credentialId: 'fedcba98', generation: 3 }))
  expect((await synchronizeManagedBigbrain(p.deps(platform, handoffs))).vaults[a.row.id]).toBe('rotated')
  expect(p.rows.get(id)?.enabled).toBe(true)
  expect(p.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1)
})

test('suspended or unreachable Platform imports nothing; an unknown vault is never adopted', async () => {
  const a = await vault()
  const p = pool()
  const handoffs = new Map([[a.row.id, a.handoff()]])
  const suspended = capabilities({ available: false, reasonCode: 'maintenance', hostState: 'suspended' })
  expect((await synchronizeManagedBigbrain(p.deps({ caps: suspended, items: [a.summary()] }, handoffs))).skipped).toBe(
    'unavailable'
  )
  const down = p.deps({ caps: capabilities(), items: [] }, handoffs)
  down.platform.capabilities = async () => {
    throw new Error('host unreachable')
  }
  expect((await synchronizeManagedBigbrain(down)).skipped).toBe('capabilities_unavailable')
  expect(managedBigbrainAvailability().available).toBe(false)
  const stranger = { ...a.summary(), vaultId: crypto.randomUUID(), origin: null }
  const report = await synchronizeManagedBigbrain(p.deps({ caps: capabilities(), items: [stranger] }, handoffs))
  expect(report.vaults).toEqual({})
  expect(p.calls).toEqual([])
})
