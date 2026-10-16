import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentExtraScopes, agents, db, machines, squads, sshTrustKeys, sshTrustTargets, systemTokens } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { createSystemToken, PLATFORM_ORCHESTRATOR_SCOPES } from '../services/auth/system-tokens'
import { insertMachine } from '../services/machines/queries'
import type { HostKeyScanner } from '../services/remote-hosts/host-keys'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import {
  ensureTrustTarget,
  hostKeyPinFor,
  HostKeyNotTrustedError,
  listTrustKeys,
  machineTrustSpec,
  PlatformHostKeyRefusedError,
  refreshTrustTarget,
  rejectTrustKey,
  trustPlatformSuppliedKeys,
  trustTargetState,
  trustTrustKey,
  type TrustTargetSpec,
} from '../services/ssh-trust'
import type { Identity } from '../services/rbac'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  type TestAgentToken,
  type TestUser,
} from '../test-utils'
import { createMachinesRouter } from './machines'
import { systemTokensRouter } from './system-tokens'

/**
 * POST /api/machines `hostKeys`: only the Ficus platform's credential (the
 * live `platform-orchestrator` system token) may supply a machine host's
 * trusted host key. Synthetic keys and hosts only; nothing connects anywhere
 * (every scanner here is a stub).
 */

const prefix = `mach-pk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// Synthetic ed25519-shaped key blob (4-byte length + type + payload). Never a real host's key.
function syntheticKey(seed: string, keyType = 'ssh-ed25519'): string {
  const type = Buffer.from(keyType)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length)
  return Buffer.concat([len, type, Buffer.from(`synthetic-${prefix}-${seed}`)]).toString('base64')
}

function hostKey(seed: string, keyType = 'ssh-ed25519') {
  return { keyType, publicKey: syntheticKey(seed, keyType) }
}

const failingScanner: HostKeyScanner = async () => {
  throw new Error('test: no network')
}

function scannerReturning(keys: Array<{ keyType: string; publicKey: string }>): HostKeyScanner & { calls: number } {
  const scanner: HostKeyScanner & { calls: number } = Object.assign(
    async () => {
      scanner.calls++
      return keys
    },
    { calls: 0 }
  )
  return scanner
}

async function machineByName(name: string) {
  const [row] = await db.select().from(machines).where(eq(machines.name, name))
  return row ?? null
}

async function keysForMachine(id: string) {
  const [target] = await db
    .select()
    .from(sshTrustTargets)
    .where(eq(sshTrustTargets.scope, `machine:${id}`))
  return target ? listTrustKeys(target.id) : []
}

async function keysWithPublicKey(publicKey: string) {
  return db.select().from(sshTrustKeys).where(eq(sshTrustKeys.publicKey, publicKey))
}

describe('POST /api/machines hostKeys (platform-supplied host keys)', () => {
  let admin: TestUser
  let platform: { token: string; id: string }
  let otherSystem: { token: string; id: string }
  let agentToken: TestAgentToken
  let priorKey: string | undefined
  const originalHome = process.env.HOME_DIR
  let home: string
  const tokenIds: string[] = []

  beforeAll(async () => {
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()

    admin = await createTestAdmin({ prefix })
    const p = await createSystemToken({ name: 'platform-orchestrator', scopes: PLATFORM_ORCHESTRATOR_SCOPES })
    platform = { token: p.token, id: p.record.id }
    const o = await createSystemToken({ name: `${prefix}-automation`, scopes: ['machines:write', 'machines:read'] })
    otherSystem = { token: o.token, id: o.record.id }
    tokenIds.push(p.record.id, o.record.id)

    const [squad] = await db
      .insert(squads)
      .values({ name: `${prefix}-squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    await db.insert(agentExtraScopes).values([
      { agentId: agent.id, permission: 'machines:write' },
      { agentId: agent.id, permission: 'system-tokens:manage' },
    ])
    agentToken = await createTestAgentToken({ agentId: agent.id, squadId: squad.id })
  })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'machines-pk-test-'))
    process.env.HOME_DIR = home
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = originalHome
    rmSync(home, { recursive: true, force: true })
    const rows = await db
      .select({ id: machines.id })
      .from(machines)
      .where(like(machines.name, `${prefix}%`))
    for (const m of rows) {
      await db.delete(sshTrustTargets).where(eq(sshTrustTargets.scope, `machine:${m.id}`))
      await db.delete(machines).where(eq(machines.id, m.id))
      await getSecretStore().delete(`machine-ssh:${m.id}`)
    }
    await db.delete(sshTrustTargets).where(like(sshTrustTargets.scope, `${prefix}%`))
  })

  afterAll(async () => {
    const created = await db
      .select({ id: systemTokens.id })
      .from(systemTokens)
      .where(like(systemTokens.name, `${prefix}%`))
    const ids = [...tokenIds, ...created.map((t) => t.id)]
    if (ids.length) await db.delete(systemTokens).where(inArray(systemTokens.id, ids))
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    await cleanupTestRbac(prefix)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    resetSecretStore()
  })

  function router(deps: Parameters<typeof createMachinesRouter>[0] = {}) {
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/', createMachinesRouter({ registerProviders: async () => {}, ...deps }))
    return app
  }

  function post(app: Hono, token: string, body: unknown) {
    return app.request('/', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const register = (name: string, extra: Record<string, unknown> = {}) => ({
    name: `${prefix}-${name}`,
    sshHost: '203.0.113.10',
    sshUser: 'root',
    ...extra,
  })

  it('the platform credential registers a machine whose supplied key is trusted at once, with no pending prompt', async () => {
    const supplied = hostKey('platform-ok')
    const res = await post(router(), platform.token, register('ok', { hostKeys: [supplied] }))
    expect(res.status).toBe(201)
    const machine = (await res.json()) as { id: string }

    const keys = await keysForMachine(machine.id)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      keyType: 'ssh-ed25519',
      publicKey: supplied.publicKey,
      status: 'trusted',
      origin: 'platform',
      decidedByUserId: null,
      decisionNote: `supplied by the Ficus platform (system-token:${platform.id})`,
    })
    expect(keys[0].decidedAt).toBeInstanceOf(Date)

    // The connection pins the supplied key without fetching anything or waiting for a person.
    const row = await machineByName(`${prefix}-ok`)
    const scanner = scannerReturning([hostKey('would-be-scanned')])
    const pin = await hostKeyPinFor(machineTrustSpec(row!), { scanner })
    expect(scanner.calls).toBe(0)
    expect(pin.alias).toStartWith('ficus-trust.')
  })

  it('accepts several keys of different types', async () => {
    const res = await post(
      router(),
      platform.token,
      register('multi', { hostKeys: [hostKey('m1'), hostKey('m2', 'ecdsa-sha2-nistp256')] })
    )
    expect(res.status).toBe(201)
    const keys = await keysForMachine(((await res.json()) as { id: string }).id)
    expect(keys.map((k) => k.status)).toEqual(['trusted', 'trusted'])
  })

  for (const [label, token] of [
    ['an agent token with machines:write', () => agentToken.token],
    ['a signed-in admin', () => admin.token],
    ['another system token with machines:write', () => otherSystem.token],
  ] as const) {
    it(`refuses hostKeys from ${label}: nothing is created and the key is never trusted`, async () => {
      const supplied = hostKey(`refused-${label}`)
      const res = await post(router(), token(), register('refused', { hostKeys: [supplied] }))
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe('host_keys_platform_only')
      expect(await machineByName(`${prefix}-refused`)).toBeNull()
      expect(await keysWithPublicKey(supplied.publicKey)).toEqual([])
    })
  }

  it('refuses hostKeys from the bootstrap bearer (legacy identity)', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity', { type: 'legacy' } satisfies Identity)
      await next()
    })
    app.route('/', createMachinesRouter({ registerProviders: async () => {} }))
    const supplied = hostKey('legacy')
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(register('legacy', { hostKeys: [supplied] })),
    })
    expect(res.status).toBe(403)
    expect(await machineByName(`${prefix}-legacy`)).toBeNull()
  })

  it('a refused caller still registers without hostKeys; the fetched key stays pending until a person trusts it', async () => {
    const res = await post(router(), agentToken.token, register('agent-plain'))
    expect(res.status).toBe(201)
    const row = await machineByName(`${prefix}-agent-plain`)
    const fetched = hostKey('agent-plain-fetched')
    const error = await hostKeyPinFor(machineTrustSpec(row!), { scanner: scannerReturning([fetched]) }).catch((e) => e)
    expect(error).toBeInstanceOf(HostKeyNotTrustedError)
    expect((error as HostKeyNotTrustedError).state).toBe('pending')
    expect((await keysForMachine(row!.id)).map((k) => k.status)).toEqual(['pending'])
  })

  it('manual registration is unchanged: no key is trusted until a person trusts it', async () => {
    const res = await post(router(), admin.token, register('manual'))
    expect(res.status).toBe(201)
    const row = await machineByName(`${prefix}-manual`)
    expect(await keysForMachine(row!.id)).toEqual([])

    const fetched = hostKey('manual-fetched')
    const error = await hostKeyPinFor(machineTrustSpec(row!), { scanner: scannerReturning([fetched]) }).catch((e) => e)
    expect(error).toBeInstanceOf(HostKeyNotTrustedError)
    const [pending] = await keysForMachine(row!.id)
    expect(pending.status).toBe('pending')

    await trustTrustKey(pending.targetId, pending.id, admin.id)
    await hostKeyPinFor(machineTrustSpec(row!), { scanner: failingScanner })
  })

  it('the platform registering WITHOUT hostKeys gets the ordinary pending flow', async () => {
    const res = await post(router(), platform.token, register('platform-plain'))
    expect(res.status).toBe(201)
    const row = await machineByName(`${prefix}-platform-plain`)
    const error = await hostKeyPinFor(machineTrustSpec(row!), {
      scanner: scannerReturning([hostKey('platform-plain-fetched')]),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(HostKeyNotTrustedError)
  })

  it('never re-trusts a key a person rejected (on any endpoint): 409 and nothing created', async () => {
    const supplied = hostKey('rejected-elsewhere')
    const other: TrustTargetSpec = {
      scope: `${prefix}:old-host`,
      kind: 'machine',
      label: 'Machine old',
      sshHost: '203.0.113.10',
      sshPort: 22,
    }
    const target = await ensureTrustTarget(other)
    await db.insert(sshTrustKeys).values({
      targetId: target.id,
      keyType: supplied.keyType,
      publicKey: supplied.publicKey,
      fingerprint: 'SHA256:test',
      status: 'pending',
      origin: 'scan',
    })
    const [pending] = await listTrustKeys(target.id)
    await rejectTrustKey(target.id, pending.id, admin.id)

    const res = await post(router(), platform.token, register('rejected', { hostKeys: [supplied] }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('host_key_rejected')
    expect(await machineByName(`${prefix}-rejected`)).toBeNull()
    const rows = await keysWithPublicKey(supplied.publicKey)
    expect(rows.map((k) => k.status)).toEqual(['rejected'])
  })

  it('re-registering an existing name is a 409 that changes no key', async () => {
    const first = hostKey('rereg-1')
    const res1 = await post(router(), platform.token, register('rereg', { hostKeys: [first] }))
    expect(res1.status).toBe(201)
    const id = ((await res1.json()) as { id: string }).id

    const second = hostKey('rereg-2')
    const res2 = await post(router(), platform.token, register('rereg', { hostKeys: [second] }))
    expect(res2.status).toBe(409)
    const keys = await keysForMachine(id)
    expect(keys.map((k) => [k.publicKey, k.status])).toEqual([[first.publicKey, 'trusted']])
    expect(await keysWithPublicKey(second.publicKey)).toEqual([])
  })

  it('an endpoint that already has keys on record is refused and the new machine row is removed', async () => {
    // Simulates the endpoint gaining a key between insert and trust: the insert
    // stub records a pending key for the new machine's endpoint first.
    const existing = hostKey('race-existing')
    const insert: typeof insertMachine = async (values) => {
      const row = await insertMachine(values)
      const target = await ensureTrustTarget(machineTrustSpec(row))
      await db.insert(sshTrustKeys).values({
        targetId: target.id,
        keyType: existing.keyType,
        publicKey: existing.publicKey,
        fingerprint: 'SHA256:race',
        status: 'pending',
        origin: 'scan',
      })
      return row
    }
    const supplied = hostKey('race-supplied')
    const res = await post(router({ insert }), platform.token, register('race', { hostKeys: [supplied] }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('host_keys_exist')
    expect(await machineByName(`${prefix}-race`)).toBeNull()
    expect(await keysWithPublicKey(supplied.publicKey)).toEqual([])
  })

  it('validates the field: malformed key, mismatched type, duplicate type and exe machines are 400', async () => {
    const app = router()
    const cases = [
      { hostKeys: [{ keyType: 'ssh-ed25519', publicKey: 'not base64!' }] },
      { hostKeys: [{ keyType: 'ssh-rsa', publicKey: syntheticKey('mismatch', 'ssh-ed25519') }] },
      { hostKeys: [hostKey('dup-a'), hostKey('dup-b')] },
      { hostKeys: [] },
      { hostKeys: [{ ...hostKey('extra'), comment: 'x' }] },
    ]
    for (const extra of cases) {
      const res = await post(app, platform.token, register('invalid', extra))
      expect(res.status).toBe(400)
    }
    const exe = await post(app, platform.token, {
      name: `${prefix}-exe`,
      provider: 'exe',
      hostKeys: [hostKey('exe')],
    })
    expect(exe.status).toBe(400)
    expect(await machineByName(`${prefix}-invalid`)).toBeNull()
  })
})

describe('trustPlatformSuppliedKeys', () => {
  const run = `${prefix}-svc`
  afterAll(async () => {
    await db.delete(sshTrustTargets).where(like(sshTrustTargets.scope, `${run}%`))
  })
  const spec = (name: string): TrustTargetSpec => ({
    scope: `${run}:${name}`,
    kind: 'machine',
    label: `Machine ${name}`,
    sshHost: '203.0.113.20',
    sshPort: 22,
  })

  it('never adds to or replaces the keys of an existing endpoint, even one the platform supplied', async () => {
    const s = spec('existing')
    await trustPlatformSuppliedKeys(s, [hostKey('svc-1')], 'system-token:test')
    const error = await trustPlatformSuppliedKeys(s, [hostKey('svc-2')], 'system-token:test').catch((e) => e)
    expect(error).toBeInstanceOf(PlatformHostKeyRefusedError)
    expect((error as PlatformHostKeyRefusedError).code).toBe('host_keys_exist')
    const target = await ensureTrustTarget(s)
    expect((await listTrustKeys(target.id)).map((k) => k.publicKey)).toEqual([hostKey('svc-1').publicKey])
  })

  it('a later key change on a platform-supplied machine still waits for a person', async () => {
    const s = spec('changed')
    await trustPlatformSuppliedKeys(s, [hostKey('orig')], 'system-token:test')
    const target = await ensureTrustTarget(s)
    // A person fetches keys again and the host now presents a different one.
    await refreshTrustTarget(target, scannerReturning([hostKey('new')]))
    const keys = await listTrustKeys(target.id)
    expect(trustTargetState(target, keys)).toBe('changed')
    expect(keys.find((k) => k.publicKey === hostKey('new').publicKey)?.status).toBe('pending')
  })
})

describe('POST /api/system-tokens reserves the platform-orchestrator name', () => {
  const p = `${prefix}-st`
  let admin: TestUser
  let agentToken: TestAgentToken
  let manager: { token: string; id: string }
  const app = new Hono().use('*', identityMiddleware).route('/api/system-tokens', systemTokensRouter)

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix: p })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${p}-squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'system-tokens:manage' })
    agentToken = await createTestAgentToken({ agentId: agent.id, squadId: squad.id })
    const m = await createSystemToken({ name: `${p}-manager`, scopes: ['system-tokens:manage'] })
    manager = { token: m.token, id: m.record.id }
  })

  afterAll(async () => {
    await db.delete(systemTokens).where(eq(systemTokens.id, manager.id))
    await db.delete(squads).where(like(squads.name, `${p}%`))
    await cleanupTestRbac(p)
  })

  async function create(token: string, name: string) {
    const res = await app.request('/api/system-tokens', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scopes: ['machines:read'] }),
    })
    const body = (await res.json()) as { id?: string }
    if (body.id) await db.delete(systemTokens).where(eq(systemTokens.id, body.id))
    return res.status
  }

  it('an agent or a system token holding system-tokens:manage cannot mint it (any case or padding)', async () => {
    expect(await create(agentToken.token, 'platform-orchestrator')).toBe(403)
    expect(await create(agentToken.token, ' Platform-Orchestrator ')).toBe(403)
    expect(await create(manager.token, 'platform-orchestrator')).toBe(403)
    // Other names are unaffected.
    expect(await create(agentToken.token, `${p}-ordinary`)).toBe(201)
  })

  it('a signed-in person can still mint it', async () => {
    expect(await create(admin.token, 'platform-orchestrator')).toBe(201)
  })
})
