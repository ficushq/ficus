import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { squadsRouter } from './squads'
import { identityMiddleware } from '../middleware/identity'
import { Squad } from '../entities/Squad'
import { db, squads } from '../db'
import * as factory from '../services/sandbox/factory'
import { BoxHealthTimeoutError, BoxRestartError } from '../services/machines/box-manager'
import { VmSetupLeaseBusyError } from '../services/sandbox/vm/setup-state'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'

const app = new Hono().use('*', identityMiddleware).route('/api/squads', squadsRouter)
const prefix = `restart-routes-${Date.now()}`
let admin: TestUser
let member: TestUser
let squad: Squad
let other: Squad
const calls: string[] = []
let failure: Error | undefined
const runtime = process.env.FICUS_SANDBOX_RUNTIME
let managerSpy: ReturnType<typeof spyOn>
beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  member = await createTestUser({ prefix })
  squad = await Squad.create({ name: prefix, purpose: 'restart' })
  other = await Squad.create({ name: `${prefix}-other`, purpose: 'restart' })
  const role = await createTestRole({ prefix, permissions: ['squads:update'] })
  await assignRole({ userId: member.id, roleId: role.id, scope: 'squad', squadId: squad.id })
})
beforeEach(() => {
  process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  calls.length = 0
  failure = undefined
  managerSpy = spyOn(factory, 'getSandboxManager').mockReturnValue({
    restartSandbox: async (id: string) => {
      calls.push(id)
      if (failure) throw failure
    },
  } as any)
})
afterEach(() => {
  managerSpy.mockRestore()
  if (runtime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = runtime
})
afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(squads).where(eq(squads.id, other.id))
  await cleanupTestRbac(prefix)
})
const post = (id: string, token = admin.token) =>
  app.request(`/api/squads/${id}/sandbox/restart`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandboxId: 'squad_unrelated', machineId: 'unrelated' }),
  })

test('scoped updater restarts only the stored squad box, ignoring client-supplied infrastructure identity', async () => {
  const response = await post(squad.id, member.token)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(calls).toEqual([squad.sandboxId])
  expect((await post(other.id, member.token)).status).toBe(403)
  expect(calls).toHaveLength(1)
})

test('unknown squads and non-VM runtimes never reach the manager', async () => {
  expect((await post('00000000-0000-4000-8000-00000000dead')).status).toBe(404)
  for (const value of ['host', 'k8s', 'docker-socket']) {
    process.env.FICUS_SANDBOX_RUNTIME = value
    expect((await post(squad.id)).status).toBe(400)
  }
  expect(calls).toEqual([])
})

test('busy, missing, failed health and unexpected failures have safe actionable responses', async () => {
  for (const [error, expected] of [
    [new BoxRestartError('Sandbox changed', 409), 409],
    [new VmSetupLeaseBusyError(), 409],
    [new BoxRestartError('Sandbox box not found', 404), 404],
    [new BoxHealthTimeoutError('private host details'), 504],
    [new Error('private token'), 500],
  ] as const) {
    failure = error
    const response = await post(squad.id)
    expect(response.status).toBe(expected)
    const body = await response.text()
    expect(body).not.toContain('private')
  }
})

test('archived squads cannot be restarted', async () => {
  await db.update(squads).set({ archivedAt: new Date(), status: 'archived' }).where(eq(squads.id, squad.id))
  try {
    expect((await post(squad.id)).status).toBe(410)
    expect(calls).toEqual([])
  } finally {
    await db.update(squads).set({ archivedAt: null, status: 'active' }).where(eq(squads.id, squad.id))
  }
})
