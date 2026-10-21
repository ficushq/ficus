import { relayRoutingSchema, type RelayRouting } from '@ficus/shared/push-relay'

/**
 * The routing fields the relay schema accepts, each validated on its own: a field the
 * schema rejects is dropped and the rest still travel, so one bad value never costs the
 * whole alert. Validating the object at once used to fail every question and wait alert
 * when the schema still wanted a UUID for the composite Action Center id.
 */
export function sanitizeRelayRouting(routing: Record<string, unknown>): RelayRouting {
  const allowed: RelayRouting = {}
  for (const key of [
    'squadId',
    'agentId',
    'workStreamId',
    'waitId',
    'questionId',
    'messageId',
    'actionId',
    'eventType',
    'workStreamNumber',
    'preview',
    'collapseKey',
    'threadKey',
    'interruptionLevel',
  ] as const) {
    if (routing[key] !== undefined) {
      const candidate = relayRoutingSchema.safeParse({ [key]: routing[key] })
      if (candidate.success) Object.assign(allowed, candidate.data)
    }
  }
  return allowed
}
