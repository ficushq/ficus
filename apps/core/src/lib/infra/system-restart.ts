import { createLogger } from './logger'
import type { LocalEventHandler } from './local-events'

/**
 * Operator-triggered restart of BOTH Ficus processes.
 *
 * `POST /api/system/restart` runs in the api process, but tau-api and
 * tau-worker are separate units (systemd, pm2, or two k8s pods) with no
 * coupling: the api exiting does nothing to the worker. So the api first
 * signals the worker over the existing loopback event transport
 * (`local-events.ts`, channel below), then exits itself. Each process is then
 * brought back by its own supervisor.
 *
 * Exit code doctrine (PR #1051): both units run `Restart=on-failure` under
 * systemd (scripts/setup/systemd/tau-{api,worker}.service.tmpl), which
 * restarts ONLY on a non-zero exit — a clean exit(0) is treated as an
 * intentional success and the unit stays DOWN. So a RESTART must exit
 * non-zero, while a `systemctl stop` (SIGTERM) keeps exiting 0. K8s
 * (`restartPolicy: Always`) and pm2 restart on any code, so non-zero is
 * correct for every supervisor. The api and worker share this one constant so
 * they cannot drift.
 */
export const RESTART_EXIT_CODE = 1

/** local-events channel the api posts on to ask the worker to restart. */
export const SYSTEM_RESTART_CHANNEL = 'system_restart'

const defaultLog = createLogger('system-restart')

export interface WorkerRestartHandlerOptions {
  /**
   * The worker's graceful shutdown path (abort sessions, requeue owned
   * executions, stop subsystems). Must NOT exit the process itself — the
   * handler owns the exit so it can pick the restart code.
   */
  shutdown: () => Promise<void>
  exit: (code: number) => void
  log?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'>
}

/**
 * Build the worker's listener for `SYSTEM_RESTART_CHANNEL`. On the first
 * message it runs the graceful shutdown and then exits with
 * `RESTART_EXIT_CODE`; later messages (an operator double-clicking, or the api
 * retrying) are ignored while shutdown is in flight, so the requeue sweep
 * never runs twice concurrently. A failing shutdown still exits non-zero — the
 * operator asked for a restart, and a worker that survives its own restart
 * request is worse than one that skipped a best-effort requeue (the
 * abandoned-lease watchdog recovers those rows on the next boot).
 */
export function createWorkerRestartHandler(options: WorkerRestartHandlerOptions): LocalEventHandler {
  const log = options.log ?? defaultLog
  let restarting = false
  return (payload) => {
    if (restarting) {
      log.info('Restart already in progress — ignoring duplicate restart request')
      return
    }
    restarting = true
    log.info(`Restart requested via API — exiting for supervisor restart (${payload})`)
    void (async () => {
      try {
        await options.shutdown()
      } catch (error) {
        log.error('Graceful shutdown failed during API-requested restart; exiting anyway:', error)
      } finally {
        options.exit(RESTART_EXIT_CODE)
      }
    })()
  }
}
