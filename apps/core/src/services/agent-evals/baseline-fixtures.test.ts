import { expect, test } from 'bun:test'
import { findScenario } from './scenarios'
import { FIXTURE_HEAD as HEAD, FIXTURE_WORKTREE as TREE } from './fixtures'
import { variantContext, workingTreeVariant } from './variant'

const context = variantContext(workingTreeVariant())
function responder(name: string) {
  const scenario = findScenario(name)!
  const respond = scenario.createResponder?.() ?? scenario.respond!
  return (command: string) => respond({ name: 'squad_bash', args: { command }, command }, context)
}

for (const name of ['readable-handoff', 'ci-failure-rework']) {
  test(`${name} verifies the claimed assembler commit and discovers its files`, async () => {
    const respond = responder(name)
    const log = await respond(`cd ${TREE} && git log --oneline -3`)
    expect(log).toContain('prompt')
    expect(log).not.toContain('Retry slot grants')
    for (const query of [
      'git show --stat HEAD',
      'git ls-files',
      "find . -name 'squad-agent-prompt*'",
      'ls apps/core/src/lib/prompts',
    ]) {
      expect(await respond(`cd ${TREE} && ${query}`)).toContain('squad-agent-prompt')
    }
    expect(await respond(`cd ${TREE} && git rev-parse HEAD`)).toContain(HEAD)
    expect(await respond(`cd ${TREE} && cat apps/core/src/lib/prompts/squad-agent-prompt.ts`)).toContain(
      'assembleSquadWorkerPrompt'
    )
    expect(
      await respond(`cd ${TREE} && git show deadbeef:apps/core/src/lib/prompts/squad-agent-prompt.ts`)
    ).not.toContain('assembleSquadWorkerPrompt')
    expect(await respond(`cd ${TREE} && cat missing.ts`)).not.toContain('assembleSquadWorkerPrompt')
    expect(await respond('cd /missing && git show --stat HEAD')).toBeUndefined()
  })
}

test('CI fixture exposes the actual memory regression before rework and preserves tracked attempt state', async () => {
  const respond = responder('ci-failure-rework')
  expect(await respond(`cd ${TREE} && grep -rn 'Memory System' apps/core/src/lib/prompts`)).toContain('Memory System')
  const before = JSON.parse((await respond('ficus workstream flow 1300'))!)
  expect(before.state.attempts[0].status).toBe('completed')
  await respond(
    `ficus workstream advance 1300 --content '{"expectedVersion":7,"attemptId":1,"action":"rework","feedback":"The current head fails core-unit."}'`
  )
  const after = JSON.parse((await respond('ficus workstream flow 1300'))!)
  expect(after.state.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['completed', 'running'])
  expect(JSON.parse((await responder('ci-failure-rework')('ficus workstream flow 1300'))!).state.status).toBe(
    'completion-ready'
  )
})

test('requester setup discovery is complete without manufacturing creation on help or unknown commands', async () => {
  const respond = responder('requester-identity')
  expect(await respond('ficus workflow get reviewed-coding')).toContain('reviewed-coding')
  expect(await respond('ficus squad get 4ea8b934-a90a-42d1-b6fe-483a2ab9a18b --json')).toContain('reviewed-coding')
  expect(await respond(`git -C ${TREE} remote -v`)).toContain('ficushq/ficus')
  expect(await respond(`git -C ${TREE} symbolic-ref refs/remotes/origin/HEAD`)).toContain('origin/main')
  expect(await respond('ficus workstream create --help')).toBeUndefined()
  expect(await respond('echo "ficus workstream create fake"')).toBeUndefined()
  expect(await respond('ficus workflow get nonexistent')).toBeUndefined()
})

test('requester creation, reviewer updates and lookups use one isolated, identified stream', async () => {
  const respond = responder('requester-identity')
  expect(await respond('ficus workstream get 1301 --json')).toContain('not found')
  const created = JSON.parse(
    (await respond('ficus workstream create "Fix flaky test" --reviewer 51846fad-3980-4ec3-943c-1ebe9c822b2e'))!
  )
  expect(created.number).toBe(1301)
  expect(created.assignedReviewerIds).toEqual(['51846fad-3980-4ec3-943c-1ebe9c822b2e'])
  expect(JSON.parse((await respond(`ficus workstream get ${created.id} --json`))!)).toEqual(created)
  expect(await respond('ficus workstream get 9999 --json')).toContain('not found')
  expect(await responder('requester-identity')('ficus workstream get 1301 --json')).toContain('not found')
})

test('missing or mismatched declared artifacts remain genuine negative verification cases', async () => {
  const { fixtureDiscovery } = await import('./fixtures')
  const { assemblerRepository } = await import('./repository-fixtures')
  const missing = { ...assemblerRepository(), files: {} }
  expect(fixtureDiscovery(`cd ${TREE} && cat apps/core/src/lib/prompts/squad-agent-prompt.ts`, missing)).toContain(
    'No such file'
  )
  expect(fixtureDiscovery(`cd ${TREE} && git ls-files`, missing)).toBe('')
  const mismatch = { ...assemblerRepository(), head: 'deadbeef00000000000000000000000000000000' }
  expect(fixtureDiscovery(`cd ${TREE} && git rev-parse HEAD`, mismatch)).toBe(mismatch.head)
  expect(
    fixtureDiscovery(`cd ${TREE} && git show ${HEAD}:apps/core/src/lib/prompts/squad-agent-prompt.ts`, mismatch)
  ).toContain('invalid object name')
  const refused = {
    ended: true,
    steps: [{ text: 'The claimed artifact is missing. I cannot verify the handoff.', calls: [] }],
  }
  expect(findScenario('readable-handoff')!.grade(refused).pass).toBe(false)
})

test('the declared source reproduces the CI regression but preserves memory in the handoff artifact', async () => {
  const { assemblerRepository } = await import('./repository-fixtures')
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const sourcePath = 'apps/core/src/lib/prompts/squad-agent-prompt.ts'
  for (const regression of [false, true]) {
    const source = assemblerRepository(regression).files[sourcePath]!
    const javascript = transpiler.transformSync(source).replace(/export /g, '')
    const result = new Function(`${javascript}; return assembleSquadWorkerPrompt({ memory: { map: undefined } });`)()
    expect(result.includes('## Memory System')).toBe(!regression)
  }
})
