import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { SquadStorageView, StorageFolder } from '@ficus/shared'
import { db, agents, agentTokens, images, squads } from '../db'
import { agentExtraScopes, storageHomeResults, storageScanPasses } from '../db/schema'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware'
import { RoleSync } from '../services/config-sync/role-sync'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import * as storageTargets from '../services/storage/index'
import { storageMonitorService } from '../services/storage/monitor'
import type { Machine } from '../services/machines/queries'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
} from '../test-utils'
import { squadsRouter } from './squads'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)

const prefix = `squad-storage-${randomUUID()}`
const machineId = randomUUID()
const OWN_WORKSPACE = '/home/box_0000000000a1'
const OWN_AGENT = '/home/box_0000000000a2'
const OTHER_WORKSPACE = '/home/box_0000000000b1'
const OTHER_AGENT = '/home/box_0000000000b2'
const measuredAt = new Date(Date.now() - 10 * 60_000)

const tree = (home: string, bytes: number, child: string): StorageFolder => ({
  name: home.slice(6),
  path: home,
  bytes,
  status: 'available',
  children: [{ name: child, path: `${home}/${child}`, bytes, status: 'available', children: [] }],
})

let oldRuntime: string | undefined
let own: Squad
let other: Squad
let consultant: Agent
let worker: Agent
let foreign: Agent
const agentIds: string[] = []
const imageIds: string[] = []

beforeAll(async () => {
  await new RoleSync().sync()
  invalidatePermissionCache()
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  oldRuntime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  own = await Squad.create({ name: `${prefix}-own`, purpose: 'storage fixture' })
  other = await Squad.create({ name: `${prefix}-other`, purpose: 'storage fixture' })
  consultant = await Agent.create({ agentTypeId: 'consultant', squadId: own.id, persist: false })
  worker = await Agent.create({ agentTypeId: 'engineer', squadId: own.id, persist: false })
  foreign = await Agent.create({ agentTypeId: 'consultant', squadId: other.id, persist: false })
  agentIds.push(consultant.id, worker.id, foreign.id, own.managerAgentId!, other.managerAgentId!)

  await db.insert(storageScanPasses).values({
    machineId,
    generation: 1,
    status: 'completed',
    completedAt: measuredAt,
    homes: 4,
    usedBytes: 7_777_777_777,
    totalBytes: 9_999_999_999,
    diskMeasuredAt: measuredAt,
  })
  await db.insert(storageHomeResults).values(
    [
      [OWN_WORKSPACE, 424_242, 'own-repo'],
      [OWN_AGENT, 131_313, 'own-notes'],
      [OTHER_WORKSPACE, 868_686, 'other-secret-repo'],
      [OTHER_AGENT, 535_353, 'other-secret-notes'],
    ].map(([home, bytes, child]) => ({
      machineId,
      home: home as string,
      generation: 1,
      bytes: bytes as number,
      totalExact: true,
      status: 'available' as const,
      folder: tree(home as string, bytes as number, child as string),
      measuredAt,
    }))
  )
  const info = (agent: Agent) => ({
    id: agent.id,
    label: agent.id,
    agentTypeId: agent.agentTypeId,
    status: 'idle' as const,
    lastMessageAt: null,
    dormantAt: null,
    createdAt: null,
  })
  spyOn(storageTargets, 'loadStorageTargets').mockResolvedValue([
    {
      machine: { id: machineId, name: 'Shared host', status: 'ready' } as Machine,
      owners: [
        {
          home: OWN_WORKSPACE,
          squadId: own.id,
          squadName: own.name,
          label: 'Squad workspace',
          kind: 'squad-workspace',
        },
        {
          home: OWN_AGENT,
          squadId: own.id,
          squadName: own.name,
          label: 'Consultant',
          kind: 'agent',
          agent: info(consultant),
        },
        {
          home: OTHER_WORKSPACE,
          squadId: other.id,
          squadName: other.name,
          label: 'Squad workspace',
          kind: 'squad-workspace',
        },
        {
          home: OTHER_AGENT,
          squadId: other.id,
          squadName: other.name,
          label: 'Foreign',
          kind: 'agent',
          agent: info(foreign),
        },
      ],
    },
  ])
  for (const [squadId, size] of [
    [own.id, 2_468],
    [other.id, 97_531],
  ] as const) {
    const [row] = await db
      .insert(images)
      .values({ filename: `${randomUUID()}.png`, mimeType: 'image/png', size, squadId })
      .returning({ id: images.id })
    imageIds.push(row.id)
  }
})

afterEach(async () => {
  ;(storageTargets.loadStorageTargets as unknown as { mockRestore: () => void }).mockRestore()
  if (oldRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = oldRuntime
  await db.delete(storageHomeResults).where(eq(storageHomeResults.machineId, machineId))
  await db.delete(storageScanPasses).where(eq(storageScanPasses.machineId, machineId))
  if (imageIds.length) await db.delete(images).where(inArray(images.id, imageIds.splice(0)))
  const ids = agentIds.splice(0)
  await db.delete(agentExtraScopes).where(inArray(agentExtraScopes.agentId, ids))
  await db.delete(agentTokens).where(inArray(agentTokens.agentId, ids))
  await db.delete(agents).where(inArray(agents.id, ids))
  await db.delete(squads).where(inArray(squads.id, [own.id, other.id]))
  invalidatePermissionCache()
})

async function agentToken(agentId: string, squadId: string) {
  return (await createTestAgentToken({ agentId, squadId })).token
}

async function userToken(permissions: string[], squadId?: string) {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions })
  await assignRole({
    userId: user.id,
    roleId: role.id,
    ...(squadId ? { scope: 'squad', squadId } : { scope: 'system' }),
  })
  return user.token
}

const read = (squadId: string, token?: string) =>
  app.request(`/api/squads/${squadId}/storage`, token ? { headers: authHeaders(token) } : {})

function expectOnlyOwnSquad(view: SquadStorageView) {
  expect(view.squad).toEqual({ id: own.id, name: own.name })
  expect(view.supported).toBe(true)
  expect(view.bytes).toBe(424_242 + 131_313)
  expect(view.scannedAt).toBe(measuredAt.toISOString())
  expect(view.machines).toHaveLength(1)
  const [machine] = view.machines
  expect(machine!.storage.id).toBe(own.id)
  expect(machine!.storage.folders.map((item) => item.path).sort()).toEqual([OWN_WORKSPACE, OWN_AGENT])
  expect(machine!.storage.folders.find((item) => item.kind === 'agent')?.agent?.id).toBe(consultant.id)
  expect(view.storedFiles.bytes).toBe(2_468)
  expect(view.storedFiles.sources.find((source) => source.key === 'images')?.bytes).toBe(2_468)
  // Strict isolation: nothing from the other squad and no host totals.
  const text = JSON.stringify(view)
  for (const leaked of [
    other.id,
    other.name,
    foreign.id,
    OTHER_WORKSPACE,
    OTHER_AGENT,
    'other-secret',
    '868686',
    '535353',
    '97531',
    '7777777777',
    '9999999999',
    'usedBytes',
    'totalBytes',
    'unattributedBytes',
    'warnings',
    'quotaUsedBytes',
    'missingHomes',
  ])
    expect(text).not.toContain(leaked)
}

describe('GET /api/squads/:id/storage', () => {
  it('serves a manager and a consultant their own squad only', async () => {
    for (const token of [await agentToken(own.managerAgentId!, own.id), await agentToken(consultant.id, own.id)]) {
      const response = await read(own.id, token)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expectOnlyOwnSquad((await response.json()) as SquadStorageView)
      // Another squad is refused by full id or id prefix; an unknown squad reveals nothing.
      expect((await read(other.id, token)).status).toBe(403)
      expect((await read(other.id.slice(0, 8), token)).status).toBe(403)
      expect([403, 404]).toContain((await read(randomUUID(), token)).status)
    }
  })

  it('refuses a default-worker agent, and an extra storage:read scope stays inside its squad', async () => {
    const token = await agentToken(worker.id, own.id)
    expect((await read(own.id, token)).status).toBe(403)

    await db.insert(agentExtraScopes).values({ agentId: worker.id, permission: 'storage:read' })
    invalidatePermissionCache()
    const response = await read(own.id, token)
    expect(response.status).toBe(200)
    expectOnlyOwnSquad((await response.json()) as SquadStorageView)
    expect((await read(other.id, token)).status).toBe(403)
  })

  it('serves a squad-scoped holder without system:logs, and a system admin', async () => {
    const holder = await userToken(['storage:read'], own.id)
    const response = await read(own.id, holder)
    expect(response.status).toBe(200)
    expectOnlyOwnSquad((await response.json()) as SquadStorageView)
    expect((await read(other.id, holder)).status).toBe(403)

    const admin = await createTestAdmin({ prefix })
    const adminView = await read(own.id, admin.token)
    expect(adminView.status).toBe(200)
    expectOnlyOwnSquad((await adminView.json()) as SquadStorageView)
  })

  it('refuses callers without storage:read in that squad', async () => {
    expect((await read(own.id)).status).toBe(401)
    expect((await read(own.id, await userToken(['squads:read', 'agents:terminate'], own.id))).status).toBe(403)
    // The instance-wide permission is separate: it does not imply the squad view.
    expect((await read(own.id, await userToken(['system:logs']))).status).toBe(403)
  })

  it('is read-only: reading never requests a scan, and there is no squad refresh route', async () => {
    const token = await agentToken(own.managerAgentId!, own.id)
    const refresh = spyOn(storageMonitorService, 'refresh')
    try {
      expect((await read(own.id, token)).status).toBe(200)
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      refresh.mockRestore()
    }
    const post = await app.request(`/api/squads/${own.id}/storage/refresh`, {
      method: 'POST',
      headers: authHeaders(token),
    })
    expect(post.status).toBe(404)
  })

  it('still reports stored files outside the VM runtime', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    const response = await read(own.id, await agentToken(own.managerAgentId!, own.id))
    expect(response.status).toBe(200)
    const view = (await response.json()) as SquadStorageView
    expect(view).toMatchObject({ supported: false, machines: [], bytes: null, storedFiles: { bytes: 2_468 } })
  })
})
