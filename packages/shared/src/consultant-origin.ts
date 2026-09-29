/**
 * Why a consultant agent exists, stamped on `agent.context.origin` when Core
 * creates it:
 * - `user`: someone started the chat (web "New consultant", the farm's seed shed)
 * - `integration`: a squad event rule (`notify-consultant`) started it
 * - `assistant`: the Assistant delegated a task to the squad
 * - `channel`: an external channel thread or DM (Slack, Telegram, Discord, email)
 *
 * Consultants created before origins were stamped have none;
 * `inferredConsultantOrigin` reads the facts those older ones still carry.
 */
export const CONSULTANT_ORIGINS = ['user', 'integration', 'assistant', 'channel'] as const
export type ConsultantOrigin = (typeof CONSULTANT_ORIGINS)[number]

/** The stamped origin of a consultant's context, or null when it has none (or an unknown one). */
export function consultantOrigin(context: unknown): ConsultantOrigin | null {
  if (!context || typeof context !== 'object') return null
  const origin = (context as { origin?: unknown }).origin
  return typeof origin === 'string' && (CONSULTANT_ORIGINS as readonly string[]).includes(origin)
    ? (origin as ConsultantOrigin)
    : null
}

/** The name Core gives the consultant it makes for an Assistant task in a squad. */
export const ASSISTANT_TASK_CONSULTANT_NAME = 'Assistant task'

/** Context keys Core writes when a channel thread or DM starts a consultant. */
const CHANNEL_CONTEXT_KEYS = ['channelInstance', 'thread', 'channelMessages', 'directMessage'] as const

/**
 * Why a consultant exists: its stamped origin, else what an older, unstamped
 * one still shows: channel facts in its context (a channel thread or DM made
 * it) or the Assistant task name. Null when nothing says; treat that as
 * someone having started it.
 */
export function inferredConsultantOrigin(agent: { context?: unknown; metadata?: unknown }): ConsultantOrigin | null {
  const stamped = consultantOrigin(agent.context)
  if (stamped) return stamped
  const context = agent.context && typeof agent.context === 'object' ? (agent.context as Record<string, unknown>) : {}
  if (CHANNEL_CONTEXT_KEYS.some((key) => context[key] != null)) return 'channel'
  const name = agent.metadata && typeof agent.metadata === 'object' ? (agent.metadata as { name?: unknown }).name : null
  if (name === ASSISTANT_TASK_CONSULTANT_NAME) return 'assistant'
  return null
}
