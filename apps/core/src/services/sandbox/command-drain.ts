import { randomUUID } from 'node:crypto'
import type { RestartContext } from '@ficus/shared/restart-context'

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

const restartErrors = new WeakMap<Error, RestartContext>()

export function restartContextForCommandError(error: unknown): RestartContext | undefined {
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    const restart = restartErrors.get(error)
    if (restart) return restart
    seen.add(error)
    error = error.cause
  }
  return undefined
}

/** What an agent sees for a command the restart cut short. */
export function commandCanceledForRestartError(restart: RestartContext, cleanupError?: Error): Error {
  const error = Object.assign(
    new Error(
      `This command was cancelled by a Ficus restart at ${restart.restartedAt}; nothing is wrong with your work or the box. Re-run it when your sandbox is back. ` +
        `It may have partial effects: check the affected state before retrying. [reason: core_restart; restart id: ${restart.restartId}]` +
        (cleanupError
          ? ` Ficus could not confirm it stopped (${cleanupError.message}); check with \`ps\` before retrying.`
          : ''),
      cleanupError ? { cause: cleanupError } : undefined
    ),
    { reason: 'core_restart' as const, restart }
  )
  restartErrors.set(error, restart)
  return error
}

/** Created once at the authoritative shutdown boundary, shared by tools and durable notices. */
export function createRestartContext(): RestartContext {
  return { restartId: randomUUID(), restartedAt: new Date().toISOString() }
}

export interface DrainableCommand {
  /** Owning box; omitted only by callers outside box lifecycle tracking. */
  readonly sandboxId?: string
  /** Settles when the command finishes by itself or after it is canceled. */
  readonly settled: Promise<unknown>
  /** Stop it and fail it with the restart message. */
  cancelForRestart(restart: RestartContext): Promise<void>
}

let draining = false
const running = new Set<DrainableCommand>()

const boxDrains = new Map<string, { restart: RestartContext; holders: number }>()

/** A scoped admission refusal is trusted restart evidence, not a tool failure. */
export function commandRefusedForRestartError(sandboxId?: string): Error {
  const restart = sandboxId ? boxDrains.get(sandboxId)?.restart : undefined
  if (!restart) return new Error(COMMAND_REFUSED_FOR_RESTART)
  const error = new Error(
    `Command not started: Ficus is restarting this box at ${restart.restartedAt}. Nothing ran. ` +
      `Re-run it when your sandbox is back. [reason: core_restart; restart id: ${restart.restartId}]`
  )
  restartErrors.set(error, restart)
  return error
}

export function isCommandDrainActive(sandboxId?: string): boolean {
  return draining || (sandboxId !== undefined && boxDrains.has(sandboxId))
}

/** Cheap non-waking eligibility check; callers still need a final fenced proof. */
export function hasRunningBoxCommands(sandboxId: string): boolean {
  return [...running].some((command) => command.sandboxId === sandboxId)
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
  timeoutMs = COMMAND_DRAIN_TIMEOUT_MS,
  restart = createRestartContext()
): Promise<{ finished: number; canceled: number }> {
  draining = true
  const initial = running.size
  if (initial === 0) return { finished: 0, canceled: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  const allSettled = Promise.allSettled([...running].map((command) => command.settled))
  await Promise.race([allSettled, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
  clearTimeout(timer)
  const remaining = [...running]
  await Promise.allSettled(remaining.map((command) => command.cancelForRestart(restart)))
  return { finished: initial - remaining.length, canceled: remaining.length }
}

export function resetCommandDrainForTests(): void {
  draining = false
  running.clear()
  boxDrains.clear()
}

/**
 * Hold only this box's command admission through a lifecycle operation. Unlike
 * worker shutdown, failed cancellation MUST prevent disconnect/replacement.
 * The caller still owns remote-work proof and the durable setup/generation lease.
 */
export async function withBoxCommandDrain<T>(
  sandboxId: string,
  action: (restart: RestartContext) => Promise<T>,
  timeoutMs = COMMAND_DRAIN_TIMEOUT_MS,
  restart = createRestartContext()
): Promise<T> {
  const gate = boxDrains.get(sandboxId) ?? { restart, holders: 0 }
  gate.holders++
  boxDrains.set(sandboxId, gate)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const commands = [...running].filter((command) => command.sandboxId === sandboxId)
    if (commands.length) {
      await Promise.race([
        Promise.allSettled(commands.map((command) => command.settled)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
      clearTimeout(timer)
      await Promise.all(
        commands.filter((command) => running.has(command)).map((command) => command.cancelForRestart(gate.restart))
      )
    }
    return await action(gate.restart)
  } finally {
    clearTimeout(timer)
    if (--gate.holders === 0) boxDrains.delete(sandboxId)
  }
}

/**
 * Bun-only adoption is opportunistic: never wait for or cancel existing work.
 * Fence admission synchronously BEFORE inspecting tracked work or proving host
 * idleness; remote proof and the durable setup lease remain the caller's duty.
 */
export async function withIdleBoxCommandFence<T>(
  sandboxId: string,
  action: () => Promise<T>,
  defer: () => Promise<T>
): Promise<T> {
  const gate = boxDrains.get(sandboxId) ?? { restart: createRestartContext(), holders: 0 }
  gate.holders++
  boxDrains.set(sandboxId, gate)
  try {
    if (hasRunningBoxCommands(sandboxId)) return await defer()
    return await action()
  } finally {
    if (--gate.holders === 0) boxDrains.delete(sandboxId)
  }
}
