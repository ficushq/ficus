import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'
import { KNOWN_GRANTABLE_PERMISSIONS } from '@ficus/shared'
import {
  CLI_COMMAND_PERMISSIONS,
  getCliCommandIndex,
  getCliHostPath,
  parseCommandGroups,
  renderCliCommandIndex,
  resetCliHelpCacheForTests,
  setCliPathOverrideForTests,
  warmupCliCommandIndex,
} from './cli-help'
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

/** Permissions of a bundled agent role, read from the same file config sync loads. */
async function rolePermissions(slug: string): Promise<string[]> {
  const file = await Bun.file(join(MONOREPO_ROOT, 'config/roles/defaults.yaml')).text()
  const { roles } = Bun.YAML.parse(file) as { roles: Array<{ slug: string; permissions: string[] }> }
  return roles.find((role) => role.slug === slug)!.permissions
}

/** Group names listed as `- name` lines in an index. */
function listedGroups(index: string): string[] {
  return [...index.matchAll(/^- ([\w-]+)/gm)].map((m) => m[1]!)
}

/** Top-level group names from the real `ficus --help`. */
async function cliGroups(): Promise<string[]> {
  const help = await Bun.$`${[getCliHostPath()]} --help`.text()
  return parseCommandGroups(help).map((group) => group.name)
}

describe('getCliCommandIndex', () => {
  test('lists one line per top-level group, then how to get commands and flags', async () => {
    resetCliHelpCacheForTests()
    const index = await getCliCommandIndex()
    expect(index.startsWith('You have access to the `ficus` CLI.')).toBe(true)
    expect(listedGroups(index)).toEqual((await cliGroups()).filter((group) => group !== 'secret'))
    expect(index).toContain('- workstream (ws): Manage work streams')
    expect(index).toContain('`ficus <group> --help`')
    expect(index).toContain('`ficus <group> <command> --help`')
    // The index replaces the per-group help dumps.
    expect(index).not.toContain('Usage: ficus')
    expect(index).not.toContain('Commands:')
    expect(index).not.toMatch(/^- help\b/m)
  })

  test('stays a short index, far below the old 15 to 20 KB help dumps', async () => {
    resetCliHelpCacheForTests()
    expect((await getCliCommandIndex()).length).toBeLessThan(4000)
    expect((await getCliCommandIndex(await rolePermissions('default-worker'))).length).toBeLessThan(4500)
  })

  test('caches a successful read', async () => {
    resetCliHelpCacheForTests()
    await warmupCliCommandIndex()
    setCliPathOverrideForTests('/nonexistent/ficus.js')
    try {
      expect(await getCliCommandIndex()).not.toContain('[ERROR]')
    } finally {
      setCliPathOverrideForTests(null)
      resetCliHelpCacheForTests()
    }
  })

  test('the CLI-missing error directs bounded local recovery, not human-run commands', async () => {
    resetCliHelpCacheForTests()
    setCliPathOverrideForTests('/nonexistent/ficus.js')
    try {
      const error = await getCliCommandIndex()
      expect(error).toContain('[ERROR] The ficus CLI is not installed')
      expect(error).toContain('bounded recovery budget')
      expect(error).not.toContain('ask them to install')
      expect(error).not.toContain('bun run build:cli')
      expect(error).toContain('Inspect and repair your authorized local tooling')
      expect(error).toContain('You cannot execute any ficus commands')
    } finally {
      setCliPathOverrideForTests(null)
      resetCliHelpCacheForTests()
    }
  })

  test('a transient CLI-missing error is not cached and a later success is served', async () => {
    resetCliHelpCacheForTests()
    setCliPathOverrideForTests('/nonexistent/ficus.js')
    expect(await getCliCommandIndex()).toContain('[ERROR]')
    setCliPathOverrideForTests(null)
    const index = await getCliCommandIndex()
    expect(index).not.toContain('[ERROR]')
    expect(index).toContain('- workstream')
  })
})

describe('permission filtering', () => {
  test('a squad worker index drops groups and names commands the worker role cannot use', async () => {
    resetCliHelpCacheForTests()
    const index = await getCliCommandIndex(await rolePermissions('default-worker'))
    const groups = listedGroups(index)

    for (const removed of [
      'agent-type',
      'channel',
      'shared-prompt',
      'voice',
      'squad-env',
      'provider-auth',
      'user',
      'role',
    ])
      expect(groups).not.toContain(removed)
    for (const kept of ['skill', 'schedule', 'slot', 'deploy', 'pr', 'agent-question', 'workstream', 'inbox', 'squad'])
      expect(groups).toContain(kept)

    expect(index).toContain('Route those requests to your squad manager.')
    const withheld = index.slice(index.indexOf('not available to you:'))
    expect(withheld).toMatch(/workstream create, [^;]*\bpause\b[^;]*\bcancel\b[^;]*\badd-agent\b/)
    expect(withheld).toMatch(/squad create, [^;]*\bspawn\b/)
    expect(withheld).toContain('inbox send-system')
    // Commands a worker uses on its own streams are not withheld.
    for (const usable of ['advance', 'finish', 'request-input', 'set-meta', 'resolve-input'])
      expect(withheld).not.toMatch(new RegExp(`workstream [^;]*\\b${usable}\\b`))
  })

  test('the manager role sees every group and no withheld commands', async () => {
    resetCliHelpCacheForTests()
    const index = await getCliCommandIndex(await rolePermissions('default-manager'))
    for (const kept of ['workstream', 'squad', 'workflow', 'agent', 'inbox'])
      expect(listedGroups(index)).toContain(kept)
    expect(index).not.toMatch(/workstream create\b/)
  })

  test('without permissions, or holding every permission, the index is complete and has no omission note', async () => {
    resetCliHelpCacheForTests()
    const index = await getCliCommandIndex()
    expect(await getCliCommandIndex(['*'])).toBe(index)
    expect(listedGroups(index)).toContain('agent-type')
    expect(index).not.toContain('Route those requests to your squad manager.')
  })

  test('every mapped command exists in the CLI and names a known permission', async () => {
    const groups = await cliGroups()
    const keys = Object.keys(CLI_COMMAND_PERMISSIONS)
    const subcommandGroups = [...new Set(keys.filter((key) => key.includes(' ')).map((key) => key.split(' ')[0]!))]
    const commandsByGroup = new Map(
      await Promise.all(
        subcommandGroups.map(
          async (group) =>
            [
              group,
              parseCommandGroups(await Bun.$`${[getCliHostPath()]} ${group} --help`.text()).map((entry) => entry.name),
            ] as const
        )
      )
    )
    for (const [key, permissions] of Object.entries(CLI_COMMAND_PERMISSIONS)) {
      const [group, command] = key.split(' ')
      expect({ key, group: groups.includes(group!) }).toEqual({ key, group: true })
      if (command)
        expect({ key, listed: commandsByGroup.get(group!)!.includes(command) }).toEqual({ key, listed: true })
      for (const permission of permissions) expect(KNOWN_GRANTABLE_PERMISSIONS.has(permission)).toBe(true)
    }
  })
})

describe('parseCommandGroups', () => {
  test('reads names, aliases and wrapped descriptions, and skips help', () => {
    const help = [
      'Usage: ficus [options] [command]',
      '',
      'Options:',
      '  -h, --help                display help for command',
      '',
      'Commands:',
      '  workstream|ws [options]   Manage work',
      '                            streams',
      '  pr [options] <n> <f...>   Pull request helpers',
      '  help [command]            display help for command',
      '',
    ].join('\n')
    expect(parseCommandGroups(help)).toEqual([
      { name: 'workstream', aliases: ['ws'], description: 'Manage work streams' },
      { name: 'pr', aliases: [], description: 'Pull request helpers' },
    ])
  })
})

describe('operator-only groups stay out of every agent index', () => {
  test('the real index omits secret', async () => {
    resetCliHelpCacheForTests()
    for (const permissions of [undefined, await rolePermissions('default-worker')]) {
      const index = await getCliCommandIndex(permissions)
      expect(listedGroups(index)).not.toContain('secret')
      expect(listedGroups(index)).toContain('integration')
    }
  })

  test('broad human permissions do not restore operator groups', () => {
    const index = renderCliCommandIndex(
      [
        { name: 'secret', aliases: [], description: 'Manage secrets' },
        { name: 'integration', aliases: [], description: 'Integrations' },
      ],
      ['*']
    )
    expect(index).not.toContain('secret')
    expect(index).toContain('- integration: Integrations')
    expect(index).not.toContain('Route those requests')
  })
})
