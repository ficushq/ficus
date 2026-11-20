import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IntegrationAuthorizationStart } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { zValidator } from '../lib/zod-validator'
import { db, users } from '../db'
import type { Identity } from '../services/rbac'
import { AuthorizationFlowError } from '../services/integrations/authorization/service'
import type { LinearIdentityView } from '../services/integrations/linear/identity-authorization'

export interface LinearIdentityRoutesService {
  get(userId: string): Promise<LinearIdentityView>
  start(userId: string, returnTo: string): Promise<IntegrationAuthorizationStart | { authorizationUrl: string }>
  unlink(userId: string, organizationId?: string): Promise<boolean>
}

function failure(c: Context, error: unknown) {
  if (error instanceof AuthorizationFlowError)
    return c.json(
      { error: 'Linear account linking is unavailable', code: error.code },
      error.code === 'broker_unconfigured' || error.code === 'oauth_app_unconfigured' ? 503 : 400
    )
  throw error
}

/**
 * A signed-in person links or unlinks their own Linear account (design 6.6). Self-only: an agent never
 * acts as its user here, and the link records identity only, never a token.
 */
export function createLinearIdentityRouter(service: LinearIdentityRoutesService): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    if (identity?.type !== 'user')
      return c.json({ error: 'A signed-in person is required', code: 'human_required' }, 403)
    const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, identity.userId))
    if (!user || user.disabledAt)
      return c.json({ error: 'A signed-in person is required', code: 'human_required' }, 403)
    c.set('authzChecked', true)
    c.header('Cache-Control', 'no-store')
    await next()
  })
  const userId = (c: Context) => (c.get('identity') as Extract<Identity, { type: 'user' }>).userId
  app.get('/', async (c) => c.json(await service.get(userId(c))))
  app.post(
    '/authorization/start',
    zValidator('json', z.strictObject({ returnTo: z.string().min(1).max(1_024) })),
    async (c) => {
      try {
        return c.json(await service.start(userId(c), c.req.valid('json').returnTo))
      } catch (error) {
        return failure(c, error)
      }
    }
  )
  app.delete(
    '/',
    zValidator('json', z.strictObject({ organizationId: z.string().min(1).max(200).optional() })),
    async (c) => c.json({ unlinked: await service.unlink(userId(c), c.req.valid('json').organizationId) })
  )
  return app
}
