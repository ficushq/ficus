import type { InstanceNames } from './instance'
import type { Runner, RunResult } from './runner'

/** The two app names of one instance — everything pm2 addresses is derived from them. */
export type Pm2Names = Pick<InstanceNames, 'api' | 'worker'>
export type Pm2Action = 'start' | 'stop' | 'restart' | 'delete' | 'save' | 'jlist' | 'logs'

export interface Pm2Process {
  name: string
  status: string
  pid: number
  cwd: string
}

export function pm2Args(action: Pm2Action, names: Pm2Names, extra: string[] = []): string[] {
  const apps = [names.api, names.worker]
  switch (action) {
    case 'start':
      return ['start', 'ecosystem.config.js', '--only', apps.join(','), '--update-env']
    case 'stop':
      return ['stop', ...apps]
    case 'restart':
      return ['restart', ...apps, '--update-env']
    case 'delete':
      return ['delete', ...apps]
    case 'save':
      return ['save']
    case 'jlist':
      return ['jlist']
    case 'logs':
      return ['logs', ...extra]
  }
}

export function parseJlist(stdout: string, names: Pm2Names): Pm2Process[] {
  // pm2 prints `[PM2] …` banner lines before the JSON when it spawns its
  // daemon (first run after boot), so the first `[` is not the array. Try
  // every `[`: the only suffix that parses is the one starting at the real
  // array — a suffix from a banner/nested bracket leaves leading garbage.
  for (let start = stdout.indexOf('['); start !== -1; start = stdout.indexOf('[', start + 1)) {
    let list: unknown
    try {
      list = JSON.parse(stdout.slice(start))
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    return (list as { name?: string; pid?: number; pm2_env?: { status?: string; pm_cwd?: string } }[])
      .filter((p) => p.name === names.api || p.name === names.worker)
      .map((p) => ({
        name: p.name!,
        status: p.pm2_env?.status ?? 'unknown',
        pid: p.pid ?? 0,
        cwd: p.pm2_env?.pm_cwd ?? '',
      }))
  }
  return []
}

/**
 * All pm2 invocations run the ROOT's pm2 (`bunx pm2`) with cwd = root. `env` is laid over this
 * process's environment: pm2 builds a started app's environment from its client's (see
 * `Common.prepareAppConf`: process.env, then the ecosystem's `env`), so a start that must not
 * carry this process's stale values passes them here.
 */
export function runPm2(
  runner: Runner,
  root: string,
  args: string[],
  inherit = false,
  env?: Record<string, string | undefined>
): Promise<RunResult> {
  return runner(['bunx', 'pm2', ...args], { cwd: root, inherit, ...(env ? { env } : {}) })
}
