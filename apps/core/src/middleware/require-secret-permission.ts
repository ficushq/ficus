import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { Identity } from '../services/rbac'
import { hasAnyPermission, resolvePermissions } from '../services/rbac'
import { canListAnySecret, secretAccessible, secretPermissionCandidates } from '../services/secrets/groups'

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

/**
 * Which Secret Store keys the request's caller may READ, system-scoped exactly as
 * `GET /api/secrets/:key` checks. Exposure routes (per squad, global, per agent) require it for
 * every key a change adds, so exposing a secret never grants more than the caller could read.
 */
export async function secretReader(c: Context): Promise<(key: string) => boolean> {
  const held = await resolvePermissions(c.get('identity') as Identity)
  return (key) => secretAccessible(held, key, 'read')
}
