import { createMiddleware } from 'hono/factory'
import type { Identity } from '../services/rbac'
import { hasAnyPermission, resolvePermissions } from '../services/rbac'
import { canListAnySecret, secretPermissionCandidates } from '../services/secrets/groups'

export function requireSecretKeyPermission(action: 'read' | 'write') {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)

    c.set('authzChecked', true)
    const key = c.req.param('key')
    if (!key) return c.json({ error: 'Secret key required' }, 400)

    if (await hasAnyPermission(identity, secretPermissionCandidates(key, action))) {
      return next()
    }

    return c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireSecretListAccess() {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)

    c.set('authzChecked', true)
    const heldPermissions = await resolvePermissions(identity)
    if (canListAnySecret(heldPermissions)) {
      return next()
    }

    return c.json({ error: 'Forbidden' }, 403)
  })
}
