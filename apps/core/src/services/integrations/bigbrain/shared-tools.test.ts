import { afterEach, expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import type { AssignedIntegrationConnectionRecord } from '../connection-repository'
import { IntegrationRuntimeGate } from '../runtime-gate'
import type { ManagedVault } from './managed/store'
import { bigbrainPlugin } from './plugin'
import {
  BIGBRAIN_SHARED_TOOL_NAMES,
  createSharedBigbrainTools,
  listReadableSharedVaults,
  type BigbrainSharedToolContext,
} from './shared-tools'

const previousManaged = process.env.FICUS_MANAGED
afterEach(() => {
  if (previousManaged === undefined) delete process.env.FICUS_MANAGED
  else process.env.FICUS_MANAGED = previousManaged
})

const now = new Date()
const SQUAD = 'squad-1'
function vault(name: string, patch: Partial<ManagedVault> = {}) {
  const id = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  const upstreamVaultId = crypto.randomUUID()
  const row = {
    id,
    displayName: name,
    hostOwnerUserId: crypto.randomUUID(),
    connectionId,
    upstreamVaultId,
    state: 'ready',
    readAccess: 'active',
    origin: `https://bb-${id.replaceAll('-', '')}.vaults.example.com`,
    readMaterial: {
      contractVersion: 1,
      tenantId: crypto.randomUUID(),
      physicalHostBinding: crypto.randomUUID(),
      vaultId: id,
      hostEpoch: 1,
      generation: 1,
      upstreamVaultId,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      credentialId: '0123abcd',
      kind: 'agent',
      scopes: ['read'],
      followsMember: false,
    },
    appliedGeneration: 1,
    desiredGeneration: 1,
    ...patch,
  } as ManagedVault
  const connection: AssignedIntegrationConnectionRecord = {
    id: connectionId,
    squadId: SQUAD,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    clientAuthority: 'local',
    authorizationFlowId: null,
    displayName: name,
    configuration: {
      version: 2,
      mode: 'managed_shared',
      vaultId: id,
      upstreamVaultId,
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
    },
    credentialRef: `ref:${connectionId}`,
    materialRevision: 'revision',
    validatedRevision: 'revision',
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: ['read'],
    validatedAt: now,
    validationExpiresAt: new Date(now.getTime() + 60_000),
    lastErrorCode: null,
    updatedAt: now,
  }
  return { row, connection }
}

function setup(vaults: ReturnType<typeof vault>[], assignedIds = vaults.map((v) => v.connection.id)) {
  const assigned = new Set(assignedIds)
  const rows = new Map(vaults.map((v) => [v.row.id, v.row]))
  const audits: unknown[] = []
  const reads: string[] = []
  const afterRead: { hook?: () => void } = {}
  const gate = new IntegrationRuntimeGate({
    currentAuthority: () => 'local',
    repository: {
      getAssigned: async () => {
        throw new Error('a shared tool must never resolve the default connection')
      },
      getAssignedById: async (_squad, _provider, connectionId) =>
        assigned.has(connectionId) ? (vaults.find((v) => v.connection.id === connectionId)?.connection ?? null) : null,
    },
    now: () => now,
    supportedAdapterVersion: () => 2,
    supportedConfigVersion: () => 2,
  })
  const context: BigbrainSharedToolContext = {
    agent: {
      id: 'agent',
      squadId: SQUAD,
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: SQUAD,
    gate,
    credentials: {
      get: (ref) => `sv_0123abcd_${'T'.repeat(42)}${ref.length % 10}`,
      set: async () => {},
      delete: async () => {},
    },
    connections: { disableRuntimeAuthFailure: async () => true } as never,
    audit: { record: async (event: unknown) => void audits.push(event) } as never,
    assignments: { listAssigned: async () => [...assigned].map((id) => ({ id })) },
    store: {
      get: async (id) => rows.get(id) ?? null,
      getByConnection: async (id) => [...rows.values()].find((r) => r.connectionId === id) ?? null,
    },
    resolveClient: (async (input: Parameters<NonNullable<BigbrainSharedToolContext['resolveClient']>>[0]) => {
      const read = async (label: string) => {
        await input.beforeCall()
        reads.push(`${input.configuration.vaultId}:${label}`)
        afterRead.hook?.()
        await input.beforeCall()
        return `<untrusted>${label} from ${input.configuration.vaultId}</untrusted>`
      }
      return {
        client: {
          overview: () => read('overview'),
          searchVault: (q: { query?: string }) => read(`search:${q.query}`),
          readRecord: (r: { id: string }) => read(`record:${r.id}`),
          recent: () => read('recent'),
        },
        vault: rows.get(input.configuration.vaultId)!,
      }
    }) as never,
  }
  const tools = Object.fromEntries(createSharedBigbrainTools(context).map((t) => [t.name, t]))
  const run = async (name: string, input: unknown) =>
    (await tools[name]!.execute('call', input as never, undefined as never, undefined as never, undefined as never))
      .details as Record<string, unknown>
  return { tools, run, assigned, rows, audits, reads, afterRead, context }
}

test('exactly five read-only tools; every data tool requires an explicit vault ID', () => {
  const { tools } = setup([])
  expect(Object.keys(tools)).toEqual([...BIGBRAIN_SHARED_TOOL_NAMES])
  expect(Object.keys(tools).some((name) => /drop|contribut|write|admin/.test(name))).toBe(false)
  for (const name of BIGBRAIN_SHARED_TOOL_NAMES.slice(1))
    expect((tools[name]!.parameters as { required?: string[] }).required).toContain('vaultId')
})

test('inventory lists only assigned, readable vaults and discloses no owner, origin or state', async () => {
  const research = vault('Research')
  const design = vault('Design')
  const revoked = vault('Revoked', { readAccess: 'revoked' })
  const unassigned = vault('Unassigned')
  const f = setup(
    [research, design, revoked, unassigned],
    [research, design, revoked].map((v) => v.connection.id)
  )
  const listed = (await f.run('bigbrain_shared_vaults', {})) as { vaults: Record<string, unknown>[] }
  expect(listed.vaults.map((v) => v.displayName).sort()).toEqual(['Design', 'Research'])
  const text = JSON.stringify(listed)
  for (const leak of ['Unassigned', 'Revoked', research.row.hostOwnerUserId, research.row.origin!, 'sv_'])
    expect(text).not.toContain(leak)
  expect(f.reads).toEqual([])
})

test('the named vault is read through its own assignment; unknown and unassigned vaults look the same', async () => {
  const research = vault('Research')
  const design = vault('Design')
  const hidden = vault('Hidden')
  const f = setup([research, design, hidden], [research.connection.id, design.connection.id])
  const result = await f.run('bigbrain_shared_overview', { vaultId: design.row.id })
  expect(result).toMatchObject({
    mode: 'managed_shared',
    vaultId: design.row.id,
    connectionId: design.connection.id,
    upstreamVaultId: design.row.upstreamVaultId,
    displayName: 'Design',
  })
  expect(f.reads).toEqual([`${design.row.id}:overview`])
  const unassigned = await f.run('bigbrain_shared_overview', { vaultId: hidden.row.id })
  const unknown = await f.run('bigbrain_shared_overview', { vaultId: crypto.randomUUID() })
  expect(unassigned).toEqual({ success: false, code: 'integration_unavailable' })
  expect(unknown).toEqual(unassigned)
  expect(f.reads).toHaveLength(1)
})

test('the same record ID in two vaults is never conflated: each envelope carries its vault', async () => {
  const a = vault('Alpha')
  const b = vault('Beta')
  const f = setup([a, b])
  const fromA = await f.run('bigbrain_shared_read_record', { vaultId: a.row.id, id: 'ins_same' })
  const fromB = await f.run('bigbrain_shared_read_record', { vaultId: b.row.id, id: 'ins_same', start: 5, chars: 10 })
  expect(fromA).toMatchObject({ vaultId: a.row.id, record: { id: 'ins_same', start: 0, chars: 20000 } })
  expect(fromB).toMatchObject({ vaultId: b.row.id, record: { id: 'ins_same', start: 5, chars: 10 } })
  expect(String(fromA.result)).toContain(a.row.id)
})

test('unassigning, revoking or rotating mid-call suppresses the response', async () => {
  const a = vault('Alpha')
  for (const interfere of [
    (f: ReturnType<typeof setup>) => f.assigned.clear(),
    (f: ReturnType<typeof setup>) => f.rows.set(a.row.id, { ...a.row, readAccess: 'revoked' }),
    (f: ReturnType<typeof setup>) =>
      f.rows.set(a.row.id, {
        ...a.row,
        readMaterial: { ...(a.row.readMaterial as object), credentialId: 'fedcba98' },
      }),
  ]) {
    const f = setup([a])
    f.afterRead.hook = () => interfere(f)
    const result = await f.run('bigbrain_shared_recent', { vaultId: a.row.id })
    expect(result).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('untrusted')
  }
})

test('audit records the action and outcome only, never tokens or vault content', async () => {
  const a = vault('Alpha')
  const f = setup([a])
  await f.run('bigbrain_shared_search_vault', { vaultId: a.row.id, query: 'secret plans' })
  expect(f.audits).toHaveLength(1)
  const text = JSON.stringify(f.audits)
  expect(text).toContain('bigbrain_shared_search_vault')
  for (const leak of ['sv_', 'secret plans', 'untrusted']) expect(text).not.toContain(leak)
})

test('the plugin offers shared read tools on Ficus Cloud and the unchanged personal tools elsewhere', async () => {
  const factory = bigbrainPlugin.runtime.agentTools!
  const shared = {
    agent: { id: 'a', squadId: SQUAD, integrationCapabilities: null },
    squadId: SQUAD,
    gate: {} as never,
    credentials: {} as never,
    connections: {} as never,
    audit: {} as never,
    assignments: { listAssigned: async () => [] },
  }
  const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_MANAGED = '1'
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  expect((await factory.createTools(shared)).map((t) => t.name)).toEqual([...BIGBRAIN_SHARED_TOOL_NAMES])
  // A host-runtime agent shell runs as the Core account: never offered shared vault reads.
  process.env.FICUS_SANDBOX_RUNTIME = 'host'
  expect(await factory.createTools(shared)).toEqual([])
  if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
  delete process.env.FICUS_MANAGED
  const personal = (await factory.createTools(shared)).map((t) => t.name)
  expect(personal).toContain('bigbrain_drop')
  expect(personal.some((n) => n.startsWith('bigbrain_shared_'))).toBe(false)
})

test('a squad has a readable shared vault only when an attached vault is readable and admitted', async () => {
  const ready = vault('Ready')
  expect((await listReadableSharedVaults(setup([ready]).context)).map((v) => v.vaultId)).toEqual([ready.row.id])
  // Nothing attached, or the vault exists but is not attached to this squad.
  expect(await listReadableSharedVaults(setup([]).context)).toEqual([])
  expect(await listReadableSharedVaults(setup([ready], []).context)).toEqual([])
  // Not readable: revoked read access, a non-readable state, or no read material.
  for (const patch of [{ readAccess: 'revoked' }, { state: 'deleted' }, { readMaterial: null }] as const)
    expect(await listReadableSharedVaults(setup([vault('Unreadable', patch as never)]).context)).toEqual([])
  // Connection disabled (provider or connection), unhealthy, or missing the read scope.
  for (const patch of [{ enabled: false }, { healthState: 'degraded' }, { grantedScopes: [] }] as const) {
    const v = vault('Fenced')
    Object.assign(v.connection, patch)
    expect(await listReadableSharedVaults(setup([v]).context)).toEqual([])
  }
})

test('the plugin reports a readable vault only for managed shared vaults on an isolated runtime', async () => {
  const factory = bigbrainPlugin.runtime.agentTools!
  const ready = vault('Ready')
  const { context } = setup([ready])
  const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
  try {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(await factory.hasReadableVault(context)).toBe(true)
    expect(await factory.hasReadableVault(setup([ready], []).context)).toBe(false)
    expect(await factory.hasReadableVault({ ...context, assignments: undefined } as never)).toBe(false)
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    expect(await factory.hasReadableVault(context)).toBe(false)
  } finally {
    if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
  }
})
