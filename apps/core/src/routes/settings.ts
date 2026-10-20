import { Hono } from 'hono'
import { getSettingsStore, isManagedSetting, SettingValidationError } from '../services/settings'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'
import { parseJsonBody } from './json-body'

const app = new Hono()

const MANAGED_SETTING_ERROR = 'Change the public address in Settings → Mobile & Pro (PUT /api/public-url).'

/** List all known settings with metadata */
app.get('/', requirePermission('settings:read'), async (c) => {
  const store = getSettingsStore()
  const list = await store.list()
  return c.json(list)
})

/** Get a single setting's value */
app.get('/:key', requirePermission('settings:read'), async (c) => {
  const key = c.req.param('key')
  if (key.startsWith('__integration-')) return c.json({ error: 'Use integration settings' }, 400)
  const store = getSettingsStore()
  const value = store.get(key)
  return c.json({ key, value })
})

/** Set a setting value */
app.put('/:key', requirePermission('settings:write'), async (c) => {
  const key = c.req.param('key')
  if (key.startsWith('__integration-')) return c.json({ error: 'Use integration settings' }, 400)
  if (isManagedSetting(key)) return c.json({ error: MANAGED_SETTING_ERROR }, 400)
  const parsedBody = await parseJsonBody(c)
  if (!parsedBody.ok) {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const body = parsedBody.value
  if (typeof body !== 'object' || body === null || !('value' in body) || body.value === undefined) {
    return c.json({ error: 'Missing "value" in request body' }, 400)
  }
  // Settings are stored as strings and their validators are written against
  // strings, so a JSON number — the obvious thing to send to a setting whose
  // declared type is `number` — used to reach `value.trim()` and blow up as a
  // 500 on a well-formed request. Keys without a validator were worse: the
  // non-string went straight to the DB with a 200.
  if (typeof body.value !== 'string') {
    return c.json({ error: `Field "value" must be a string (got ${typeof body.value})` }, 400)
  }
  const store = getSettingsStore()
  try {
    await store.set(key, body.value, auditActor(c.get('identity') as Identity))
  } catch (error) {
    // A rejected value is operator error, not a server fault — surface the
    // validator's message so the UI can show what the acceptable range is.
    if (error instanceof SettingValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
  return c.json({ key, updated: true })
})

/** Delete a setting / revert to default */
app.delete('/:key', requirePermission('settings:write'), async (c) => {
  const key = c.req.param('key')
  if (key.startsWith('__integration-')) return c.json({ error: 'Use integration settings' }, 400)
  if (isManagedSetting(key)) return c.json({ error: MANAGED_SETTING_ERROR }, 400)
  const store = getSettingsStore()
  await store.delete(key)
  return c.json({ key, deleted: true })
})

export default app
