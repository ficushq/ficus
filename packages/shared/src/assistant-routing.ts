import { z } from 'zod'

/*
 * Assistant squad routing: before the Assistant answers a user message, a decision model says
 * whether it is about Ficus itself, general work, or one squad's project. The answer is kept on the
 * message (`MessageMetadata.assistantRouting`) so the UI can show it and the user can correct it.
 */

/**
 * - `instance`: Ficus itself (settings, admin, the instance), not any squad's project.
 * - `general`: work that is not tied to one squad's project.
 * - `squad`: a feature or bug in one squad's project.
 * - `none`: the user said no squad (a correction only).
 */
export const ASSISTANT_ROUTING_SCOPES = ['instance', 'general', 'squad', 'none'] as const
export type AssistantRoutingScope = (typeof ASSISTANT_ROUTING_SCOPES)[number]

/** The Assistant uses a routing hint only at or above this confidence. */
export const ASSISTANT_ROUTING_MIN_CONFIDENCE = 0.6

export interface AssistantRoutingTarget {
  scope: AssistantRoutingScope
  squadId?: string
  squadName?: string
}

/** What the decision model said about a user message, and the user's correction if they made one. */
export interface AssistantRoutingHint extends AssistantRoutingTarget {
  /** The decision model's probability for its pick, 0 to 1. */
  confidence: number
  /** The user picked a different target; it overrides the decision model's pick. */
  correction?: AssistantRoutingTarget & { at: string }
}

/** The user's routing correction, on the message that carries it to the Assistant. */
export interface AssistantRoutingCorrection extends AssistantRoutingTarget {
  /** The user message it corrects. */
  messageId: string
  /** The start of that message, so the Assistant knows which one it is. */
  excerpt?: string
}

export const assistantRoutingCorrectionRequestSchema = z.discriminatedUnion('scope', [
  z.object({
    messageId: z.string().uuid(),
    clientId: z.string().uuid(),
    scope: z.literal('squad'),
    squadId: z.string().uuid(),
  }),
  z.object({ messageId: z.string().uuid(), clientId: z.string().uuid(), scope: z.literal('none') }),
])
export type AssistantRoutingCorrectionRequest = z.infer<typeof assistantRoutingCorrectionRequestSchema>

/** The start of a message on one line, cut at a word near `max` characters. */
export function assistantRoutingExcerpt(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

/** The target the Assistant should use: the user's correction, else the decision model's pick. */
export function effectiveAssistantRouting(hint: AssistantRoutingHint): AssistantRoutingTarget {
  return hint.correction ?? hint
}

/** Whether a target sends work to no squad. */
export function assistantRoutingUsesNoSquad(target: AssistantRoutingTarget): boolean {
  return target.scope !== 'squad'
}

/** A short label for a target: the squad's name, "Not about a squad", "General" or "No squad". */
export function assistantRoutingLabel(target: AssistantRoutingTarget): string {
  switch (target.scope) {
    case 'squad':
      return target.squadName || 'A squad'
    case 'instance':
      return 'Not about a squad'
    case 'general':
      return 'General'
    case 'none':
      return 'No squad'
  }
}
