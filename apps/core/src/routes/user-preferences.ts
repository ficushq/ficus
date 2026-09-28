import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { CUSTOM_THEME_MAX_BYTES, validateThemePreference } from '@ficus/shared'
import { db, userPreferences } from '../db'
import { resolveActingUser } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'

export const userPreferencesRouter = new Hono()
userPreferencesRouter.use('*', bodyLimit({ maxSize: CUSTOM_THEME_MAX_BYTES + 1024 }))

userPreferencesRouter.get('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, identity.userId))
  return c.json({ userId: identity.userId, theme: row?.theme ?? null })
})

userPreferencesRouter.put('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { expectedUserId?: unknown; theme?: unknown })
  // A queued write must not follow a replaced session cookie into another account.
  // This is a precondition, never an authority to choose which user's row to write.
  if (body.expectedUserId !== identity.userId) return c.json({ error: 'Account changed' }, 409)
  const result = validateThemePreference(body.theme)
  if (!result.ok) return c.json({ error: result.error }, 400)
  await db
    .insert(userPreferences)
    .values({ userId: identity.userId, theme: result.theme })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { theme: result.theme, updatedAt: new Date() },
    })
  return c.json({ userId: identity.userId, theme: result.theme })
})
