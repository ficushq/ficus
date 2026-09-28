import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { entitySearchQuerySchema } from '@ficus/shared'
import { searchEntities } from '../services/entity-search'
export const searchRouter = new Hono().get('/', zValidator('query', entitySearchQuerySchema), async (c) => {
  const identity = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  return c.json(await searchEntities(identity, c.req.valid('query')))
})
