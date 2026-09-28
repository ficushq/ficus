import { createHash, timingSafeEqual } from 'crypto'
import { createMiddleware } from 'hono/factory'
import { getSecretStore } from '../services/secrets'

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/**
 * Authenticates the in-cluster sandbox watcher's callbacks (e.g. workspace-files)
 * via a constant-time comparison against SANDBOX_CALLBACK_SECRET. The watcher has
 * no RBAC identity (no session, no agent token); this secret is independent of
 * the admin-users gate that disables legacy FICUS_PASSWORD, so the callback keeps
 * working once admin users exist. identityMiddleware bypasses this path, so this
 * is the sole auth gate for the route.
 */
export const requireSandboxCallback = createMiddleware(async (c, next) => {
  const expected = getSecretStore().get('SANDBOX_CALLBACK_SECRET')
  const authHeader = c.req.header('Authorization')
  const presented = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined

  if (!expected || !presented) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!timingSafeEqual(sha256(presented), sha256(expected))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('authzChecked', true)
  return next()
})
