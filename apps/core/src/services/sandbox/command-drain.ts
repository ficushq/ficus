/**
 * Draining sandbox commands before the worker exits. A deploy or restart used to
 * kill every running agent command mid-flight: the agent later saw a lost
 * connection and had to guess what happened. On shutdown the worker now stops
 * starting new turns, refuses new commands, gives running commands a short
 * window to finish, then cancels the rest with a message that says why.
 */

/** How long running commands get to finish before the worker cancels them. */
export const COMMAND_DRAIN_TIMEOUT_MS = 10_000

const RESTART = 'the Ficus worker is restarting (a deploy or restart)'

/** What an agent sees for a command it tried to start while the worker was stopping. */
export const COMMAND_REFUSED_FOR_RESTART =
  `Command not started: ${RESTART}. Nothing ran. Try it again; ` + 'your work resumes automatically after the restart.'

/** What an agent sees for a command the restart cut short. */
export function commandCanceledForRestartError(cleanupError?: Error): Error {
  return new Error(
    cleanupError
      ? `Command canceled: ${RESTART}. Ficus could not confirm it stopped (${cleanupError.message}), so check ` +
          'with `ps` and the state it affects before running it again.'
      : `Command canceled: ${RESTART}. It was stopped before it finished, so its changes may be partly ` +
          'applied: check the state it affects, then run it again.',
    cleanupError ? { cause: cleanupError } : undefined
  )
}

export interface DrainableCommand {
  /** Settles when the command finishes by itself or after it is canceled. */
  readonly settled: Promise<unknown>
  /** Stop it and fail it with the restart message. */
  cancelForRestart(): Promise<void>
}

let draining = false
const running = new Set<DrainableCommand>()

export function isCommandDrainActive(): boolean {
  return draining
}

/** Track a running command until it settles, so a drain can wait for it or cancel it. */
export function trackCommand(command: DrainableCommand): void {
  running.add(command)
  void command.settled.then(
    () => running.delete(command),
    () => running.delete(command)
  )
}

/**
 * Refuse new commands, wait up to `timeoutMs` for running ones to finish, then cancel the rest.
 * Returns how many finished on their own and how many were canceled.
 */
export async function drainCommands(
  timeoutMs = COMMAND_DRAIN_TIMEOUT_MS
): Promise<{ finished: number; canceled: number }> {
  draining = true
  const initial = running.size
  if (initial === 0) return { finished: 0, canceled: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  const allSettled = Promise.allSettled([...running].map((command) => command.settled))
  await Promise.race([allSettled, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
  clearTimeout(timer)
  const remaining = [...running]
  await Promise.allSettled(remaining.map((command) => command.cancelForRestart()))
  return { finished: initial - remaining.length, canceled: remaining.length }
}

export function resetCommandDrainForTests(): void {
  draining = false
  running.clear()
}
