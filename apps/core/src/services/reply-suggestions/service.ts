/**
 * Reply suggestions: when an agent's turn ends with a plain-text question to the human, a cheap
 * model writes 2–4 one-tap replies that the chat shows above the composer.
 *
 * Suggestions are a convenience only. Nothing is tracked, no wait is opened, and nothing blocks on
 * them: the work runs after the turn has already completed, and any error, timeout or doubt means
 * no chips. This file is pure (its I/O is injected); `runtime.ts` wires the database and models.
 */
import type { LightCompletionRequest, LightCompletionResult } from '../model-tiers/light-completion'
import { parseReplySuggestions } from './parse'
import { likelyAsksHuman } from './precheck'
import { buildReplySuggestionPrompt, REPLY_SUGGESTION_MAX_TOKENS, REPLY_SUGGESTION_SYSTEM } from './prompt'

/** The model tier reply suggestions use. */
export const REPLY_SUGGESTIONS_TIER = 'lite'
/** Settings key for the instance-wide switch. */
export const REPLY_SUGGESTIONS_SETTING = 'REPLY_SUGGESTIONS_ENABLED'
/** Suggestion requests running at once, instance-wide; more are skipped, not queued. */
export const MAX_REPLY_SUGGESTIONS_IN_FLIGHT = 4
/** Per-candidate and overall model deadlines: a late suggestion is a useless one. */
export const REPLY_SUGGESTION_TIMEOUT_MS = 6_000
export const REPLY_SUGGESTION_TOTAL_TIMEOUT_MS = 12_000
/** The message source of a person's own chat message. */
const USER_CHAT_SOURCE = 'user_chat'

export interface SuggestionRow {
  id: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: Date
  pending?: boolean
}

export interface AgentSuggestionState {
  status: string
  /** A blocking question card is open. */
  hasQuestionData: boolean
  /** Open async questions (ask_human) for this agent. */
  openQuestions: number
  /** For cost attribution in the inference ledger. */
  squadId?: string | null
}

export interface SuggestionTarget {
  messageId: string
  agentText: string
  humanText: string
}

/**
 * The agent message that gets chips, if any: the latest agent text, written after the person's
 * latest chat message. A turn started by an inbox, system or other non-chat message gets none, as
 * does a turn that ended without text or already has suggestions.
 *
 * @param latestHuman the agent's most recent human-role row (chat, inbox delivery or system)
 * @param recentAssistant the agent's latest assistant rows, newest first
 */
export function selectSuggestionTarget(
  latestHuman: SuggestionRow | null,
  recentAssistant: readonly SuggestionRow[]
): SuggestionTarget | null {
  if (!latestHuman || latestHuman.pending) return null
  if (latestHuman.metadata?.source !== USER_CHAT_SOURCE || !latestHuman.content.trim()) return null
  const latest = recentAssistant.find((row) => row.metadata?.isSystem !== true)
  if (!latest || latest.createdAt.getTime() <= latestHuman.createdAt.getTime()) return null
  if (!latest.content.trim() || latest.metadata?.replySuggestions !== undefined) return null
  return { messageId: latest.id, agentText: latest.content, humanText: latestHuman.content }
}

/** No chips while the agent shows a question card, has open questions, or is not settled. */
export function agentAcceptsSuggestions(agent: AgentSuggestionState | null): boolean {
  return !!agent && agent.status === 'idle' && !agent.hasQuestionData && agent.openQuestions === 0
}

export interface ReplySuggestionDeps {
  /** The Settings switch, read at the start and again before saving. */
  isEnabled: () => boolean
  loadAgent: (agentId: string) => Promise<AgentSuggestionState | null>
  loadLatestHuman: (agentId: string) => Promise<SuggestionRow | null>
  loadRecentAssistant: (agentId: string) => Promise<SuggestionRow[]>
  complete: (request: LightCompletionRequest) => Promise<LightCompletionResult | null>
  /**
   * Save the replies on the message and notify clients. Must not save when a newer human message
   * has arrived since; resolves whether it saved.
   */
  save: (agentId: string, messageId: string, replies: string[]) => Promise<boolean>
  onError?: (error: unknown) => void
}

export type ReplySuggestionOutcome =
  | 'disabled'
  | 'busy'
  | 'agent-not-ready'
  | 'no-target'
  | 'no-question'
  | 'no-answer'
  | 'no-replies'
  | 'stale'
  | 'saved'
  | 'error'

/** Agents whose turn is being looked at, and how many requests run instance-wide. */
export class ReplySuggestionLimiter {
  private readonly agents = new Set<string>()
  constructor(private readonly max = MAX_REPLY_SUGGESTIONS_IN_FLIGHT) {}
  tryEnter(agentId: string): boolean {
    if (this.agents.has(agentId) || this.agents.size >= this.max) return false
    this.agents.add(agentId)
    return true
  }
  leave(agentId: string): void {
    this.agents.delete(agentId)
  }
}

/**
 * Suggest replies for an agent's just-completed turn. Never throws, and never touches the database
 * or a model while the switch is off.
 */
export async function suggestRepliesAfterTurn(
  agentId: string,
  deps: ReplySuggestionDeps,
  limiter: ReplySuggestionLimiter
): Promise<ReplySuggestionOutcome> {
  try {
    if (!deps.isEnabled()) return 'disabled'
  } catch (error) {
    deps.onError?.(error)
    return 'error'
  }
  if (!limiter.tryEnter(agentId)) return 'busy'
  try {
    const agent = await deps.loadAgent(agentId)
    if (!agentAcceptsSuggestions(agent)) return 'agent-not-ready'
    const [latestHuman, recentAssistant] = await Promise.all([
      deps.loadLatestHuman(agentId),
      deps.loadRecentAssistant(agentId),
    ])
    const target = selectSuggestionTarget(latestHuman, recentAssistant)
    if (!target) return 'no-target'
    if (!likelyAsksHuman(target.agentText)) return 'no-question'
    const answer = await deps.complete({
      tier: REPLY_SUGGESTIONS_TIER,
      system: REPLY_SUGGESTION_SYSTEM,
      prompt: buildReplySuggestionPrompt({ agentText: target.agentText, humanText: target.humanText }),
      maxTokens: REPLY_SUGGESTION_MAX_TOKENS,
      timeoutMs: REPLY_SUGGESTION_TIMEOUT_MS,
      totalTimeoutMs: REPLY_SUGGESTION_TOTAL_TIMEOUT_MS,
      purpose: 'reply-suggestions',
      source: { agentId, ...(agent?.squadId ? { squadId: agent.squadId } : {}) },
    })
    if (!answer) return 'no-answer'
    const replies = parseReplySuggestions(answer.text)
    if (replies.length === 0) return 'no-replies'
    // Switched off while the model was answering: drop the answer.
    if (!deps.isEnabled()) return 'disabled'
    return (await deps.save(agentId, target.messageId, replies)) ? 'saved' : 'stale'
  } catch (error) {
    deps.onError?.(error)
    return 'error'
  } finally {
    limiter.leave(agentId)
  }
}
