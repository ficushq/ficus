import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq, sql } from 'drizzle-orm'
import { readFarmSettings, validateFarmSettingsPatch } from '@ficus/shared'
import { db, farmPreferences } from '../db'
import { resolveActingUser } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { wsManager } from '../services/ws/manager'

/** The caller's own farm settings (self-service, like /user-preferences). */
export const farmPreferencesRouter = new Hono()
farmPreferencesRouter.use('*', bodyLimit({ maxSize: 4096 }))

farmPreferencesRouter.get('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const [row] = await db.select().from(farmPreferences).where(eq(farmPreferences.userId, identity.userId))
  return c.json({ userId: identity.userId, settings: readFarmSettings(row?.settings) })
})

/** Changes only the settings it names, atomically, so clients saving different settings never undo each other. */
farmPreferencesRouter.patch('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { expectedUserId?: unknown; settings?: unknown })
  // A queued write must not follow a replaced session cookie into another account.
  // This is a precondition, never an authority to choose which user's row to write.
  if (body.expectedUserId !== identity.userId) return c.json({ error: 'Account changed' }, 409)
  const result = validateFarmSettingsPatch(body.settings)
  if (!result.ok) return c.json({ error: result.error }, 400)
  const [row] = await db
    .insert(farmPreferences)
    .values({ userId: identity.userId, settings: result.patch })
    .onConflictDoUpdate({
      target: farmPreferences.userId,
      set: { settings: sql`${farmPreferences.settings} || excluded.settings`, updatedAt: new Date() },
    })
    .returning({ settings: farmPreferences.settings })
  if (result.patch.look) wsManager.refreshPresence(identity.userId)
  return c.json({ userId: identity.userId, settings: readFarmSettings(row?.settings) })
})
