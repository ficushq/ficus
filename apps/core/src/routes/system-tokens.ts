import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '../lib/zod-validator'
import { requirePermission } from '../middleware'
import {
  listSystemTokens,
  createSystemToken,
  mayCreateSystemTokenNamed,
  revokeSystemToken,
  upgradePlatformMaintenanceToken,
} from '../services/auth/system-tokens'
import { auditActor, type Identity } from '../services/rbac'
import { wsManager } from '../services/ws/manager'
import {
  decidePlatformMaintenanceCompatibility,
  legacyUpgradePolicy,
  parsePlatformMaintenanceHeaders,
} from '../services/auth/platform-maintenance-compatibility'

const platformMaintenanceUpgradePolicy = legacyUpgradePolicy()

const createSystemTokenSchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1)).min(1),
})

// Managing user-less, scoped automation tokens is privilege-granting — admin-gated.
export const systemTokensRouter = new Hono()
  .post('/self/platform-maintenance-upgrade', requirePermission('machines:write'), async (c) => {
    const identity: Identity = c.get('identity')
    const parsed = parsePlatformMaintenanceHeaders((name) => c.req.header(name))
    const compatibility = decidePlatformMaintenanceCompatibility(platformMaintenanceUpgradePolicy, parsed)
    const result = await upgradePlatformMaintenanceToken({
      identity,
      actor: auditActor(identity),
      principalClass: identity.type,
      policy: platformMaintenanceUpgradePolicy,
      compatibility,
    })
    if (!result.ok) return c.json({ error: 'Platform maintenance compatibility request denied' }, result.status)
    return c.json({ scopes: result.scopes })
  })

  // GET /api/system-tokens?includeWebhook=true — list (auto-provisioned webhook tokens hidden by default)
  .get('/', requirePermission('system-tokens:manage'), async (c) => {
    const includeWebhook = c.req.query('includeWebhook') === 'true'
    return c.json(await listSystemTokens({ includeWebhook }))
  })

  // POST /api/system-tokens — create a manual token; the raw value is returned once.
  .post('/', requirePermission('system-tokens:manage'), zValidator('json', createSystemTokenSchema), async (c) => {
    const { name, scopes } = c.req.valid('json')
    if (!mayCreateSystemTokenNamed(c.get('identity') as Identity | undefined, name)) {
      return c.json({ error: `The system token name '${name}' is reserved for the Ficus platform` }, 403)
    }
    const { token, record } = await createSystemToken({ name, scopes, kind: 'manual' })
    return c.json({ ...record, token }, 201)
  })

  // DELETE /api/system-tokens/:id — revoke.
  .delete('/:id', requirePermission('system-tokens:manage'), async (c) => {
    const revoked = await revokeSystemToken(c.req.param('id'))
    if (!revoked) return c.json({ error: 'Token not found or already revoked' }, 404)
    wsManager.invalidateAccessCache()
    return c.json({ ok: true })
  })
