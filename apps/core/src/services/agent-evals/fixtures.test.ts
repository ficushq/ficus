import { expect, test } from 'bun:test'
import { fixtureDiscovery, fixtureRepositorySettings, isFixturePrInspection } from './fixtures'

const tree = '/home/box_e49af02f8b45/workspace/worktrees/3f6c2d1e-8a4b-4c7d-9e2f-1a2b3c4d5e6f'

test('known worktree discovery stays truthful for individual and combined read-only calls', () => {
  expect(fixtureDiscovery(`cd ${tree} && pwd && ls -la && git log --oneline -3 && git rev-parse HEAD`)).toContain(
    '4f1c2ab9'
  )
  expect(fixtureDiscovery(`cd ${tree} && pwd && ls -la && git log --oneline -3`)).toContain(tree)
  expect(fixtureDiscovery(`ls ${tree}/apps/core/src/services/slots`)).toContain('host-budget.test.ts')
  expect(fixtureDiscovery('ls /home/box_e49af02f8b45/workspace/worktrees')).toContain('3f6c2d1e')
  expect(fixtureDiscovery(`find ${tree} -name 'host-budget*'`)).toContain('host-budget.test.ts')
})

test('unknown paths and unrelated commands do not get invented successful discovery', () => {
  for (const command of [
    'ls /missing',
    'cat /secret',
    'git clone evil',
    'echo unknown',
    'pwd /missing',
    `cd ${tree} && ls /missing`,
    `ls ${tree}/unknown`,
  ])
    expect(fixtureDiscovery(command)).toBeUndefined()
})

test('repository settings are not pull request JSON', () => {
  expect(JSON.parse(fixtureRepositorySettings('gh repo view ficushq/ficus --json squashMergeAllowed')!)).toMatchObject({
    squashMergeAllowed: true,
    viewerDefaultMergeMethod: 'SQUASH',
  })
  expect(JSON.parse(fixtureRepositorySettings('gh api repos/ficushq/ficus')!)).toMatchObject({
    allow_squash_merge: true,
    allow_merge_commit: false,
  })
  expect(fixtureRepositorySettings('gh api repos/ficushq/ficus/branches/main/protection')).toContain('core-unit')
  expect(fixtureRepositorySettings('gh api repos/another/repository')).toBeUndefined()
  expect(fixtureRepositorySettings('gh api repos/ficushq/ficus/pulls/950')).toBeUndefined()
  expect(isFixturePrInspection('gh api repos/ficushq/ficus/pulls/950/reviews')).toBe(true)
  expect(isFixturePrInspection('gh api repos/ficushq/ficus')).toBe(false)
  expect(isFixturePrInspection('gh api repos/another/repository/pulls/950')).toBe(false)
})
