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

export function restartResumeNotice(restart: RestartContext): string {
  return `Ficus restarted at ${restart.restartedAt}; any command running then was cancelled by the restart and may have partial effects. This is not an incident: check the affected state and re-run what was interrupted. [restart id: ${restart.restartId}]`
}

export function restartPauseNotice(restart: RestartContext): string {
  return `[System] Agent paused for a worker restart; it will resume automatically. [restart id: ${restart.restartId}; time: ${restart.restartedAt}]`
}
