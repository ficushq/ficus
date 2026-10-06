import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { requirePermission } from '../middleware/require-permission'
import { parseJsonBody } from './json-body'
import {
  RelayConnectionError,
  relayServerConnection,
  type RelayServerConnection,
} from '../services/push/server-connection'

function userId(c: Context) {
  const identity = c.get('identity')
  if (identity?.type !== 'user') throw new RelayConnectionError('A user account is required.', 403)
  return identity.userId
}

export function createPushServerConnectionRouter(service: RelayServerConnection = relayServerConnection) {
  const router = new Hono()
  router.use('*', bodyLimit({ maxSize: 2048 }))
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.get('identity')?.type !== 'user') return c.json({ error: 'A user account is required.' }, 403)
    await next()
  })
  router.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof RelayConnectionError ? error.message : 'The connection could not be updated. Try again.',
      },
      error instanceof RelayConnectionError ? error.status : 503
    )
  )
  router.get('/', requirePermission('settings:read'), async (c) => c.json(await service.status()))
  router.post('/', requirePermission('settings:write'), async (c) => {
    const body = await parseJsonBody(c)
    const input = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .safeParse(body.ok ? body.value : null)
    if (!input.success) return c.json({ error: 'Enter a server name (up to 80 characters).' }, 400)
    return c.json(await service.start(userId(c), input.data.name))
  })
  router.post('/poll', requirePermission('settings:write'), async (c) => {
    const body = await parseJsonBody(c)
    const input = z
      .object({ id: z.string().uuid() })
      .strict()
      .safeParse(body.ok ? body.value : null)
    if (!input.success) return c.json({ error: 'Invalid connection request.' }, 400)
    return c.json(await service.poll(userId(c), input.data.id))
  })
  router.delete('/', requirePermission('settings:write'), async (c) => c.json(await service.disconnect(userId(c))))
  return router
}
