import {
  PeriodicRunner as SharedPeriodicRunner,
  createPeriodicRunner as sharedCreatePeriodicRunner,
  listPeriodicRunnerNames as sharedListPeriodicRunnerNames,
  listPeriodicRunners as sharedListPeriodicRunners,
  stopAllPeriodicRunners as sharedStopAllPeriodicRunners,
  type PeriodicRunnerOptions as SharedPeriodicRunnerOptions,
} from '@ficus/shared'
import { createLogger } from './logger'

const log = createLogger('periodic')

export type PeriodicRunnerOptions = SharedPeriodicRunnerOptions

/**
 * Core-local base class binding the shared PeriodicRunner to core's own
 * structured logger, so subclasses (and the createPeriodicRunner factory
 * below) keep logging through core's logger without every call site having
 * to pass `logger` explicitly.
 */
export abstract class PeriodicRunner extends SharedPeriodicRunner {
  constructor(options: PeriodicRunnerOptions) {
    super({ logger: log, ...options })
  }
}

/** Factory for simple one-off periodic tasks (no subclassing needed) */
export function createPeriodicRunner(options: PeriodicRunnerOptions & { task: () => Promise<void> }): PeriodicRunner {
  return sharedCreatePeriodicRunner({ logger: log, ...options }) as PeriodicRunner
}

/** Names of all currently-started runners — for diagnostics and tests. */
export const listPeriodicRunnerNames = sharedListPeriodicRunnerNames

/** Every currently-started runner — for diagnostics and interval assertions. */
export const listPeriodicRunners = sharedListPeriodicRunners

/**
 * Stop every started periodic runner. Catch-all for graceful shutdown —
 * runner stop() is idempotent, so services that stop explicitly (to clear
 * their own module state) are unaffected by the second stop.
 */
export const stopAllPeriodicRunners = sharedStopAllPeriodicRunners
