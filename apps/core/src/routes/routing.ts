import { zValidator } from '../lib/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Squad } from '../entities/Squad'
import { suggestSquadWithRecommendation } from '../services/routing'
import { requireSquadPermission } from '../middleware/require-permission'

const suggestQuerySchema = z.object({
  question: z.string().min(1, 'Question is required'),
  limit: z.string().optional(),
})

export const routingRouter = new Hono().get(
  '/:squadId/suggest-squad',
  requireSquadPermission('routing:read', 'squadId'),
  zValidator('query', suggestQuerySchema),
  async (c) => {
    const squadId = c.req.param('squadId')
    const { question, limit } = c.req.valid('query')

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined
    const response = await suggestSquadWithRecommendation(squadId, question, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    })

    return c.json(response)
  }
)
