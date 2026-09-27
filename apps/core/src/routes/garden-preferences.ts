import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq, sql } from 'drizzle-orm'
import { readGardenSettings, validateGardenSettingsPatch } from '@ficus/shared'
import { db, gardenPreferences } from '../db'
import { resolveActingUser } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'

/** The caller's own garden settings (self-service, like /user-preferences). */
export const gardenPreferencesRouter = new Hono()
gardenPreferencesRouter.use('*', bodyLimit({ maxSize: 4096 }))

gardenPreferencesRouter.get('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const [row] = await db.select().from(gardenPreferences).where(eq(gardenPreferences.userId, identity.userId))
  return c.json({ userId: identity.userId, settings: readGardenSettings(row?.settings) })
})

/** Changes only the settings it names, atomically, so clients saving different settings never undo each other. */
gardenPreferencesRouter.patch('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { expectedUserId?: unknown; settings?: unknown })
  // A queued write must not follow a replaced session cookie into another account.
  // This is a precondition, never an authority to choose which user's row to write.
  if (body.expectedUserId !== identity.userId) return c.json({ error: 'Account changed' }, 409)
  const result = validateGardenSettingsPatch(body.settings)
  if (!result.ok) return c.json({ error: result.error }, 400)
  const [row] = await db
    .insert(gardenPreferences)
    .values({ userId: identity.userId, settings: result.patch })
    .onConflictDoUpdate({
      target: gardenPreferences.userId,
      set: { settings: sql`${gardenPreferences.settings} || excluded.settings`, updatedAt: new Date() },
    })
    .returning({ settings: gardenPreferences.settings })
  return c.json({ userId: identity.userId, settings: readGardenSettings(row?.settings) })
})
