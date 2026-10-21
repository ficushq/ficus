import { relayRoutingSchema, type RelayRouting } from '@ficus/shared/push-relay'

/**
 * The routing fields the relay schema accepts, each validated on its own: a field the
 * schema rejects is dropped and the rest still travel. Action Center ids are composite
 * (`agent-question:<uuid>`, `<type>:<workStreamId>:<waitId>`) while the schema wants a
 * UUID for `actionId`, so validating the whole object at once used to fail every question
 * and wait alert before any send; the question or wait id alone still focuses the item.
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
