import { instanceNames, type InstanceIdentity } from './instance'
import { parseJlist, pm2Args, runPm2 } from './pm2'
import type { Runner } from './runner'
import type { LocalSupervisor } from './types'

export interface SupervisorContext {
  supervisor: LocalSupervisor
  root: string
  label: string
  /** Which names the instance runs under (its registry entry's identity); unset means the ficus names. */
  identity?: InstanceIdentity
  home: string
  bunPath: string
  pathEnv: string
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  uid: number
  username: string
  xdgConfigHome?: string
  runner: Runner
  which(command: string): string | null
  log(line: string): void
}

export interface SupervisorProcess {
  name: string
  status: string
  pid: number
  cwd: string
}

export interface SupervisorLogsOptions {
  component: 'api' | 'worker' | 'all'
  lines: number
  follow: boolean
}

export interface SupervisorAdapter {
  start(context: SupervisorContext): Promise<void>
  stop(context: SupervisorContext): Promise<void>
  restart(context: SupervisorContext): Promise<void>
  status(context: SupervisorContext): Promise<SupervisorProcess[]>
  logs(context: SupervisorContext, options: SupervisorLogsOptions): Promise<void>
  uninstall(context: SupervisorContext): Promise<void>
}

function requireSuccess(code: number, operation: string): void {
  if (code !== 0) throw new Error(`${operation} failed (exit ${code})`)
}

/** The names of the instance a context addresses, in the era its registry entry says. */
export function contextNames(context: Pick<SupervisorContext, 'label' | 'identity'>) {
  return instanceNames(context.label, context.identity)
}

export const pm2Supervisor: SupervisorAdapter = {
  async start(context) {
    const names = contextNames(context)
    const result = await runPm2(context.runner, context.root, pm2Args('start', names), true)
    requireSuccess(result.code, 'pm2 start')
  },
  async stop(context) {
    const result = await runPm2(context.runner, context.root, pm2Args('stop', contextNames(context)), true)
    requireSuccess(result.code, 'pm2 stop')
  },
  async restart(context) {
    const names = contextNames(context)
    for (const name of [names.worker, names.api]) {
      const result = await runPm2(context.runner, context.root, ['restart', name, '--update-env'], true)
      requireSuccess(result.code, `pm2 restart ${name}`)
    }
  },
  async status(context) {
    const names = contextNames(context)
    const result = await runPm2(context.runner, context.root, pm2Args('jlist', names))
    requireSuccess(result.code, 'pm2 status')
    return parseJlist(result.stdout, names)
  },
  async logs(context, options) {
    const names = contextNames(context)
    const selected = options.component === 'all' ? [names.api, names.worker] : [names[options.component]]
    const extra = [...selected, '--lines', String(options.lines), ...(options.follow ? [] : ['--nostream'])]
    const result = await runPm2(context.runner, context.root, pm2Args('logs', names, extra), true)
    requireSuccess(result.code, 'pm2 logs')
  },
  async uninstall(context) {
    const names = contextNames(context)
    let result = await runPm2(context.runner, context.root, pm2Args('delete', names), true)
    requireSuccess(result.code, 'pm2 delete')
    result = await runPm2(context.runner, context.root, pm2Args('save', names), true)
    requireSuccess(result.code, 'pm2 save')
  },
}

import { launchdSupervisor } from './launchd'
import { systemdUserSupervisor } from './systemd-user'

export function supervisorAdapter(supervisor: LocalSupervisor): SupervisorAdapter {
  switch (supervisor) {
    case 'pm2':
      return pm2Supervisor
    case 'launchd':
      return launchdSupervisor
    case 'systemd-user':
      return systemdUserSupervisor
  }
}

export const startSupervisor = (context: SupervisorContext) => supervisorAdapter(context.supervisor).start(context)
export const stopSupervisor = (context: SupervisorContext) => supervisorAdapter(context.supervisor).stop(context)
export const restartSupervisor = (context: SupervisorContext) => supervisorAdapter(context.supervisor).restart(context)
export const statusSupervisor = (context: SupervisorContext) => supervisorAdapter(context.supervisor).status(context)
export const logsSupervisor = (context: SupervisorContext, options: SupervisorLogsOptions) =>
  supervisorAdapter(context.supervisor).logs(context, options)
export const uninstallSupervisor = (context: SupervisorContext) =>
  supervisorAdapter(context.supervisor).uninstall(context)

import { homedir, userInfo } from 'os'

export function makeSupervisorContext(options: {
  supervisor: LocalSupervisor
  root: string
  label: string
  identity?: InstanceIdentity
  runner: Runner
  log(line: string): void
  env?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  uid?: number
  username?: string
  bunPath?: string
  which?(command: string): string | null
}): SupervisorContext {
  const env = options.env ?? process.env
  const which = options.which ?? ((command: string) => Bun.which(command))
  return {
    supervisor: options.supervisor,
    root: options.root,
    label: options.label,
    identity: options.identity,
    home: options.home ?? env.HOME ?? homedir(),
    bunPath: options.bunPath ?? which('bun') ?? process.execPath,
    pathEnv: env.PATH ?? '',
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    uid: options.uid ?? process.getuid?.() ?? 0,
    username: options.username ?? env.USER ?? userInfo().username,
    xdgConfigHome: env.XDG_CONFIG_HOME,
    runner: options.runner,
    which,
    log: options.log,
  }
}
