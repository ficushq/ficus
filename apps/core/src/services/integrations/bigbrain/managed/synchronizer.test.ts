import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainHostReceipt,
  type ManagedBigbrainReadHandoff,
} from '@ficus/shared/managed-bigbrain'
import { db, integrationAuditEvents, integrationConnections, managedBigbrainVaults, users } from '../../../../db'
import type { IntegrationConnectionRecord } from '../../connection-repository'
import { clearManagedBigbrainCapabilities } from './availability'
import { managedVaultStore as store } from './store'
import {
  connectionDisabledByPerson,
  MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS,
  MANAGED_BIGBRAIN_SYNC_ACTOR,
  synchronizeManagedBigbrain,
  type ManagedSyncConnections,
} from './synchronizer'

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
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.hostOwnerUserId, owners))
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
  zone: 'vaults.example.com',
  tenantLabel: null,
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
  const vaultId = crypto.randomUUID()
  const created = await store.request({
    vaultId,
    requestId: crypto.randomUUID(),
    displayName: name,
    hostOwnerUserId: user!.id,
    ownerHandle: 'ada',
    ownerDisplay: 'Ada',
    actorUserId: user!.id,
    recipe: {
      origin: origin(vaultId),
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    },
  })
  const upstreamVaultId = crypto.randomUUID()
  /** Apply a host receipt for this vault (what the reconciler does). */
  const receipt = async (patch: Partial<ManagedBigbrainHostReceipt> = {}) =>
    store.applyReceipt({
      receiptId: crypto.randomUUID(),
      tenantId: TENANT,
      physicalHostBinding: HOST,
      vaultId,
      hostEpoch: 1,
      generation: 1,
      upstreamVaultId,
      displayName: name,
      state: 'ready',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      localPort: null,
      origin: origin(vaultId),
      readAccess: 'active',
      ...patch,
    })
  const row = await receipt()
  void created
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
  return { row, receipt, handoff }
}

async function withName<T extends { id: string }>(row: T): Promise<T & { displayName: string }> {
  const [stored] = await db
    .select({ displayName: integrationConnections.displayName })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, row.id))
  return { ...row, displayName: stored?.displayName ?? '' }
}
const connectionName = async (id: string) => (await withName({ id })).displayName

/** In-memory pool standing in for the connection service + repository + credential store. */
function pool(options: { failCreateAfterInsert?: boolean } = {}) {
  const rows = new Map<string, IntegrationConnectionRecord & { enabled: boolean }>()
  const secrets = new Map<string, string>()
  const calls: string[] = []
  const personDisabled = new Set<string>()
  let failCreate = options.failCreateAfterInsert ?? false
  /** Live validation failures for the next enables (the real service validates, then throws). */
  const enableFailures: string[] = []
  let clock = new Date()
  const connections: ManagedSyncConnections = {
    async create(input) {
      const id = crypto.randomUUID()
      const credentialRef = `ref:${id}:1`
      calls.push(`create:${(input.configuration as { vaultId: string }).vaultId}`)
      // A real pool row under the exact display name: the pool's unique (provider, name) index
      // applies, and a refused insert stores nothing (the service retires the credential).
      await db.insert(integrationConnections).values({
        id,
        providerKey: input.providerKey,
        adapterVersion: input.adapterVersion,
        displayName: input.displayName,
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
      if (failCreate) {
        failCreate = false
        throw new Error('committed but acknowledgement lost')
      }
      return { id }
    },
    async replaceCredential(id, credential, _actor, _confirm, configuration) {
      const ref = `ref:${id}:${crypto.randomUUID()}`
      secrets.set(ref, credential)
      rows.set(id, {
        ...rows.get(id)!,
        credentialRef: ref,
        ...(configuration === undefined ? {} : { configuration }),
      })
      calls.push(`rotate:${id}${configuration === undefined ? '' : ':configuration'}`)
    },
    async enable(id, actor) {
      const failure = enableFailures.shift()
      rows.set(id, { ...rows.get(id)!, validatedAt: clock, lastErrorCode: failure ?? null })
      if (failure) throw new Error(`Integration authentication failed: ${failure}`)
      rows.set(id, { ...rows.get(id)!, enabled: true })
      personDisabled.delete(id)
      calls.push(`enable:${id}:${actor}`)
    },
    async disable(id, actor) {
      rows.set(id, { ...rows.get(id)!, enabled: false })
      if (actor?.startsWith('user:') || actor?.startsWith('agent:')) personDisabled.add(id)
      calls.push(`disable:${id}`)
    },
  }
  /** Track a connection created outside the synchronizer (an orphan from an earlier attempt). */
  const adopt = (row: IntegrationConnectionRecord & { enabled: boolean }, credential: string) => {
    rows.set(row.id, row)
    secrets.set(row.credentialRef, credential)
  }
  return {
    rows,
    calls,
    adopt,
    enableFailures,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    deps: (caps: ManagedBigbrainCapabilities | null, handoffs: Map<string, ManagedBigbrainReadHandoff>) => ({
      capabilities: () => caps,
      readHandoff: async (id: string) => handoffs.get(id) ?? null,
      connections,
      // Names live in the database (the synchronizer renames rows there).
      listConnections: async () => Promise.all([...rows.values()].map(withName)),
      getConnection: async (id: string) => (rows.has(id) ? withName(rows.get(id)!) : null),
      credential: (ref: string) => secrets.get(ref),
      disabledByPerson: async (id: string) => personDisabled.has(id),
      now: () => clock,
    }),
  }
}

test('a ready vault with a matching host handoff becomes exactly one enabled pool connection', async () => {
  const a = await vault()
  const p = pool()
  const deps = p.deps(capabilities(), new Map([[a.row.id, a.handoff()]]))
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('imported')
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
  const deps = p.deps(capabilities(), new Map([[a.row.id, a.handoff()]]))
  expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('failed')
  p.advance(MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS)
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
    const deps = p.deps(capabilities(), new Map([[a.row.id, bad]]))
    expect((await synchronizeManagedBigbrain(deps)).vaults[a.row.id]).toBe('handoff_mismatch')
    expect(p.calls).toEqual([])
    // Recorded for settings (and backed off); cleared here so the next shape is checked now.
    expect((await store.get(a.row.id))?.readSyncErrorCode).toBe('handoff_mismatch')
    await store.clearReadSyncFailure(a.row.id)
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
  await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))
  const connA = (await store.get(a.row.id))!.connectionId!
  const connB = (await store.get(b.row.id))!.connectionId!
  await store.requestOperation(a.row.id, {
    action: 'read-revoke',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
  })
  await store.requestOperation(b.row.id, { action: 'delete', requestId: crypto.randomUUID(), expectedGeneration: 1 })
  // Fences are local: they apply even while the host is unavailable.
  const report = await synchronizeManagedBigbrain(p.deps(null, handoffs))
  expect([report.vaults[a.row.id], report.vaults[b.row.id]]).toEqual(['fenced', 'fenced'])
  expect((await store.get(a.row.id))?.readMaterial).toBeNull()
  expect([p.rows.get(connA)?.enabled, p.rows.get(connB)?.enabled]).toEqual([false, false])
  expect(p.rows.size).toBe(2)
})

test('a newly minted credential (reconnect) rotates and re-enables; a human disable is not undone', async () => {
  const a = await vault()
  const p = pool()
  const handoffs = new Map([[a.row.id, a.handoff()]])
  await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))
  const id = (await store.get(a.row.id))!.connectionId!
  // A person disables the connection: same credential, so sync leaves it disabled.
  await p.deps(capabilities(), handoffs).connections.disable(id, `user:${crypto.randomUUID()}`)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('current')
  expect(p.rows.get(id)?.enabled).toBe(false)
  // Explicit reconnect minted a new credential at a later generation.
  await store.requestOperation(a.row.id, {
    action: 'read-revoke',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
  })
  await a.receipt({ generation: 2, readAccess: 'revoked' })
  await store.requestOperation(a.row.id, {
    action: 'read-reconnect',
    requestId: crypto.randomUUID(),
    expectedGeneration: 2,
  })
  await a.receipt({ generation: 3 })
  handoffs.set(a.row.id, a.handoff({ credentialId: 'fedcba98', generation: 3 }))
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('rotated')
  expect(p.rows.get(id)?.enabled).toBe(true)
  expect(p.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1)
})

test('without an eligible host nothing is imported', async () => {
  const a = await vault()
  const p = pool()
  const report = await synchronizeManagedBigbrain(p.deps(null, new Map([[a.row.id, a.handoff()]])))
  expect(report.vaults[a.row.id]).toBe('pending_handoff')
  expect(p.calls).toEqual([])
})

test('an import whose enable failed validation is re-enabled automatically after the backoff', async () => {
  // The live bug: create + bind committed, then the enable's live validation failed (gateway not
  // serving yet). Every later run saw the same credential and reported "current" forever.
  const a = await vault()
  const p = pool()
  p.enableFailures.push('unavailable')
  const handoffs = new Map([[a.row.id, a.handoff()]])
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('failed')
  const id = (await store.get(a.row.id))!.connectionId!
  expect(p.rows.get(id)?.enabled).toBe(false)
  // The failure is recorded on the vault (shown in settings), and the next run only waits.
  expect(await store.get(a.row.id)).toMatchObject({ readSyncErrorCode: 'unavailable', readSyncAttempts: 1 })
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('backoff')
  p.advance(MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('reenabled')
  expect(p.rows.get(id)?.enabled).toBe(true)
  expect(p.calls).toContain(`enable:${id}:${MANAGED_BIGBRAIN_SYNC_ACTOR}`)
  expect(p.calls.filter((c) => c.startsWith('create:') || c.startsWith('rotate:'))).toHaveLength(1)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('current')
  expect(await store.get(a.row.id)).toMatchObject({
    readSyncErrorCode: null,
    readSyncAttempts: 0,
    readSyncNextAt: null,
  })
})

test('a runtime authentication fence is retried, and stays off while validation keeps failing', async () => {
  const a = await vault()
  const p = pool()
  const handoffs = new Map([[a.row.id, a.handoff()]])
  await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))
  const id = (await store.get(a.row.id))!.connectionId!
  // A tool call saw 401: the runtime fence disables with no person behind it.
  await p.deps(capabilities(), handoffs).connections.disable(id)
  // The owner really removed the reader upstream: validation fails, nothing is repaired.
  p.enableFailures.push('invalid_auth')
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('failed')
  expect(p.rows.get(id)?.enabled).toBe(false)
  expect(p.rows.get(id)?.lastErrorCode).toBe('invalid_auth')
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('backoff')
  // A transient 401 instead: the next attempt after the backoff validates and re-enables.
  p.advance(MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('reenabled')
  expect(p.rows.get(id)?.enabled).toBe(true)
})

test("only a person's latest disable counts as a deliberate disable", async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  owners.push(user!.id)
  const id = crypto.randomUUID()
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: `Vault ${id}`,
    configuration: {},
    credentialRef: `ref:${id}`,
  })
  connectionIds.push(id)
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds))
  const event = (action: string, seconds: number, userId?: string) =>
    db
      .insert(integrationAuditEvents)
      .values({ connectionId: id, userId, action, outcome: 'succeeded', createdAt: at(seconds) })
  try {
    expect(await connectionDisabledByPerson(id)).toBe(false)
    await event('connection_enable', 1)
    await event('connection_disable', 2)
    expect(await connectionDisabledByPerson(id)).toBe(false)
    await event('connection_disable', 3, user!.id)
    // Unrelated later events (tool calls, assignments) do not hide the person's disable.
    await event('assignment_set', 4, user!.id)
    expect(await connectionDisabledByPerson(id)).toBe(true)
    await event('connection_enable', 5)
    expect(await connectionDisabledByPerson(id)).toBe(false)
  } finally {
    await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.connectionId, [id]))
  }
})

/** Tombstone a vault the way a confirmed delete does (its connection stays, disabled). */
async function tombstone(v: Awaited<ReturnType<typeof vault>>) {
  const deleting = await store.requestOperation(v.row.id, {
    action: 'delete',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
  })
  await v.receipt({ generation: deleting.desiredGeneration, state: 'deleted', readAccess: 'revoked' })
}

test("a vault re-created under a deleted vault's name imports under that exact name", async () => {
  // The live bug: the deleted vault keeps its disabled connection named "ficus-shared", the pool
  // keeps connection names unique, and every import of the new vault failed on it, silently.
  const name = `ficus-shared ${crypto.randomUUID().slice(0, 8)}`
  const old = await vault(name)
  const p = pool()
  const handoffs = new Map([[old.row.id, old.handoff()]])
  await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))
  const oldConnection = (await store.get(old.row.id))!.connectionId!
  expect(await connectionName(oldConnection)).toBe(name)
  await tombstone(old)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[old.row.id]).toBe('fenced')

  const fresh = await vault(name)
  handoffs.set(fresh.row.id, fresh.handoff({ credentialId: '89abcdef' }))
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[fresh.row.id]).toBe('imported')
  const linked = (await store.get(fresh.row.id))!.connectionId!
  expect(await connectionName(linked)).toBe(name)
  expect(p.rows.get(linked)?.enabled).toBe(true)
  // The deleted vault keeps its (disabled) connection and binding, under a retired label.
  expect(await connectionName(oldConnection)).toBe(`${name} (retired ${oldConnection.slice(0, 8)})`)
  expect(p.rows.get(oldConnection)?.enabled).toBe(false)
  expect((await store.get(old.row.id))?.connectionId).toBe(oldConnection)
})

test('an unlinked same-name connection of no vault does not block linking', async () => {
  const name = `ficus-shared ${crypto.randomUUID().slice(0, 8)}`
  const a = await vault(name)
  const p = pool()
  const orphanId = crypto.randomUUID()
  await db.insert(integrationConnections).values({
    id: orphanId,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: name,
    configuration: { mode: 'managed_shared', vaultId: crypto.randomUUID() },
    credentialRef: `ref:${orphanId}`,
  })
  connectionIds.push(orphanId)
  const handoffs = new Map([[a.row.id, a.handoff()]])
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('imported')
  expect(await connectionName((await store.get(a.row.id))!.connectionId!)).toBe(name)
  expect(await connectionName(orphanId)).toBe(`${name} (retired ${orphanId.slice(0, 8)})`)
})

test('an unbound connection of this vault with a stale configuration is adopted and repaired', async () => {
  const a = await vault()
  const p = pool()
  const id = crypto.randomUUID()
  const stale = {
    version: 2,
    mode: 'managed_shared',
    vaultId: a.row.id,
    upstreamVaultId: crypto.randomUUID(),
    upstreamCommit: '0'.repeat(40),
  }
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: `Earlier ${id}`,
    configuration: stale,
    credentialRef: `ref:${id}`,
  })
  connectionIds.push(id)
  p.adopt(
    { id, providerKey: 'bigbrain', configuration: stale, credentialRef: `ref:${id}`, enabled: false } as never,
    token('0123abcd')
  )
  const handoffs = new Map([[a.row.id, a.handoff()]])
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('rotated')
  expect((await store.get(a.row.id))?.connectionId).toBe(id)
  expect(p.calls).toContain(`rotate:${id}:configuration`)
  expect(p.calls.some((c) => c.startsWith('create:'))).toBe(false)
  expect((p.rows.get(id)?.configuration as { upstreamVaultId: string }).upstreamVaultId).toBe(
    a.handoff().upstreamVaultId
  )
  expect(p.rows.get(id)?.enabled).toBe(true)
  expect(await connectionName(id)).toBe(a.row.displayName)
})

test('renaming a vault to a freed name renames its connection too', async () => {
  const freed = `freed ${crypto.randomUUID().slice(0, 8)}`
  const old = await vault(freed)
  const a = await vault()
  const p = pool()
  const handoffs = new Map([
    [old.row.id, old.handoff()],
    [a.row.id, a.handoff({ credentialId: '89abcdef' })],
  ])
  await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))
  const oldConnection = (await store.get(old.row.id))!.connectionId!
  await tombstone(old)
  await store.requestOperation(a.row.id, {
    action: 'rename',
    requestId: crypto.randomUUID(),
    expectedGeneration: 1,
    displayName: freed,
  })
  expect((await store.get(a.row.id))?.displayName).toBe(freed)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('current')
  expect(await connectionName((await store.get(a.row.id))!.connectionId!)).toBe(freed)
  expect(await connectionName(oldConnection)).toBe(`${freed} (retired ${oldConnection.slice(0, 8)})`)
})

test('a failing import is recorded with a safe code and retried with backoff, not every run', async () => {
  const a = await vault()
  const p = pool()
  const handoffs = new Map([[a.row.id, a.handoff()]])
  const working = p.deps(capabilities(), handoffs)
  const failing = {
    ...working,
    connections: {
      ...working.connections,
      create: async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "secret detail"'), {
          code: '23505',
        })
      },
    },
  }
  expect((await synchronizeManagedBigbrain(failing)).vaults[a.row.id]).toBe('failed')
  const failed = (await store.get(a.row.id))!
  expect(failed).toMatchObject({ readSyncErrorCode: 'connection_conflict', readSyncAttempts: 1, connectionId: null })
  expect(failed.readSyncNextAt).toBeInstanceOf(Date)
  // Inside the backoff nothing runs (no credential is written again).
  expect((await synchronizeManagedBigbrain(failing)).vaults[a.row.id]).toBe('backoff')
  p.advance(MANAGED_BIGBRAIN_SYNC_RETRY_MAX_MS)
  expect((await synchronizeManagedBigbrain(p.deps(capabilities(), handoffs))).vaults[a.row.id]).toBe('imported')
  expect(await store.get(a.row.id)).toMatchObject({ readSyncErrorCode: null, readSyncAttempts: 0 })
})
