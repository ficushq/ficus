import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  CUSTOM_THEME_MAX_BYTES,
  createThemePresetRequestSchema,
  deleteThemePresetRequestSchema,
  isThemePresetScope,
  updateThemePresetRequestSchema,
  updateThemePresetVisibilityRequestSchema,
} from '@ficus/shared'
import { resolveActingUser, auditActor, type Identity } from '../services/rbac'
import { requirePermission } from '../middleware/require-permission'
import { createLogger } from '../lib/infra/logger'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import {
  createThemePreset,
  deleteThemePreset,
  duplicateThemePreset,
  getOwnedThemePreset,
  getThemePresetForCaller,
  listThemePresets,
  moderateUnshareThemePreset,
  serializeThemePreset,
  setThemePresetVisibility,
  updateThemePreset,
  ThemePresetError,
} from '../services/theme-presets'

// Every route in this router except the moderation route below is self-service
// like /api/user-preferences: not RBAC-gated. Those are owner-only (or, for
// GET /:id and POST /:id/duplicate, "owner OR any instance-shared preset" —
// the live-link read and duplicate-from-shared paths) via resolveActingUser's
// caller, including the owner's squadless user-assistant agent.
//
// Body parsing deliberately avoids @hono/zod-validator here: its 'json' target
// swallows ANY c.req.json() error (including the bodyLimit 413 below) and
// rethrows a generic 400 "Malformed JSON" HTTPException, masking the real
// oversized-body status. Parsing the body manually (as /api/user-preferences
// does) keeps the bodyLimit middleware's 413 intact.
const uuidParam = z.string().uuid()
const log = createLogger('theme-presets')

export const themePresetsRouter = new Hono()
themePresetsRouter.use('*', bodyLimit({ maxSize: CUSTOM_THEME_MAX_BYTES + 1024 }))
themePresetsRouter.onError((error, c) => {
  if (error instanceof ThemePresetError) return c.json({ error: error.message }, error.status)
  throw error
})
// A malformed :id (not a UUID) would otherwise reach postgres as a raw query
// parameter and come back as an unhandled driver error (500). It is not a
// different preset than a well-formed-but-missing UUID from this caller's
// point of view, so it gets the exact same 404 — never a DB error leak.
// `/*` (not just the exact `/:id` path) so it also covers the visibility,
// share and duplicate sub-routes below.
themePresetsRouter.use('/:id/*', async (c, next) => {
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Theme preset not found' }, 404)
  await next()
})

themePresetsRouter.get('/', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const rawScope = c.req.query('scope')
  if (rawScope !== undefined && !isThemePresetScope(rawScope)) return c.json({ error: 'Invalid scope' }, 400)
  const entries = await listThemePresets(identity.userId, rawScope ?? 'mine')
  return c.json(entries.map(({ row, owner }) => serializeThemePreset(row, owner)))
})

themePresetsRouter.post('/', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { document?: unknown })
  const parsed = createThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  const row = await createThemePreset(identity.userId, parsed.data.document)
  const owned = await getOwnedThemePreset(identity.userId, row.id)
  return c.json(serializeThemePreset(row, owned!.owner), 201)
})

themePresetsRouter.get('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const found = await getThemePresetForCaller(identity.userId, c.req.param('id'))
  if (!found) return c.json({ error: 'Theme preset not found' }, 404)
  return c.json(serializeThemePreset(found.row, found.owner))
})

themePresetsRouter.put('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { revision?: unknown; document?: unknown })
  const parsed = updateThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  const row = await updateThemePreset(identity.userId, c.req.param('id'), parsed.data.revision, parsed.data.document)
  const owned = await getOwnedThemePreset(identity.userId, row.id)
  return c.json(serializeThemePreset(row, owned!.owner))
})

themePresetsRouter.delete('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { revision?: unknown })
  const parsed = deleteThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  await deleteThemePreset(identity.userId, c.req.param('id'), parsed.data.revision)
  return c.json({ ok: true })
})

themePresetsRouter.put('/:id/visibility', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { revision?: unknown; visibility?: unknown })
  const parsed = updateThemePresetVisibilityRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  const row = await setThemePresetVisibility(
    identity.userId,
    c.req.param('id'),
    parsed.data.revision,
    parsed.data.visibility
  )
  const owned = await getOwnedThemePreset(identity.userId, row.id)
  return c.json(serializeThemePreset(row, owned!.owner))
})

// Moderation: RBAC-gated (theme-presets:moderate), NOT self-service — an
// admin/operator can unshare (never delete) ANY user's preset. The owner
// keeps a private copy; requirePermission already sets authzChecked.
themePresetsRouter.delete('/:id/share', requirePermission('theme-presets:moderate'), async (c) => {
  const row = await moderateUnshareThemePreset(c.req.param('id'))
  log.info(`${auditActor(c.get('identity') as Identity)} removed theme preset ${row.id} from the shared list`)
  const owned = await getOwnedThemePreset(row.ownerUserId, row.id)
  return c.json(serializeThemePreset(row, owned!.owner))
})

themePresetsRouter.post('/:id/duplicate', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const row = await duplicateThemePreset(identity.userId, c.req.param('id'))
  const owned = await getOwnedThemePreset(identity.userId, row.id)
  return c.json(serializeThemePreset(row, owned!.owner), 201)
})
