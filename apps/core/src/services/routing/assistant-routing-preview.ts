import {
  ASSISTANT_ROUTING_MIN_CONFIDENCE,
  assistantRoutingSendSchema,
  type AssistantRoutingHint,
  type AssistantRoutingPreview,
  type AssistantRoutingTarget,
} from '@ficus/shared'
import { requireAssistantConversation } from '../assistant-task-requests'
import type { Identity } from '../rbac'
import {
  listRoutableSquads,
  routeAssistantText,
  SUGGEST_SQUAD_TIMEOUT_MS,
  type AssistantRoutingDeps,
  type RoutingSquad,
} from './assistant-routing'

/** Drafts shorter than this many words are too thin to route. */
export const ASSISTANT_ROUTING_PREVIEW_MIN_WORDS = 3

const words = (text: string) => text.split(/\s+/).filter(Boolean).length

/**
 * Where a draft in an Assistant conversation would go, asked while the user types so they can
 * change it before sending. The same decision a sent message gets, with the conversation so far as
 * context; only a confident target comes back (none for a follow-up that keeps earlier routing).
 */
export async function previewAssistantRouting(
  identity: Identity | undefined,
  conversationId: string,
  draft: string,
  deps: AssistantRoutingDeps = {}
): Promise<AssistantRoutingPreview> {
  const { conversation } = await requireAssistantConversation(identity, conversationId)
  if (!conversation.agentId || conversation.kind !== 'assistant') return { hint: null }
  if (words(draft) < ASSISTANT_ROUTING_PREVIEW_MIN_WORDS) return { hint: null }
  const agentId = conversation.agentId
  const routing = await routeAssistantText(
    { type: 'agent', agentId, squadId: null },
    { id: 'preview', agentId, createdAt: new Date() },
    draft,
    { timeoutMs: SUGGEST_SQUAD_TIMEOUT_MS, ...deps },
    { kind: 'assistant-preview', agentId }
  )
  return { hint: routing && 'hint' in routing ? routing.hint : null }
}

/**
 * The routing an Assistant message is sent with from the composer (`AssistantRoutingSend`), checked
 * against the squads the sender can see: the preview's pick for that text, with the user's own pick
 * as its correction. Undefined when there is nothing usable, so the turn routes it as usual.
 */
export async function sentAssistantRouting(
  identity: Identity,
  raw: unknown,
  deps: { listSquads?: (identity: Identity) => Promise<RoutingSquad[]> } = {}
): Promise<AssistantRoutingHint | undefined> {
  const parsed = assistantRoutingSendSchema.safeParse(raw)
  if (!parsed.success || (!parsed.data.hint && !parsed.data.pick)) return undefined
  const { hint, pick } = parsed.data
  const squads = await (deps.listSquads ?? listRoutableSquads)(identity)
  const squad = (id: string | undefined) => squads.find((entry) => entry.id === id)
  const squadTarget = (id: string | undefined): AssistantRoutingTarget | null => {
    const found = squad(id)
    return found ? { scope: 'squad', squadId: found.id, squadName: found.name } : null
  }

  let model: AssistantRoutingHint | undefined
  if (hint && hint.confidence >= ASSISTANT_ROUTING_MIN_CONFIDENCE) {
    const target = hint.scope === 'squad' ? squadTarget(hint.squadId) : { scope: hint.scope }
    if (target) model = { ...target, confidence: hint.confidence }
  }
  const picked = pick ? (pick.scope === 'squad' ? squadTarget(pick.squadId) : { scope: 'none' as const }) : null
  if (!picked) return model
  // Picked before the preview answered: there is no model pick under the user's.
  return { ...(model ?? { scope: 'general', confidence: 0 }), correction: { ...picked, at: new Date().toISOString() } }
}
