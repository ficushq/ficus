import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inArray, like } from 'drizzle-orm'
import { db, publicVoices, squads } from '../db'
import { PublicVoice } from '../entities/PublicVoice'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { publicVoiceSync } from '../services/config-sync'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { publicVoicesRoutes } from './public-voices'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/public-voices', publicVoicesRoutes)

const prefix = `pv-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const teamId = `${prefix}-team`
let admin: TestUser
let reader: TestUser
const squadIds: string[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  reader = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['agent-types:read'] })
  await assignRole({ userId: reader.id, roleId: role.id, scope: 'system' })
  await publicVoiceSync.sync()
})

afterAll(async () => {
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  await db.delete(publicVoices).where(like(publicVoices.id, `${prefix}%`))
  await publicVoiceSync.revertToTemplate('default').catch(() => {})
  await PublicVoice.setDisabled('default', false)
  await cleanupTestRbac(prefix)
})

function request(user: TestUser, method: string, path: string, body?: unknown) {
  return app.request(`/api/public-voices${path === '/' ? '' : path}`, {
    method,
    headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('voice profile routes', () => {
  test('lists the shipped default with its template, size and assignment count', async () => {
    const res = await request(admin, 'GET', '/')
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    const dflt = list.find((p) => p.id === 'default')!
    expect(dflt.hasTemplate).toBe(true)
    expect(dflt.bytes).toBeGreaterThan(500)
    expect(typeof dflt.assignedSquadCount).toBe('number')
  })

  test('creates a profile; rejects a bad id, a duplicate and an over-cap voice', async () => {
    let res = await request(admin, 'POST', '/', { id: teamId, name: 'Team', base: 'Team voice.' })
    expect(res.status).toBe(201)
    expect((await res.json()).hasTemplate).toBe(false)

    res = await request(admin, 'POST', '/', { id: 'Team Voice', name: 'Team', base: 'x' })
    expect(res.status).toBe(400)
    res = await request(admin, 'POST', '/', { id: teamId, name: 'Team', base: 'x' })
    expect(res.status).toBe(409)
    res = await request(admin, 'POST', '/', {
      id: `${prefix}-big`,
      name: 'Big',
      base: 'x'.repeat(1990),
      surfaces: { commits: { mode: 'add', text: 'y'.repeat(100) } },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'public_voice_too_long', maxBytes: 2000 })
  })

  test('concurrent creation never overwrites an existing name or draft', async () => {
    const id = `${prefix}-collision`
    const responses = await Promise.all([
      request(admin, 'POST', '/', { id, name: 'First', base: 'First draft.' }),
      request(admin, 'POST', '/', { id, name: 'Second', base: 'Second draft.' }),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409])
    const winner = await responses.find((r) => r.status === 201)!.json()
    const stored = await PublicVoice.find(id)
    expect(stored!.name).toBe(winner.name)
    expect(stored!.base).toBe(winner.base)
  })

  test('editing the default records a field override and reports squads pushed over the cap', async () => {
    const squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'voice' })
    squadIds.push(squad.id)
    await Squad.setPublicVoice(squad.id, {
      publicVoiceId: null,
      publicVoice: { base: null, surfaces: { channels: { mode: 'override', text: 'z'.repeat(900) } } },
    })
    const current = (await PublicVoice.findDefault())!
    const res = await request(admin, 'PUT', '/default', {
      name: current.name,
      description: current.description,
      base: 'b'.repeat(1500),
      surfaces: current.surfaces,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.yamlFieldOverrides).toEqual(['base'])
    expect(body.overCapSquadCount).toBeGreaterThanOrEqual(1)

    const reverted = await request(admin, 'POST', '/default/revert-to-template')
    expect(reverted.status).toBe(200)
    expect((await PublicVoice.findDefault())!.base).toBe(current.base)
  })

  test('the default cannot be deleted; deleting an assigned profile unassigns its squads', async () => {
    expect((await request(admin, 'DELETE', '/default')).status).toBe(409)
    const squad = await Squad.create({ name: `${prefix}-assigned`, purpose: 'voice' })
    squadIds.push(squad.id)
    await Squad.setPublicVoice(squad.id, { publicVoiceId: teamId, publicVoice: null })
    const res = await request(admin, 'DELETE', `/${teamId}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, unassignedSquads: 1 })
    expect((await Squad.find(squad.id))!.publicVoiceId).toBeNull()
  })

  test('disable and enable, and the template diff', async () => {
    expect((await request(admin, 'POST', '/default/disable')).status).toBe(200)
    expect((await PublicVoice.findDefault())!.disabled).toBe(true)
    expect((await request(admin, 'POST', '/default/enable')).status).toBe(200)
    const diff = await (await request(admin, 'GET', '/default/template-diff')).json()
    expect(diff.hasDrift).toBe(false)
  })

  test('agent-types:read can read but not write', async () => {
    expect((await request(reader, 'GET', '/')).status).toBe(200)
    expect((await request(reader, 'PUT', '/default', { name: 'x', base: 'y' })).status).toBe(403)
    expect((await request(reader, 'POST', '/', { id: `${prefix}-r`, name: 'x', base: 'y' })).status).toBe(403)
  })
})
