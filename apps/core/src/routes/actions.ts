import { Hono } from 'hono'
import * as actionsService from '../services/agents/actions'
import type { Identity } from '../services/rbac'

export const actionsRouter = new Hono().get('/pending', async (c) => {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  // Each listed action is scoped to the identity by the pending-action policy.
  c.set('authzChecked', true)

  // Every action type by default. `?types=a,b` (or repeated `?types=a&types=b`) narrows to those
  // types; an unknown type is a 400 rather than silently ignored, so a typo never reads as
  // "nothing needs you". The retired `?include=` opt-in is ignored, so a client that still sends
  // it gets every type.
  const requested = (c.req.queries('types') ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const unknown = requested.filter((value) => !actionsService.isPendingActionType(value))
  if (unknown.length > 0) {
    return c.json(
      {
        error: `Unknown pending action type: ${unknown.join(', ')}`,
        code: 'invalid_action_type',
        validTypes: actionsService.PENDING_ACTION_TYPES,
      },
      400
    )
  }
  const types = requested.filter(actionsService.isPendingActionType)
  return c.json(await actionsService.listPendingActionsForIdentity(identity, types.length > 0 ? { types } : {}))
})
