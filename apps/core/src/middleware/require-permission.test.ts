import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import { Permissions } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, squads } from '../db'
import { requireAnySquadPermission } from './require-permission'

// Drift guard: permission strings referenced by route guards / role defaults
// must exist in the shared catalog. Guards take `permission: string`, so a typo
// or an unlisted permission compiles cleanly and silently never matches —
// this test catches catalog drift in CI.
// The guard resolves its route param to a real squad before authorizing, so these cases need one
// to exist; a system token's scopes are global, but the squad it names must still be a squad.
// Created in beforeAll so a failure inside a test can never leave the row behind.
let guardSquadId: string

beforeAll(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `require-permission-guard-${crypto.randomUUID()}`, purpose: 'guard test' })
    .returning()
  guardSquadId = squad.id
})

afterAll(async () => {
  if (guardSquadId) await db.delete(squads).where(eq(squads.id, guardSquadId))
})

test('requireAnySquadPermission accepts either requested permission and rejects neither', async () => {
  const app = new Hono()
  app.use('/:squadId', async (c, next) => {
    const scope = c.req.header('x-test-scope')
    if (scope) {
      c.set('identity', {
        type: 'system',
        systemTokenId: 'slot-guard-test',
        name: 'slot-guard-test',
        scopes: [scope],
      })
    }
    await next()
  })
  app.get('/:squadId', requireAnySquadPermission([Permissions.SLOTS_USE, Permissions.SLOTS_WRITE]), (c) =>
    c.json({ ok: true })
  )

  const path = `/${guardSquadId}`
  expect((await app.request(path, { headers: { 'x-test-scope': Permissions.SLOTS_USE } })).status).toBe(200)
  expect((await app.request(path, { headers: { 'x-test-scope': Permissions.SLOTS_WRITE } })).status).toBe(200)
  expect((await app.request(path, { headers: { 'x-test-scope': Permissions.SQUADS_READ } })).status).toBe(403)
  expect((await app.request(path)).status).toBe(401)

  // Unauthenticated is still decided before the squad is looked up.
  expect((await app.request('/00000000-0000-4000-8000-000000000000')).status).toBe(401)
  // A holder of the permission learns that the squad does not exist; a non-holder gets the same
  // 403 it would get for a squad that does, so neither answer reveals which ids are real.
  const unknown = '/00000000-0000-4000-8000-000000000000'
  expect((await app.request(unknown, { headers: { 'x-test-scope': Permissions.SLOTS_USE } })).status).toBe(404)
  expect((await app.request(unknown, { headers: { 'x-test-scope': Permissions.SQUADS_READ } })).status).toBe(403)
  // Prefixes below the minimum length are refused outright rather than looked up.
  expect((await app.request('/abc', { headers: { 'x-test-scope': Permissions.SLOTS_USE } })).status).toBe(400)
})

describe('permission catalog completeness', () => {
  const catalog = new Set<string>(Object.values(Permissions))

  const usedByGuardsOrRoles = [
    'agent-types:read',
    'agent-types:create',
    'agent-types:update',
    'agent-types:delete',
    'squad-presets:read',
    'squad-presets:create',
    'squad-presets:update',
    'squad-presets:delete',
    'channels:read',
    'channels:create',
    'channels:update',
    'channels:delete',
    'provider-auth:read',
    'provider-auth:write',
    'webhooks:read',
    'agents:update',
    'agents:delete',
    'squads:update',
    'schedules:create',
    'schedules:update',
    'schedules:delete',
    'schedules:trigger',
    'terminal:read',
    'terminal:write',
    'ai:extract',
    'ai:transcribe',
    'ai:tts',
    'system:restart',
    'system:cleanup',
    'system:demo',
    'slots:use',
    'slots:write',
  ]

  for (const perm of usedByGuardsOrRoles) {
    test(`catalog contains ${perm}`, () => {
      expect(catalog.has(perm)).toBe(true)
    })
  }
})
