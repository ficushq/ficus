import { resolveActingUser } from '../services/rbac'
import { Hono } from 'hono'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { eq } from 'drizzle-orm'
import { db, notificationConfig } from '../db'
import { notificationSync } from '../services/config-sync'
import { notificationService } from '../services/notifications'
import { requirePermission } from '../middleware/require-permission'
import { UserNotificationPreferences } from '../entities/UserNotificationPreferences'
import { PUSH_CATEGORY_IDS } from '@ficus/shared'

// The mutable push categories (see PUSH_CATEGORIES) — surfaced so the per-user preferences UI can
// present one toggle per kind of push, independent of how routing rules are configured.
function pushEventTypes(): string[] {
  return [...PUSH_CATEGORY_IDS]
}

export const notificationConfigRouter = new Hono()

// GET /api/notification-config/me — the caller's own notification preferences (self-service)
notificationConfigRouter.get('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const prefs = await UserNotificationPreferences.get(identity.userId)
  return c.json({ ...prefs, pushEvents: pushEventTypes() })
})

// PUT /api/notification-config/me — update the caller's own notification preferences
notificationConfigRouter.put('/me', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(
    c,
    {} as { showPreviews?: unknown; pushEnabled?: unknown; mutedEvents?: unknown }
  )
  const prefs = await UserNotificationPreferences.upsert(identity.userId, {
    showPreviews: typeof body.showPreviews === 'boolean' ? body.showPreviews : undefined,
    pushEnabled: typeof body.pushEnabled === 'boolean' ? body.pushEnabled : undefined,
    mutedEvents: Array.isArray(body.mutedEvents) ? (body.mutedEvents as string[]) : undefined,
  })
  return c.json({ ...prefs, pushEvents: pushEventTypes() })
})

// GET /api/notification-config
notificationConfigRouter.get('/', requirePermission('settings:read'), async (c) => {
  const rows = await db.select().from(notificationConfig)
  const config = rows[0]
  if (!config) return c.json({ rules: [], channels: {}, yamlFieldOverrides: [] })
  return c.json(config)
})

// PUT /api/notification-config
notificationConfigRouter.put('/', requirePermission('settings:write'), async (c) => {
  const body = await c.req.json()
  await db
    .insert(notificationConfig)
    .values({ id: 'default', rules: body.rules, channels: body.channels })
    .onConflictDoUpdate({
      target: notificationConfig.id,
      set: { rules: body.rules, channels: body.channels, updatedAt: new Date() },
    })
  await notificationSync.recomputeFieldOverrides('default')
  // Update in-memory notification service
  notificationService.setConfig({ rules: body.rules, channels: body.channels })
  return c.json({ ok: true })
})

// GET /api/notification-config/template-diff
notificationConfigRouter.get('/template-diff', requirePermission('settings:read'), async (c) => {
  try {
    const diff = await notificationSync.getTemplateDiff('default')
    return c.json(diff)
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
})

// POST /api/notification-config/revert-to-template
notificationConfigRouter.post('/revert-to-template', requirePermission('settings:write'), async (c) => {
  try {
    await notificationSync.revertToTemplate('default')
    // Reload config into service
    const rows = await db.select().from(notificationConfig)
    if (rows[0]) {
      notificationService.setConfig({ rules: rows[0].rules as any[], channels: rows[0].channels as any })
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

// POST /api/notification-config/revert-template-fields
notificationConfigRouter.post('/revert-template-fields', requirePermission('settings:write'), async (c) => {
  try {
    const body = await c.req.json()
    await notificationSync.revertTemplateFields('default', body.fields ?? [])
    const rows = await db.select().from(notificationConfig)
    if (rows[0]) {
      notificationService.setConfig({ rules: rows[0].rules as any[], channels: rows[0].channels as any })
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

// POST /api/notification-config/disable
notificationConfigRouter.post('/disable', requirePermission('settings:write'), async (c) => {
  await notificationSync.setDisabled('default', true)
  return c.json({ ok: true })
})

// POST /api/notification-config/enable
notificationConfigRouter.post('/enable', requirePermission('settings:write'), async (c) => {
  await notificationSync.setDisabled('default', false)
  return c.json({ ok: true })
})

// GET /api/notification-config/export
notificationConfigRouter.get('/export', requirePermission('settings:read'), async (c) => {
  const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
  if (!rows[0]) return c.json({ error: 'Not found' }, 404)
  const yamlStr = notificationSync.toYaml(rows[0] as any)
  return c.text(yamlStr, 200, { 'Content-Type': 'text/yaml' })
})
