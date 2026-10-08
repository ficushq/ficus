import { Hono } from 'hono'
import { z } from 'zod'
import { DELIVERY_SUGGESTION_MAX_DRAFT_LENGTH } from '@ficus/shared'
import { Agent } from '../entities/Agent'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import { isAllowedMessageTarget } from '../services/agents/message-target'
import { suggestDelivery, type DeliverySuggestionDeps } from '../services/composer/delivery-suggestion'
import { decide, isDecisionFeatureEnabled } from '../services/decisions/service'

const bodySchema = z.object({ draft: z.string().max(DELIVERY_SUGGESTION_MAX_DRAFT_LENGTH) })

const defaultDeps: DeliverySuggestionDeps = {
  decide: (purpose, input, options) => decide(purpose, input, options),
  isEnabled: () => isDecisionFeatureEnabled('composer-delivery'),
}

/**
 * POST /api/agents/:id/delivery-suggestion — whether a draft written while the agent works should
 * interrupt it (it's about the current work) or follow up (it isn't). Authorized exactly like
 * sending that agent a message. Tests inject `decide` and the feature switch.
 */
export function createAgentDeliverySuggestionRouter(deps: DeliverySuggestionDeps = defaultDeps) {
  return new Hono().post(
    '/:id/delivery-suggestion',
    requireEntityPermission('agents:run', async (c) => (await Agent.find(c.req.param('id')))?.squadId ?? null, {
      loadOwnerUserId: async (c) => (await Agent.find(c.req.param('id')))?.ownerUserId ?? null,
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      const body = bodySchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: `Send {draft}, at most ${DELIVERY_SUGGESTION_MAX_DRAFT_LENGTH} characters` }, 400)
      }
      if (!isAllowedMessageTarget(agent)) return c.json({ suggestion: null })
      return c.json(await suggestDelivery(agent, body.data.draft, deps, c.req.raw.signal))
    }
  )
}

export const agentDeliverySuggestionRouter = createAgentDeliverySuggestionRouter()
