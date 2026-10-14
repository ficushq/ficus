import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { FARM_WATCHING_MAX_AGENTS, type RobotMoodState } from '@ficus/shared'
import { createFarmRouter } from './farm'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { agents, db, squads } from '../db'

const prefix = `farm-watching-${crypto.randomUUID()}`
let watcher: TestUser
let other: TestUser
/** Farm access, but no squad in common with the robots. */
let stranger: TestUser
/** No farm permission at all. */
let outsider: TestUser
let squadIds: string[] = []
let mine: string
let theirs: string
let privateMine: string
let privateTheirs: string

let enabled = true
const reports: string[][] = []
const moods: Record<string, RobotMoodState> = {}

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route(
  '/farm',
  createFarmRouter({
    isEnabled: () => enabled,
    report: (ids) => void reports.push(ids),
    moods: (ids) => Object.fromEntries(ids.filter((id) => moods[id]).map((id) => [id, moods[id]!])),
  })
)

const watch = (user: TestUser | null, body: unknown) =>
  app.request('/farm/watching', {
    method: 'POST',
    headers: { ...(user ? authHeaders(user.token) : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  watcher = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
  stranger = await createTestUser({ prefix })
  outsider = await createTestUser({ prefix })
  const farmer = await createTestRole({ prefix, permissions: ['farm:read'] })
  const member = await createTestRole({ prefix, permissions: ['agents:read'] })
  const created = await db
    .insert(squads)
    .values([
      { name: `${prefix} A`, purpose: 'test' },
      { name: `${prefix} B`, purpose: 'test' },
    ])
    .returning()
  squadIds = created.map((squad) => squad.id)
  const [squadA, squadB] = created
  for (const user of [watcher, other, stranger])
    await assignRole({ userId: user.id, roleId: farmer.id, scope: 'system' })
  await assignRole({ userId: watcher.id, roleId: member.id, scope: 'squad', squadId: squadA!.id })
  await assignRole({ userId: other.id, roleId: member.id, scope: 'squad', squadId: squadB!.id })
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: 'engineer', squadId: squadA!.id },
      { agentTypeId: 'engineer', squadId: squadB!.id },
      { agentTypeId: 'system-manager', ownerUserId: watcher.id },
      { agentTypeId: 'system-manager', ownerUserId: other.id },
    ])
    .returning()
  ;[mine, theirs, privateMine, privateTheirs] = rows.map((row) => row.id) as [string, string, string, string]
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [mine, theirs, privateMine, privateTheirs]))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  await cleanupTestRbac(prefix)
})

describe('POST /api/farm/watching', () => {
  test('is for signed-in people with farm access', async () => {
    expect((await watch(null, { agentIds: [] })).status).toBe(401)
    expect((await watch(outsider, { agentIds: [mine] })).status).toBe(403)
  })

  test('watches only the robots the caller could list, and returns their moods', async () => {
    reports.length = 0
    moods[mine] = { mood: 'exploring', source: 'model', at: 1 }
    moods[theirs] = { mood: 'risky', source: 'model', at: 2 }
    const response = await watch(watcher, {
      agentIds: [mine, theirs, privateMine, privateTheirs, mine, 'farm:assistant'],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: true, moods: { [mine]: moods[mine] } })
    expect(reports).toHaveLength(1)
    expect([...reports[0]!].sort()).toEqual([mine, privateMine].sort())
  })

  test('someone sharing no squad with the robots watches nothing', async () => {
    reports.length = 0
    const response = await watch(stranger, { agentIds: [mine, theirs] })
    expect(await response.json()).toEqual({ enabled: true, moods: {} })
    expect(reports).toEqual([[]])
  })

  test('off: nothing is watched, and the farm learns moods are off', async () => {
    enabled = false
    reports.length = 0
    try {
      const response = await watch(watcher, { agentIds: [mine] })
      expect(await response.json()).toEqual({ enabled: false, moods: {} })
      expect(reports).toHaveLength(0)
    } finally {
      enabled = true
    }
  })

  test('rejects more robots than one report may name', async () => {
    const ids = Array.from({ length: FARM_WATCHING_MAX_AGENTS + 1 }, () => crypto.randomUUID())
    expect((await watch(watcher, { agentIds: ids })).status).toBe(400)
    expect((await watch(watcher, { agentIds: 'everything' })).status).toBe(400)
  })
})
