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
    // Top-level `tau --help` lists all commands (including task, schedule, etc.)
    // but the detailed subcommand help sections should NOT be included
    expect(help).not.toContain('Usage: tau task')
    expect(help).not.toContain('Usage: tau schedule')
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

describe('cache never stores the CLI-missing error sentinel', () => {
  test('a transient CLI-missing error is not cached and a later success is served', async () => {
    resetCliHelpCacheForTests()
    setCliPathOverrideForTests('/nonexistent/tau.js')
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
