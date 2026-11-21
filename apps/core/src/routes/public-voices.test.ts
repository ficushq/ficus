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
import { buildPublicVoicePrompt } from '../lib/prompts/public-voice-prompt'

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
  await PublicVoice.setInstanceDefaultId('default')
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

  for (const caller of ['reader', 'admin'] as const) {
    test(`${caller} can still read profiles whose valid ids resemble derivation endpoints`, async () => {
      for (const id of ['github-accounts', 'derive']) {
        // Do not overwrite an unrelated fixture if an id is unexpectedly already present.
        const created = await request(admin, 'POST', '/', {
          id,
          name: `Profile ${id}`,
          base: 'Synthetic profile instructions.',
        })
        expect(created.status).toBe(201)
        try {
          const res = await request(caller === 'reader' ? reader : admin, 'GET', `/${id}`)
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(Array.isArray(body)).toBe(false)
          expect(body).toMatchObject({ id, name: `Profile ${id}`, base: 'Synthetic profile instructions.' })
        } finally {
          await PublicVoice.delete(id)
        }
      }
    })
  }

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
    expect(await res.json()).toEqual({ ok: true, unassignedSquads: 1, clearedInstanceDefault: false })
    expect((await Squad.find(squad.id))!.publicVoiceId).toBeNull()
  })

  test('disable and enable, and the template diff', async () => {
    expect((await request(admin, 'POST', '/default/disable')).status).toBe(200)
    expect((await PublicVoice.findDefault())!.disabled).toBe(true)
    expect((await request(admin, 'POST', '/default/enable')).status).toBe(200)
    const diff = await (await request(admin, 'GET', '/default/template-diff')).json()
    expect(diff.hasDrift).toBe(false)
  })

  test('choosing the instance default: unassigned squads use it, assignments and custom bases do not', async () => {
    const chosenId = `${prefix}-chosen`
    expect((await request(admin, 'POST', '/', { id: chosenId, name: 'Chosen', base: 'Chosen voice.' })).status).toBe(
      201
    )
    const otherId = `${prefix}-other`
    expect((await request(admin, 'POST', '/', { id: otherId, name: 'Other', base: 'Other voice.' })).status).toBe(201)
    const unassigned = await Squad.create({ name: `${prefix}-unassigned`, purpose: 'voice' })
    const assigned = await Squad.create({ name: `${prefix}-explicit`, purpose: 'voice' })
    const custom = await Squad.create({ name: `${prefix}-custom`, purpose: 'voice' })
    squadIds.push(unassigned.id, assigned.id, custom.id)
    await Squad.setPublicVoice(assigned.id, { publicVoiceId: otherId, publicVoice: null })
    await Squad.setPublicVoice(custom.id, { publicVoiceId: null, publicVoice: { base: 'Ours.', surfaces: {} } })

    try {
      let res = await request(admin, 'GET', '/settings/instance-default')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ voiceId: 'default', effectiveVoiceId: 'default', fallback: null })

      res = await request(admin, 'PUT', '/settings/instance-default', { voiceId: chosenId })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        voiceId: chosenId,
        name: 'Chosen',
        effectiveVoiceId: chosenId,
        effectiveName: 'Chosen',
        fallback: null,
        overCapSquadCount: 0,
      })
      const list = (await (await request(admin, 'GET', '/')).json()) as Array<{
        id: string
        isInstanceDefault: boolean
      }>
      expect(list.filter((p) => p.isInstanceDefault).map((p) => p.id)).toEqual([chosenId])

      // Prompt assembly picks the change up without a restart.
      expect(await buildPublicVoicePrompt(await Squad.find(unassigned.id))).toBe('### Voice\n\nChosen voice.')
      expect(await buildPublicVoicePrompt(null)).toBe('### Voice\n\nChosen voice.')
      expect(await buildPublicVoicePrompt(await Squad.find(assigned.id))).toBe('### Voice\n\nOther voice.')
      expect(await buildPublicVoicePrompt(await Squad.find(custom.id))).toBe('### Voice\n\nOurs.')

      // Disabling the chosen default falls back to the shipped profile and says so.
      const disabled = await request(admin, 'POST', `/${chosenId}/disable`)
      expect(disabled.status).toBe(200)
      expect(await disabled.json()).toEqual({ ok: true, instanceDefaultFallback: true })
      expect(await (await request(admin, 'POST', `/${otherId}/disable`)).json()).toEqual({ ok: true })
      await request(admin, 'POST', `/${otherId}/enable`)
      expect(await (await request(admin, 'GET', '/settings/instance-default')).json()).toMatchObject({
        voiceId: chosenId,
        effectiveVoiceId: 'default',
        fallback: 'default_disabled',
      })
      const shipped = (await PublicVoice.findDefault())!
      expect(await buildPublicVoicePrompt(await Squad.find(unassigned.id))).toContain(shipped.base.trim())
      // A disabled profile cannot be chosen, nor an unknown one.
      expect((await request(admin, 'PUT', '/settings/instance-default', { voiceId: chosenId })).status).toBe(400)
      expect((await request(admin, 'PUT', '/settings/instance-default', { voiceId: `${prefix}-nope` })).status).toBe(
        400
      )
      // Re-enabling restores the choice.
      expect((await request(admin, 'POST', `/${chosenId}/enable`)).status).toBe(200)
      expect(await buildPublicVoicePrompt(await Squad.find(unassigned.id))).toBe('### Voice\n\nChosen voice.')

      // Deleting the chosen default clears the choice: the shipped profile applies again.
      res = await request(admin, 'DELETE', `/${chosenId}`)
      expect(await res.json()).toEqual({ ok: true, unassignedSquads: 0, clearedInstanceDefault: true })
      expect(await (await request(admin, 'GET', '/settings/instance-default')).json()).toMatchObject({
        voiceId: 'default',
        fallback: null,
      })
      expect(await PublicVoice.instanceDefaultId()).toBe('default')
    } finally {
      await PublicVoice.setInstanceDefaultId('default')
    }
  })

  test('choosing a new default reports the squads on the instance default it pushes over the cap', async () => {
    const bigId = `${prefix}-big-default`
    expect((await request(admin, 'POST', '/', { id: bigId, name: 'Big', base: 'b'.repeat(1500) })).status).toBe(201)
    const squad = await Squad.create({ name: `${prefix}-entries`, purpose: 'voice' })
    squadIds.push(squad.id)
    await Squad.setPublicVoice(squad.id, {
      publicVoiceId: null,
      publicVoice: { base: null, surfaces: { channels: { mode: 'override', text: 'z'.repeat(900) } } },
    })
    try {
      const res = await request(admin, 'PUT', '/settings/instance-default', { voiceId: bigId })
      expect(res.status).toBe(200)
      expect((await res.json()).overCapSquadCount).toBeGreaterThanOrEqual(1)
      // Editing the chosen default counts the squads on the instance default too.
      const edit = await request(admin, 'PUT', `/${bigId}`, { name: 'Big', base: 'c'.repeat(1500) })
      expect((await edit.json()).overCapSquadCount).toBeGreaterThanOrEqual(1)
    } finally {
      await PublicVoice.setInstanceDefaultId('default')
    }
  })

  test('reading the instance default needs agent-types:read; choosing it needs agent-types:update', async () => {
    expect((await request(reader, 'GET', '/settings/instance-default')).status).toBe(200)
    expect((await request(reader, 'PUT', '/settings/instance-default', { voiceId: 'default' })).status).toBe(403)
    const outsider = await createTestUser({ prefix: `${prefix}-outsider` })
    expect((await request(outsider, 'GET', '/settings/instance-default')).status).toBe(403)
    expect((await request(admin, 'PUT', '/settings/instance-default', { voiceId: 'Not An Id' })).status).toBe(400)
  })

  test('agent-types:read can read but not write', async () => {
    expect((await request(reader, 'GET', '/')).status).toBe(200)
    expect((await request(reader, 'PUT', '/default', { name: 'x', base: 'y' })).status).toBe(403)
    expect((await request(reader, 'POST', '/', { id: `${prefix}-r`, name: 'x', base: 'y' })).status).toBe(403)
  })
})
