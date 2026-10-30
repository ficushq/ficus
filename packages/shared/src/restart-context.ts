/** Correlation minted by the stopping worker, never inferred from a transport error. */
export interface RestartContext {
  restartId: string
  restartedAt: string
}

export type BashCancelReason = 'tool-abort' | 'worker-stop' | 'transport-loss' | 'core_restart'

export function isRestartContext(value: unknown): value is RestartContext {
  if (!value || typeof value !== 'object') return false
  const context = value as Partial<RestartContext>
  return (
    typeof context.restartId === 'string' &&
    context.restartId.length > 0 &&
    context.restartId.length <= 128 &&
    typeof context.restartedAt === 'string' &&
    Number.isFinite(Date.parse(context.restartedAt))
  )
}

/**
 * The AGENT's copy, prepended to the resumed turn's prompt. The id ties it to
 * the identical id on every command the restart cancelled, so the agent can
 * tell those failures came from the restart, not from its own work.
 */
export function restartResumeNotice(restart: RestartContext): string {
  return `Ficus restarted at ${restart.restartedAt}; any command running then was cancelled by the restart and may have partial effects. This is not an incident: check the affected state and re-run what was interrupted. [restart id: ${restart.restartId}]`
}

// The CHAT copies, for people reading the conversation. `[System]` renders
// them as system rows (prefix stripped, local time on hover). No correlation
// id or raw timestamp: the restart context rides in the message's metadata,
// which is what the resume reads.

/** Posted when a worker stops mid-turn and hands the run off. */
export function restartPauseChatNotice(): string {
  return '[System] Paused for a restart; it will resume automatically.'
}

/** Posted when the run picks up again; the agent gets restartResumeNotice in its prompt. */
export function restartResumeChatNotice(): string {
  return '[System] Resumed after a restart. Commands that were running were cancelled; the agent was told to check them and re-run what was interrupted.'
}

/** Posted when the resumed run itself fails. */
export function restartResumeFailedChatNotice(error: string): string {
  return `[System] Resumed after a restart, but the run could not finish: ${error}`
}
