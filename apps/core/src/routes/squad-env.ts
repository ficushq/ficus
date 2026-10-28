import { Hono } from 'hono'
import { zValidator } from '../lib/zod-validator'
import { z } from 'zod'
import * as squadEnv from '../services/squad/env'
import { requireSquadPermission } from '../middleware'
// The full squad id the guard already resolved AND authorized: re-deriving it from the route param
// would repeat the lookup and could let a handler act on a different squad than the guard checked.
import { resolvedSquadId } from '../middleware/require-permission'

const setEnvSchema = z.object({
  content: z.string(),
})

export const squadEnvRouter = new Hono()
  // Get .ficus/.env content
  .get('/:squadId/env', requireSquadPermission('env:read', 'squadId'), async (c) => {
    const squadId = resolvedSquadId(c)

    const content = squadEnv.getEnvFile(squadId)
    return c.json({ content: content ?? '' })
  })

  // Set .ficus/.env content
  .put('/:squadId/env', requireSquadPermission('env:write', 'squadId'), zValidator('json', setEnvSchema), async (c) => {
    const squadId = resolvedSquadId(c)

    const { content } = c.req.valid('json')
    const reserved = squadEnv.findReservedSquadEnvKeys(content)
    if (reserved.length > 0) return c.json({ error: squadEnv.describeReservedSquadEnvKeys(reserved) }, 400)
    await squadEnv.setEnvFile(squadId, content)
    return c.json({ success: true })
  })
