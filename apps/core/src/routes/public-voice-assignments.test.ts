import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { db, squads } from '../db'
import { Squad } from '../entities/Squad'
import { PublicVoice } from '../entities/PublicVoice'
import { identityMiddleware } from '../middleware/identity'
import { squadVoiceRouter } from './squad-voice'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
const prefix = `preserve-voice-${Date.now()}`
const app = new Hono().use('*', identityMiddleware).route('/api/squads', squadVoiceRouter)
let admin: TestUser, reader: TestUser
const ids: string[] = []
beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  reader = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['squads:read'] })
  await assignRole({ userId: reader.id, roleId: role.id, scope: 'system' })
  await PublicVoice.upsert({ id: prefix, name: 'Team', base: 'Profile instructions.' })
})
afterAll(async () => {
  if (ids.length) await db.delete(squads).where(inArray(squads.id, ids))
  await PublicVoice.delete(prefix)
  await cleanupTestRbac(prefix)
})
const patch = (id: string, body: unknown, user = admin) =>
  app.request(`/api/squads/${id}/voice`, {
    method: 'PATCH',
    headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
test('opt-in assignments and clearing preserve the effective custom voice; legacy picker still replaces it', async () => {
  const squad = await Squad.create({ name: prefix, purpose: 'test' })
  ids.push(squad.id)
  await Squad.setPublicVoice(squad.id, {
    publicVoiceId: null,
    publicVoice: { base: 'Our custom instructions.', surfaces: {} },
  })
  for (const voiceId of [prefix, null]) {
    const response = await patch(squad.id, { voiceId, preserveCustomBase: true })
    expect(response.status).toBe(200)
    const state = await response.json()
    expect(state.voiceId).toBe(voiceId)
    expect(state.local.base).toBe('Our custom instructions.')
    expect(state.resolved.baseSource).toBe('squad')
  }
  expect((await patch(squad.id, { voiceId: prefix, preserveCustomBase: true }, reader)).status).toBe(403)
  const legacy = await (await patch(squad.id, { voiceId: prefix })).json()
  expect(legacy.local.base).toBeNull()
  expect(legacy.resolved.baseSource).toBe('profile')
})
test('preservation still checks disabled profiles, strict schema and rendered byte cap', async () => {
  const squad = await Squad.create({ name: `${prefix}-cap`, purpose: 'test' })
  ids.push(squad.id)
  await Squad.setPublicVoice(squad.id, {
    publicVoiceId: null,
    publicVoice: { base: 'b'.repeat(1900), surfaces: { channels: { mode: 'add', text: 'x'.repeat(200) } } },
  })
  const over = await patch(squad.id, { voiceId: prefix, preserveCustomBase: true })
  expect(over.status).toBe(400)
  expect((await over.json()).error).toBe('public_voice_too_long')
  await PublicVoice.setDisabled(prefix, true)
  try {
    expect((await patch(squad.id, { voiceId: prefix, preserveCustomBase: true })).status).toBe(400)
  } finally {
    await PublicVoice.setDisabled(prefix, false)
  }
  expect((await patch(squad.id, { voiceId: prefix, preserveCustomBase: 'yes' })).status).toBe(400)
})
