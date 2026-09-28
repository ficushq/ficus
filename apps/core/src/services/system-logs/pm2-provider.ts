import { CommandLogProvider, type SpawnCommand } from './command-provider'
import { clampTailLines, type SystemLogComponent, type SystemLogStreamOptions } from './types'

export interface Pm2LogProviderDependencies {
  spawn?: SpawnCommand
  reportDiagnostic?: (message: string, cause?: unknown) => void
}

export function buildPm2LogsArgs(processName: string, opts: SystemLogStreamOptions): string[] {
  return [
    'pm2',
    'logs',
    processName,
    '--lines',
    String(clampTailLines(opts.tailLines)),
    '--raw',
    ...(opts.follow ? [] : ['--nostream']),
  ]
}

/** Streams logs for a fixed, server-configured PM2 process mapping. */
export class Pm2LogProvider extends CommandLogProvider {
  constructor(
    targets: Record<SystemLogComponent, string> = {
      api: process.env.FICUS_PM2_API_NAME ?? 'tau-api',
      worker: process.env.FICUS_PM2_WORKER_NAME ?? 'tau-worker',
    },
    dependencies: Pm2LogProviderDependencies = {}
  ) {
    super(
      'pm2',
      (component, opts) => ({ component, kind: 'process', argv: buildPm2LogsArgs(targets[component], opts) }),
      dependencies.spawn,
      dependencies.reportDiagnostic,
      'Unable to read configured PM2 logs; check PM2 availability and process names.'
    )
  }
}
