import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { themePresetsRouter } from './theme-presets'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { db, themePresets, users } from '../db'
import { THEME_PRESET_MAX_PER_USER } from '@ficus/shared'

const prefix = `theme-presets-${crypto.randomUUID()}`
let a: TestUser
let b: TestUser
const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/theme-presets', themePresetsRouter)

const doc = (name = 'Mine') => ({
  format: 'tau-custom-theme',
  version: 2,
  name,
  base: 'harbor',
  variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
})

const list = (user: TestUser, scope?: 'mine' | 'shared' | 'all') =>
  app.request(`/theme-presets${scope ? `?scope=${scope}` : ''}`, { headers: authHeaders(user.token) })
const get = (user: TestUser, id: string) => app.request(`/theme-presets/${id}`, { headers: authHeaders(user.token) })
const create = (user: TestUser, document: unknown) =>
  app.request('/theme-presets', {
    method: 'POST',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document }),
  })
const update = (user: TestUser, id: string, revision: number, document: unknown) =>
  app.request(`/theme-presets/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, document }),
  })
const remove = (user: TestUser, id: string, revision: number) =>
  app.request(`/theme-presets/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision }),
  })
const setVisibility = (user: TestUser, id: string, revision: number, visibility: string) =>
  app.request(`/theme-presets/${id}/visibility`, {
    method: 'PUT',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, visibility }),
  })
const removeShare = (user: TestUser, id: string) =>
  app.request(`/theme-presets/${id}/share`, { method: 'DELETE', headers: authHeaders(user.token) })
const duplicate = (user: TestUser, id: string) =>
  app.request(`/theme-presets/${id}/duplicate`, { method: 'POST', headers: authHeaders(user.token) })

beforeAll(async () => {
  a = await createTestUser({ prefix })
  b = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

test('anonymous access cannot read or mutate presets', async () => {
  for (const request of [
    () => app.request('/theme-presets'),
    () => app.request('/theme-presets/00000000-0000-4000-8000-000000000000'),
    () => app.request('/theme-presets', { method: 'POST' }),
    () => app.request('/theme-presets/00000000-0000-4000-8000-000000000000/visibility', { method: 'PUT' }),
    () => app.request('/theme-presets/00000000-0000-4000-8000-000000000000/share', { method: 'DELETE' }),
    () => app.request('/theme-presets/00000000-0000-4000-8000-000000000000/duplicate', { method: 'POST' }),
  ])
    expect((await request()).status).toBe(401)
})

test('create, list, get, update (revision) and delete (revision) are owner-scoped', async () => {
  expect(await (await list(a)).json()).toEqual([])
  const created = await create(a, doc('First'))
  expect(created.status).toBe(201)
  const preset = await created.json()
  expect(preset).toMatchObject({
    ownerUserId: a.id,
    visibility: 'private',
    revision: 1,
    document: doc('First'),
    owner: { id: a.id, displayName: a.displayName },
  })
  expect(preset.id).toBeString()

  expect(await (await list(a)).json()).toEqual([preset])
  expect(await (await list(b)).json()).toEqual([])

  expect((await get(b, preset.id)).status).toBe(404) // another user's preset is invisible, not forbidden
  expect(await (await get(a, preset.id)).json()).toEqual(preset)

  const updated = await update(a, preset.id, 1, doc('Renamed'))
  expect(updated.status).toBe(200)
  const updatedBody = await updated.json()
  expect(updatedBody).toMatchObject({ id: preset.id, revision: 2, document: doc('Renamed') })

  // Stale revision -> 409, document unchanged.
  const stale = await update(a, preset.id, 1, doc('Stale'))
  expect(stale.status).toBe(409)
  expect((await (await get(a, preset.id)).json()).document).toEqual(doc('Renamed'))

  // Another user cannot update or delete -> 404 (not found, not 403 — no cross-user existence leak).
  expect((await update(b, preset.id, 2, doc('Hijack'))).status).toBe(404)
  expect((await remove(b, preset.id, 2)).status).toBe(404)

  expect((await remove(a, preset.id, 2)).status).toBe(200)
  expect(await (await list(a)).json()).toEqual([])
  expect(await db.select().from(themePresets).where(eq(themePresets.id, preset.id))).toHaveLength(0)
})

test('rejects invalid documents (422) and enforces the per-user cap (409)', async () => {
  expect((await create(a, { ...doc(), base: 'not-a-theme' })).status).toBe(422)
  expect((await create(a, { ...doc(), variants: { light: { '--color-primary': 'url(x)' }, dark: {} } })).status).toBe(
    422
  )
  const ids: string[] = []
  for (let i = 0; i < THEME_PRESET_MAX_PER_USER; i++) {
    const response = await create(a, doc(`Preset ${i}`))
    expect(response.status).toBe(201)
    ids.push((await response.json()).id)
  }
  expect((await create(a, doc('One too many'))).status).toBe(409)
  for (const id of ids) await remove(a, id, 1)
})

test('a non-UUID :id is a 404, never a raw DB error', async () => {
  for (const bad of ['not-a-uuid', '123', 'DROP TABLE theme_presets', '00000000-0000-0000-0000-00000000000z']) {
    expect((await get(a, bad)).status).toBe(404)
    expect((await update(a, bad, 1, doc())).status).toBe(404)
    expect((await remove(a, bad, 1)).status).toBe(404)
  }
})

test('the per-user cap is race-safe: concurrent creates from 49 land exactly 1 more, never over 50', async () => {
  const c = await createTestUser({ prefix })
  const seeded: string[] = []
  for (let i = 0; i < THEME_PRESET_MAX_PER_USER - 1; i++) {
    const response = await create(c, doc(`Seed ${i}`))
    expect(response.status).toBe(201)
    seeded.push((await response.json()).id)
  }
  expect(await db.select().from(themePresets).where(eq(themePresets.ownerUserId, c.id))).toHaveLength(
    THEME_PRESET_MAX_PER_USER - 1
  )
  // Fire several concurrent creates at once (racing the count-then-insert
  // window); without a per-owner lock, more than one could observe the same
  // pre-insert count and all pass the cap check.
  const raceCount = 20
  const responses = await Promise.all(Array.from({ length: raceCount }, (_, i) => create(c, doc(`Race ${i}`))))
  const statuses = responses.map((r) => r.status).sort()
  expect(statuses).toEqual([201, ...Array(raceCount - 1).fill(409)])
  const rows = await db.select().from(themePresets).where(eq(themePresets.ownerUserId, c.id))
  expect(rows).toHaveLength(THEME_PRESET_MAX_PER_USER)
  for (const row of rows) await remove(c, row.id, row.revision)
})

test('body limit rejects an oversized request', async () => {
  const response = await app.request('/theme-presets', {
    method: 'POST',
    headers: { ...authHeaders(a.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: doc(), padding: 'x'.repeat(64000) }),
  })
  expect(response.status).toBe(413)
})

test('user deletion cascades preset rows', async () => {
  const removable = await createTestUser({ prefix })
  await create(removable, doc())
  await db.delete(users).where(eq(users.id, removable.id))
  expect(await db.select().from(themePresets).where(eq(themePresets.ownerUserId, removable.id))).toHaveLength(0)
})

// ── Phase 2: sharing ────────────────────────────────────────────────────────

test('scope=shared/all isolate visibility correctly: a private preset is never visible to another user', async () => {
  const created = await create(a, doc('Private one'))
  const preset = await created.json()

  // Private and not the caller's own: absent from every other-user scope.
  expect(await (await list(b, 'shared')).json()).not.toContainEqual(expect.objectContaining({ id: preset.id }))
  expect(await (await list(b, 'all')).json()).not.toContainEqual(expect.objectContaining({ id: preset.id }))

  const shared = await (await setVisibility(a, preset.id, 1, 'instance')).json()
  expect(shared).toMatchObject({ visibility: 'instance', revision: 2 })

  // Now visible to b via shared/all, with attribution, but NOT via b's own "mine" scope.
  expect(await (await list(b, 'shared')).json()).toContainEqual(
    expect.objectContaining({ id: preset.id, owner: { id: a.id, displayName: a.displayName } })
  )
  expect(await (await list(b, 'all')).json()).toContainEqual(expect.objectContaining({ id: preset.id }))
  expect(await (await list(b, 'mine')).json()).not.toContainEqual(expect.objectContaining({ id: preset.id }))
  // The owner's own scope=mine still includes it (still theirs, not duplicated into "shared" for themselves).
  expect(await (await list(a, 'mine')).json()).toContainEqual(expect.objectContaining({ id: preset.id }))
  expect(await (await list(a, 'shared')).json()).not.toContainEqual(expect.objectContaining({ id: preset.id }))

  await setVisibility(a, preset.id, 2, 'private')
  await remove(a, preset.id, 3)
})

test('GET /:id is a live-link fetch: any instance-shared preset is readable by anyone, private stays owner-only', async () => {
  const created = await create(a, doc('Link me'))
  const preset = await created.json()
  expect((await get(b, preset.id)).status).toBe(404) // still private

  await setVisibility(a, preset.id, 1, 'instance')
  const seenByB = await get(b, preset.id)
  expect(seenByB.status).toBe(200)
  expect(await seenByB.json()).toMatchObject({ id: preset.id, visibility: 'instance', document: doc('Link me') })

  await setVisibility(a, preset.id, 2, 'private') // owner unshares
  expect((await get(b, preset.id)).status).toBe(404) // unshared -> 404 again ("no longer shared")

  await remove(a, preset.id, 3)
})

test('PUT /:id/visibility is owner-only and revision-checked', async () => {
  const created = await create(a, doc('Mine to share'))
  const preset = await created.json()

  expect((await setVisibility(b, preset.id, 1, 'instance')).status).toBe(404) // not the owner

  const stale = await setVisibility(a, preset.id, 99, 'instance')
  expect(stale.status).toBe(409)

  const ok = await setVisibility(a, preset.id, 1, 'instance')
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ visibility: 'instance', revision: 2 })

  const back = await setVisibility(a, preset.id, 2, 'private')
  expect(back.status).toBe(200)
  expect(await back.json()).toMatchObject({ visibility: 'private', revision: 3 })

  await remove(a, preset.id, 3)
})

test('DELETE /:id/share requires theme-presets:moderate; unshares without deleting the owner’s preset', async () => {
  const created = await create(a, doc('Moderate me'))
  const preset = await created.json()
  await setVisibility(a, preset.id, 1, 'instance')

  // b has no permission at all -> forbidden.
  expect((await removeShare(b, preset.id)).status).toBe(403)

  const role = await createTestRole({ prefix, permissions: ['theme-presets:moderate'] })
  const moderator = await createTestUser({ prefix })
  await assignRole({ userId: moderator.id, roleId: role.id, scope: 'system' })

  const removed = await removeShare(moderator, preset.id)
  expect(removed.status).toBe(200)
  expect(await removed.json()).toMatchObject({ id: preset.id, visibility: 'private' })

  // The owner still has it (as private) — moderation unshares, never deletes.
  const stillOwned = await get(a, preset.id)
  expect(stillOwned.status).toBe(200)
  expect((await stillOwned.json()).visibility).toBe('private')
  // No longer visible to anyone else.
  expect((await get(b, preset.id)).status).toBe(404)

  await remove(a, preset.id, (await (await get(a, preset.id)).json()).revision)
})

test('DELETE /:id/share on an already-private or missing preset is a harmless no-op/404, never a fake success', async () => {
  const role = await createTestRole({ prefix, permissions: ['theme-presets:moderate'] })
  const moderator = await createTestUser({ prefix })
  await assignRole({ userId: moderator.id, roleId: role.id, scope: 'system' })

  const created = await create(a, doc('Already private'))
  const preset = await created.json()
  const result = await removeShare(moderator, preset.id)
  expect(result.status).toBe(200)
  expect((await result.json()).revision).toBe(1) // untouched: was never shared

  expect((await removeShare(moderator, '00000000-0000-4000-8000-000000000000')).status).toBe(404)
  await remove(a, preset.id, 1)
})

test('POST /:id/duplicate copies a shared preset into the caller’s own private library with a prefixed name', async () => {
  const created = await create(a, doc('Original'))
  const preset = await created.json()
  await setVisibility(a, preset.id, 1, 'instance')

  const dup = await duplicate(b, preset.id)
  expect(dup.status).toBe(201)
  const copy = await dup.json()
  expect(copy).toMatchObject({
    ownerUserId: b.id,
    visibility: 'private',
    document: { ...doc('Original'), name: 'Copy of Original' },
  })
  expect(copy.id).not.toBe(preset.id)

  // Also works for the owner's own preset (own-library duplicate).
  const ownDupResponse = await duplicate(a, preset.id)
  expect(ownDupResponse.status).toBe(201)
  const ownDup = await ownDupResponse.json()
  expect(ownDup).toMatchObject({ ownerUserId: a.id, visibility: 'private' })

  // A private preset owned by someone else is not duplicable (404, not leaked).
  const privateOne = await create(a, doc('Still private'))
  const privatePreset = await privateOne.json()
  expect((await duplicate(b, privatePreset.id)).status).toBe(404)

  await setVisibility(a, preset.id, 2, 'private') // owner unshares
  await remove(a, preset.id, 3)
  await remove(a, privatePreset.id, 1)
  await remove(b, copy.id, 1)
  await remove(a, ownDup.id, 1)
})

test('POST /:id/duplicate enforces the duplicating user’s own cap (409), not the source owner’s', async () => {
  const created = await create(a, doc('Cap source'))
  const preset = await created.json()
  await setVisibility(a, preset.id, 1, 'instance')

  const c = await createTestUser({ prefix })
  const ids: string[] = []
  for (let i = 0; i < THEME_PRESET_MAX_PER_USER; i++) {
    const response = await create(c, doc(`Filler ${i}`))
    ids.push((await response.json()).id)
  }
  expect((await duplicate(c, preset.id)).status).toBe(409)
  for (const id of ids) await remove(c, id, 1)
  await setVisibility(a, preset.id, 2, 'private')
  await remove(a, preset.id, 3)
})
