import { Hono } from 'hono'
import * as actionsService from '../services/agents/actions'
import type { Identity } from '../services/rbac'

export const actionsRouter = new Hono().get('/pending', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)

  // Delivery-gate actions are opt-in (?include=workstream-delivery) so older
  // clients never receive an action type they cannot render.
  const include = new Set((c.req.query('include') ?? '').split(',').map((value) => value.trim()))
  const actions = await actionsService.listPendingActionsForIdentity(identity, {
    includeDeliveryGates: include.has('workstream-delivery'),
  })
  c.set('authzChecked', true)
  return c.json(actions)
})
