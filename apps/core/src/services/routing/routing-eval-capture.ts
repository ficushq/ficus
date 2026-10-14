import { assistantRoutingExcerpt, assistantRoutingLabel, type AssistantRoutingTarget } from '@ficus/shared'
import { captureCorrection } from '../decisions/evals/capture'
import type { Identity } from '../rbac'
import {
  buildRoutingRequest,
  findInheritedRouting,
  listRoutableSquads,
  loadRoutingContext,
  type RoutingSquad,
} from './assistant-routing'

/** What the `assistant-routing` eval's rule needs besides the answers: the squad option keys, and whether there is earlier routing to keep. */
export interface RoutingEvalContext {
  keys: Record<string, RoutingSquad>
  earlierRouting: boolean
}

export const routingEvalContext = (keys: Map<string, RoutingSquad>, earlierRouting: boolean): RoutingEvalContext => ({
  keys: Object.fromEntries(keys),
  earlierRouting,
})

/**
 * A user's routing pick (the pill on their latest message, or before sending) as a candidate case
 * for the `assistant-routing` eval, when saving corrections is on. The request is rebuilt the way
 * the turn builds it, with the conversation before the message as context.
 */
export function captureRoutingCorrection(input: {
  identity: Identity
  agentId: string
  /** When the message was sent: the context is what came before it. */
  sentAt: Date
  text: string
  target: AssistantRoutingTarget
  source: string
}) {
  const expected =
    input.target.scope === 'squad' && input.target.squadName
      ? { expect: `squad:${input.target.squadName}` }
      : { accept: ['instance', 'general'] }
  return captureCorrection({
    evalName: 'assistant-routing',
    purpose: 'assistant-routing',
    build: async () => {
      const [context, squads] = await Promise.all([
        loadRoutingContext({ id: '', agentId: input.agentId, createdAt: input.sentAt }),
        listRoutableSquads(input.identity),
      ])
      const { request, keys } = buildRoutingRequest({
        text: input.text,
        recent: context.recent,
        squads,
        withKind: true,
      })
      const earlier = await findInheritedRouting({ id: '', agentId: input.agentId, createdAt: input.sentAt })
      return { request, context: routingEvalContext(keys, earlier !== null) }
    },
    ...expected,
    summary: `"${assistantRoutingExcerpt(input.text, 80)}" → ${assistantRoutingLabel(input.target)}`,
    source: { kind: input.source },
  })
}
