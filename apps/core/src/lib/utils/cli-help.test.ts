import { beforeAll, describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import {
  getCliHostPath,
  getTaskWorkflowCliHelp,
  getSquadWorkerCliHelp,
  getSquadManagerCliHelp,
  clearCliHelpCache,
  getSystemManagerCliHelp,
  warmupCliHelpCaches,
  resetCliHelpCacheForTests,
  setCliPathOverrideForTests,
  filterCliHelpForPermissions,
  CLI_COMMAND_PERMISSIONS,
} from './cli-help'
import { join } from 'path'
import { KNOWN_GRANTABLE_PERMISSIONS } from '@ficus/shared'
import { MONOREPO_ROOT } from '../paths'

// cli-help now relies SOLELY on the built CLI at apps/cli/dist/ficus.js — the
// `bun apps/cli/src/index.ts` source fallback was removed (a shipped artifact
// has no apps/cli/src). CI builds the CLI before running these tests (ci.yml's
// "Build CLI" step precedes apps/core `bun test`); locally, build it here if
// the dist is absent so the suite is self-sufficient either way.
beforeAll(() => {
  if (existsSync(getCliHostPath())) return
  const res = Bun.spawnSync(['bun', 'run', 'build:cli'], { cwd: MONOREPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (res.exitCode !== 0) {
    throw new Error(`failed to build the ficus CLI for cli-help tests: ${new TextDecoder().decode(res.stderr)}`)
  }
})

describe('getSystemManagerCliHelp', () => {
  test('includes agent/squad subcommands', async () => {
    clearCliHelpCache()
    const help = await getSystemManagerCliHelp()
    expect(help).toContain('agent')
    expect(help).toContain('squad')
  })
})

describe('getTaskWorkflowCliHelp', () => {
  test('includes task subcommands', async () => {
    clearCliHelpCache()
    const help = await getTaskWorkflowCliHelp()
    expect(help).toContain('Usage: ficus')
    expect(help).toContain('task')
    expect(help).toContain('schedule')
  })

  test('caches result on subsequent calls', async () => {
    clearCliHelpCache()
    const help1 = await getTaskWorkflowCliHelp()
    const help2 = await getTaskWorkflowCliHelp()
    expect(help1).toBe(help2)
  })
})

describe('getSquadWorkerCliHelp', () => {
  test('includes agent/workstream/squad subcommands', async () => {
    clearCliHelpCache()
    const help = await getSquadWorkerCliHelp()
    expect(help).toContain('agent')
    expect(help).toContain('workstream')
    expect(help).toContain('squad')
  })

  test('does not include task/schedule detailed subcommand help', async () => {
    clearCliHelpCache()
    const help = await getSquadWorkerCliHelp()
    // Top-level `ficus --help` lists all commands (including task, schedule, etc.)
    // but the detailed subcommand help sections should NOT be included
    expect(help).not.toContain('Usage: ficus task')
    expect(help).not.toContain('Usage: ficus schedule')
  })
})

describe('getSquadManagerCliHelp', () => {
  test('includes agent/workstream/squad subcommands', async () => {
    clearCliHelpCache()
    const help = await getSquadManagerCliHelp()
    expect(help).toContain('agent')
    expect(help).toContain('workstream')
    expect(help).toContain('squad')
  })
})

describe('the CLI named in agent prompts', () => {
  test('the help intro names the ficus CLI', async () => {
    clearCliHelpCache()
    const help = await getSquadWorkerCliHelp()
    expect(help.startsWith('You have access to the `ficus` CLI.')).toBe(true)
  })

  test('the CLI-missing error names the ficus CLI and its build', async () => {
    resetCliHelpCacheForTests()
    setCliPathOverrideForTests('/nonexistent/ficus.js')
    try {
      const error = await getSquadManagerCliHelp()
      expect(error).toContain('[ERROR] The ficus CLI is not installed')
      expect(error).toContain('the "ficus" binary is on the PATH')
      expect(error).toContain('You cannot execute any ficus commands')
    } finally {
      setCliPathOverrideForTests(null)
      resetCliHelpCacheForTests()
    }
  })
})

describe('cache never stores the CLI-missing error sentinel', () => {
  test('a transient CLI-missing error is not cached and a later success is served', async () => {
    resetCliHelpCacheForTests()
    setCliPathOverrideForTests('/nonexistent/ficus.js')
    const errorHelp = await getSystemManagerCliHelp()
    expect(errorHelp).toContain('[ERROR]')

    setCliPathOverrideForTests(null)
    const realHelp = await getSystemManagerCliHelp()
    expect(realHelp).not.toContain('[ERROR]')
    expect(realHelp).toContain('Usage: ficus')
  })
})

describe('warmupCliHelpCaches', () => {
  test('populates worker-facing CLI help caches', async () => {
    clearCliHelpCache()

    await warmupCliHelpCaches()

    const [systemManager, squadWorker, squadManager] = await Promise.all([
      getSystemManagerCliHelp(),
      getSquadWorkerCliHelp(),
      getSquadManagerCliHelp(),
    ])
    expect(systemManager).toContain('agent')
    expect(squadWorker).toContain('workstream')
    expect(squadManager).toContain('workstream')
  })
})

describe('filterCliHelpForPermissions', () => {
  /** Permissions of a bundled agent role, read from the same file config sync loads. */
  async function rolePermissions(slug: string): Promise<string[]> {
    const file = await Bun.file(join(MONOREPO_ROOT, 'config/roles/defaults.yaml')).text()
    const { roles } = Bun.YAML.parse(file) as { roles: Array<{ slug: string; permissions: string[] }> }
    return roles.find((role) => role.slug === slug)!.permissions
  }

  /** Command names listed under `Commands:` in the help section for `group` ('' = `ficus --help`). */
  function listedCommands(help: string, group: string): string[] {
    const section = help
      .split('\n\n---\n\n')
      .find((s) => (group ? s.includes(`Usage: ficus ${group}`) : /^Usage: ficus \[options\]/m.test(s)))
    if (!section) return []
    return [...section.split('Commands:')[1]!.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]!.split('|')[0]!)
  }

  test('a squad worker reference drops commands the worker role cannot use', async () => {
    clearCliHelpCache()
    const help = filterCliHelpForPermissions(await getSquadWorkerCliHelp(), await rolePermissions('default-worker'))

    expect(listedCommands(help, 'workstream')).not.toContain('create')
    for (const removed of ['pause', 'cancel', 'add-agent', 'remove-agent', 'delete', 'wait-actor'])
      expect(listedCommands(help, 'workstream')).not.toContain(removed)
    for (const removed of ['spawn', 'unspawn', 'create', 'update', 'set-meta', 'ssh', 'grant'])
      expect(listedCommands(help, 'squad')).not.toContain(removed)
    for (const removed of ['message', 'steer', 'stop', 'delete', 'scope'])
      expect(listedCommands(help, 'agent')).not.toContain(removed)
    expect(listedCommands(help, 'workflow')).not.toContain('create')
    expect(listedCommands(help, 'inbox')).not.toContain('send-system')
    for (const removed of ['agent-type', 'channel', 'shared-prompt', 'squad-env', 'provider-auth', 'user', 'role'])
      expect(listedCommands(help, '')).not.toContain(removed)

    // Commands a worker uses on its own streams stay, including those open to bound workers.
    for (const kept of ['flow', 'advance', 'finish', 'get', 'request-input', 'request-review', 'unblock', 'set-meta'])
      expect(listedCommands(help, 'workstream')).toContain(kept)
    expect(listedCommands(help, 'inbox')).toContain('send')
    expect(listedCommands(help, 'squad')).toContain('workspace')
    for (const kept of ['skill', 'schedule', 'slot', 'deploy', 'workstream', 'inbox'])
      expect(listedCommands(help, '')).toContain(kept)
    expect(help).toContain('Route those requests to your squad manager.')
  })

  test('the squad manager reference stays complete', async () => {
    clearCliHelpCache()
    const help = await getSquadManagerCliHelp()
    expect(listedCommands(help, 'workstream')).toContain('create')
    expect(listedCommands(help, 'squad')).toContain('spawn')
    expect(listedCommands(help, 'workflow')).toContain('create')
    expect(listedCommands(help, '')).toContain('agent-type')
    expect(help).not.toContain('Route those requests to your squad manager.')
  })

  test('a caller holding every permission gets the reference unchanged', async () => {
    clearCliHelpCache()
    const help = await getSquadWorkerCliHelp()
    expect(filterCliHelpForPermissions(help, ['*'])).toBe(help)
  })

  test('every mapped command exists in the generated reference and names a known permission', async () => {
    clearCliHelpCache()
    const help = await getSquadWorkerCliHelp()
    for (const [key, permissions] of Object.entries(CLI_COMMAND_PERMISSIONS)) {
      const [group, command] = key.includes(' ') ? key.split(' ') : ['', key]
      expect({ key, listed: listedCommands(help, group!).includes(command!) }).toEqual({ key, listed: true })
      for (const permission of permissions) expect(KNOWN_GRANTABLE_PERMISSIONS.has(permission)).toBe(true)
    }
  })

  test('drops wrapped description lines with their command and keeps the rest', () => {
    const help = [
      'Usage: ficus workstream|ws [options] [command]',
      '',
      'Commands:',
      '  create|new [options] <title>  Create a work stream using the squad',
      '                                default or an explicit workflow',
      '  get|info <id>                 Get work stream details',
      '',
    ].join('\n')
    expect(filterCliHelpForPermissions(help, ['workstreams:read'])).toBe(
      [
        'Commands that need permissions you do not hold are omitted below. Route those requests to your squad manager.',
        '',
        'Usage: ficus workstream|ws [options] [command]',
        '',
        'Commands:',
        '  get|info <id>                 Get work stream details',
        '',
      ].join('\n')
    )
  })
})
