import type { DeploymentFlavor, ProcessSupervisor } from './deployment-flavor'
import type { PlannedCommand, UpdateTask } from './types'
import { localProcessNames } from '@ficus/shared'
import { hostSystemdUnits, launchdLabel } from '@ficus/shared/node'
import { DEPENDENCY_INSTALL_COMMAND, DEPENDENCY_PATHS } from './dependency-install'

type PathMatcher = {
  exact?: string[]
  prefixes?: string[]
}

type TaskDefinition = {
  task: UpdateTask
  paths: PathMatcher
  commands: string[][]
  note?: (changedFiles: string[]) => string | undefined
}

/**
 * Declarative flavor-aware update plan derived from docs/history/design/tau-auto-updater.md.
 * Commands remain hardcoded source constants and are never loaded from git/user metadata;
 * the deployment flavor only selects among them (which restart commands, whether the
 * k3d sandbox task applies).
 */
const TASK_DEFINITIONS: readonly TaskDefinition[] = [
  {
    task: 'install',
    paths: dependencyPaths(),
    commands: [[...DEPENDENCY_INSTALL_COMMAND]],
  },
  {
    task: 'cli',
    paths: combinePaths(dependencyPaths(), sharedPaths(), { prefixes: ['apps/cli/'] }),
    commands: [['bun', 'run', 'build:cli']],
  },
  {
    task: 'sandbox',
    paths: combinePaths(dependencyPaths(), sharedPaths(), { prefixes: ['packages/k8s-sandbox/'] }),
    commands: [['bun', 'run', 'k3d:import']],
  },
  {
    task: 'core',
    paths: combinePaths(dependencyPaths(), sharedPaths(), {
      exact: ['Dockerfile'],
      prefixes: ['apps/core/', 'apps/cli/', 'packages/k8s-sandbox/', 'config/'],
    }),
    commands: [['bun', 'run', 'build:core']],
  },
  {
    task: 'web',
    // build:web also builds the farm into apps/web/dist/farm, which bundles the Ficus mark from brand/.
    paths: combinePaths(dependencyPaths(), sharedPaths(), clientPaths(), {
      prefixes: ['apps/web/', 'apps/farm/', 'brand/'],
    }),
    commands: [['bun', 'run', 'build:web']],
  },
] as const

function dependencyPaths(): PathMatcher {
  return { exact: [...DEPENDENCY_PATHS.exact], prefixes: [...DEPENDENCY_PATHS.prefixes] }
}

function sharedPaths(): PathMatcher {
  return { prefixes: ['packages/shared/'] }
}

function clientPaths(): PathMatcher {
  return { prefixes: ['packages/client-core/', 'packages/client-react/'] }
}

function combinePaths(...matchers: PathMatcher[]): PathMatcher {
  return {
    exact: matchers.flatMap((matcher) => matcher.exact ?? []),
    prefixes: matchers.flatMap((matcher) => matcher.prefixes ?? []),
  }
}

function matchesPath(path: string, matcher: PathMatcher): boolean {
  return (matcher.exact ?? []).includes(path) || (matcher.prefixes ?? []).some((prefix) => path.startsWith(prefix))
}

function matchesAny(paths: string[], matcher: PathMatcher): boolean {
  return paths.some((path) => matchesPath(path, matcher))
}

export function detectUpdateTasks(changedFiles: string[], flavor: DeploymentFlavor): UpdateTask[] {
  return TASK_DEFINITIONS.filter((definition) => matchesAny(changedFiles, definition.paths))
    .map((definition) => definition.task)
    .filter((task) => task !== 'sandbox' || flavor.sandboxRuntime === 'k3d-local')
}

/**
 * Restart commands per supervisor — hardcoded constants; the flavor only
 * selects among them. Worker first, API last (the API is the current
 * process). systemd installs run as a service user, so non-root uses
 * `sudo -n`; the setup toolkit's docs cover the required NOPASSWD rule.
 */
export function restartCommandsFor(
  supervisor: ProcessSupervisor,
  options: {
    isRoot?: boolean
    instance?: string
    uid?: number
    /** Injectable for tests; production reads the real /etc/systemd/system. */
    unitDir?: string
    /** Injectable for tests; production reads the real ~/Library/LaunchAgents. */
    launchAgentsDir?: string
  } = {}
): string[][] {
  const isRoot = options.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0)
  if (supervisor === 'pm2') {
    return [
      ['bun', 'run', 'reload:worker'],
      ['bun', 'run', 'reload:api'],
    ]
  }
  if (supervisor === 'systemd') {
    const prefix = isRoot ? [] : ['sudo', '-n']
    const units = hostSystemdUnits({ unitDir: options.unitDir })
    return [
      [...prefix, 'systemctl', 'restart', units.worker],
      [...prefix, 'systemctl', 'restart', units.api],
    ]
  }
  const names = localProcessNames(options.instance ?? process.env.FICUS_INSTANCE ?? 'tau')
  if (supervisor === 'systemd-user') {
    return [
      ['systemctl', '--user', 'restart', `${names.worker}.service`],
      ['systemctl', '--user', '--no-block', 'restart', `${names.api}.service`],
    ]
  }
  if (supervisor === 'launchd') {
    const uid = options.uid ?? process.getuid?.()
    if (uid === undefined) throw new Error('launchd updates require a numeric user id')
    return [
      [
        'launchctl',
        'kickstart',
        '-k',
        `gui/${uid}/${launchdLabel(names.worker, { launchAgentsDir: options.launchAgentsDir })}`,
      ],
      [
        'launchctl',
        'kickstart',
        '-k',
        `gui/${uid}/${launchdLabel(names.api, { launchAgentsDir: options.launchAgentsDir })}`,
      ],
    ]
  }
  return []
}

/**
 * True when this planned command restarts the API process (the process running the
 * updater). Both pm2's `reload:api` wrapper and systemd's `systemctl restart tau-api`
 * (optionally prefixed with `sudo -n`) restart the same process, so command-runner's
 * fire-and-forget dispatch and local-updater's boot-time reconciliation both key off
 * this single predicate.
 */
export function isApiRestartCommand(command: string[]): boolean {
  const joined = command.join(' ')
  return (
    joined.includes('reload:api') ||
    joined.includes('reload:core') ||
    // Phase-5 dual-reader: the target can still be a legacy tau-* unit until every host moves.
    /(?:^|[./-])(?:tau|ficus)(?:-[a-z0-9-]+)?-api(?:\.service)?$/.test(command.at(-1) ?? '') // ficus-p5-bridge
  )
}

/**
 * True when a planned command restarts EITHER service. The api-only predicate
 * above exists for the "this restarts the process I am running in" question;
 * this one answers "does this plan hand the units back to systemd/pm2", which
 * is what the pre-restart environment check has to gate on — a worker-only
 * restart into an unusable configuration is just as fatal.
 */
export function isServiceRestartCommand(command: string[]): boolean {
  const joined = command.join(' ')
  const target = command.at(-1) ?? ''
  return (
    isApiRestartCommand(command) ||
    joined.includes('reload:worker') ||
    /(?:^|[./-])(?:tau|ficus)(?:-[a-z0-9-]+)?-worker(?:\.service)?$/.test(target) // ficus-p5-bridge
  )
}

export function commandsForTasks(
  tasks: UpdateTask[],
  changedFiles: string[],
  flavor: DeploymentFlavor
): PlannedCommand[] {
  const requested = new Set(tasks)
  const commands = TASK_DEFINITIONS.filter((definition) => requested.has(definition.task)).flatMap((definition) => {
    const planned = definition.commands.map((command) => ({
      task: definition.task,
      command,
      status: 'pending' as const,
      note: definition.note?.(changedFiles),
    }))
    if (definition.task === 'core') {
      planned.push(
        ...restartCommandsFor(flavor.supervisor).map((command) => ({
          task: definition.task,
          command,
          status: 'pending' as const,
          note: undefined,
        }))
      )
    }
    return planned
  })

  return commands.sort((a, b) => reloadCommandOrder(a.command) - reloadCommandOrder(b.command))
}

function reloadCommandOrder(command: string[]): number {
  if (!isServiceRestartCommand(command)) return 0
  return isApiRestartCommand(command) ? 2 : 1
}
