import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listPeriodicRunnerNames, listPeriodicRunners } from '../../lib/infra/PeriodicRunner'

let dir: string
let originalHomeDir: string | undefined

// getHomeDir() reads process.env.HOME_DIR on every call (no module-level cache),
// so we can override it here regardless of module load order.
beforeEach(() => {
  dir = join(tmpdir(), `ficus-archive-test-${Date.now()}-${Math.floor(performance.now())}`)
  mkdirSync(dir, { recursive: true })
  originalHomeDir = process.env.HOME_DIR
  process.env.HOME_DIR = dir
})

afterEach(async () => {
  await (await mod()).stopAgentPrivateArchiveJanitor()
  if (originalHomeDir === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHomeDir
  rmSync(dir, { recursive: true, force: true })
})

async function mod() {
  return await import('./private-archive')
}

describe('archiveAgentPrivateDir', () => {
  test('moves an existing /private/<id> dir into the archive root', async () => {
    const { archiveAgentPrivateDir, getPrivateArchiveRoot } = await mod()
    const src = join(dir, 'private', 'agent_abc')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'note.txt'), 'hi')

    const dest = archiveAgentPrivateDir('agent_abc', new Date(1_000))

    expect(dest).not.toBeNull()
    expect(existsSync(src)).toBe(false)
    expect(existsSync(join(dest as string, 'note.txt'))).toBe(true)
    expect(readdirSync(getPrivateArchiveRoot())[0]).toBe('agent_abc-1000')
  })

  test('retains terminated private data through its independent archive cutoff', async () => {
    const { archiveAgentPrivateDir, purgeExpiredAgentPrivateArchives } = await mod()
    const archivedAt = new Date('2026-09-02T00:00:00.000Z')
    const src = join(dir, 'private', 'agent_final')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'note.txt'), 'retain me')

    const archived = archiveAgentPrivateDir('agent_final', archivedAt)!
    const cutoff = archivedAt.getTime() + 9 * 24 * 60 * 60 * 1000
    expect(purgeExpiredAgentPrivateArchives(9, new Date(cutoff))).toBe(0)
    expect(existsSync(join(archived, 'note.txt'))).toBe(true)
    expect(purgeExpiredAgentPrivateArchives(9, new Date(cutoff + 1))).toBe(1)
    expect(existsSync(archived)).toBe(false)
  })

  test('is idempotent when final cleanup retries the same archive operation', async () => {
    const { archiveAgentPrivateDir, getPrivateArchiveRoot } = await mod()
    const src = join(dir, 'private', 'agent_retry')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'note.txt'), 'once')
    const when = new Date(2_000)

    expect(archiveAgentPrivateDir('agent_retry', when)).not.toBeNull()
    expect(archiveAgentPrivateDir('agent_retry', when)).toBeNull()
    expect(readdirSync(getPrivateArchiveRoot())).toEqual(['agent_retry-2000'])
  })

  test('returns null when the source dir is missing', async () => {
    const { archiveAgentPrivateDir } = await mod()
    expect(archiveAgentPrivateDir('agent_missing', new Date())).toBeNull()
  })
})

describe('purgeExpiredAgentPrivateArchives', () => {
  test('deletes only entries older than retention and ignores malformed names', async () => {
    const { getPrivateArchiveRoot, purgeExpiredAgentPrivateArchives } = await mod()
    const root = getPrivateArchiveRoot()
    const now = new Date(10 * 24 * 60 * 60 * 1000) // day 10
    const old = 1 * 24 * 60 * 60 * 1000 // day 1 (>7 days old)
    const fresh = 9 * 24 * 60 * 60 * 1000 // day 9 (<7 days old)
    mkdirSync(join(root, `agent_old-${old}`), { recursive: true })
    mkdirSync(join(root, `agent_fresh-${fresh}`), { recursive: true })
    mkdirSync(join(root, 'agent_malformed'), { recursive: true })

    const removed = purgeExpiredAgentPrivateArchives(7, now)

    expect(removed).toBe(1)
    expect(existsSync(join(root, `agent_old-${old}`))).toBe(false)
    expect(existsSync(join(root, `agent_fresh-${fresh}`))).toBe(true)
    expect(existsSync(join(root, 'agent_malformed'))).toBe(true)
  })
})

test('runs lifecycle convergence every minute independently from the daily purge', async () => {
  const { startAgentPrivateArchiveJanitor, stopAgentPrivateArchiveJanitor } = await mod()
  const deps = { lifecycleTask: async () => {}, purgeTask: () => {} }
  startAgentPrivateArchiveJanitor(deps)
  startAgentPrivateArchiveJanitor(deps)

  expect(listPeriodicRunnerNames().filter((name) => name === 'agent-lifecycle-convergence')).toHaveLength(1)
  expect(listPeriodicRunnerNames().filter((name) => name === 'agent-private-archive-janitor')).toHaveLength(1)
  expect(
    listPeriodicRunners().find((runner) => runner.runnerName === 'agent-lifecycle-convergence')?.runnerIntervalMs
  ).toBe(60_000)
  expect(
    listPeriodicRunners().find((runner) => runner.runnerName === 'agent-private-archive-janitor')?.runnerIntervalMs
  ).toBe(24 * 60 * 60 * 1000)

  await stopAgentPrivateArchiveJanitor()
  expect(listPeriodicRunnerNames()).not.toContain('agent-lifecycle-convergence')
  expect(listPeriodicRunnerNames()).not.toContain('agent-private-archive-janitor')
})

test('isolates every convergence sweep and caps archive-bearing work to five', async () => {
  const { runAgentLifecycleConvergenceOnce } = await mod()
  const calls: string[] = []
  const warnings: string[] = []
  await runAgentLifecycleConvergenceOnce({
    legacy: async (options) => {
      calls.push(`legacy:${options.maxCandidates}`)
      throw new Error('legacy failure')
    },
    pending: async () => void calls.push('pending'),
    dormancyCompletion: async () => {
      calls.push('dormancy')
      throw new Error('dormancy failure')
    },
    dormantRetention: async (options) => void calls.push(`retention:${options.maxCandidates}`),
    finalCleanup: async (options) => void calls.push(`cleanup:${options.maxCandidates}:${options.maxWorkItems}`),
    warn: (message) => warnings.push(message),
  })

  expect(calls).toEqual(['legacy:5', 'pending', 'dormancy', 'retention:5', 'cleanup:5:5'])
  expect(warnings).toEqual(['Agent legacy terminated repair sweep failed', 'Agent dormancy completion sweep failed'])
})

test('runArchivePurgeOnce reads retention from settings and purges', async () => {
  const { runArchivePurgeOnce } = await mod()
  let usedDays = -1
  runArchivePurgeOnce({
    getRetentionDays: () => 3,
    purge: (days: number) => {
      usedDays = days
      return 0
    },
  })
  expect(usedDays).toBe(3)
})
