import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
type Workflow = {
  jobs: Record<string, { steps: { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown }[] }>
}
const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as Workflow

function validate(candidate: Workflow): string[] {
  const errors: string[] = []
  for (const [job, name, command] of [
    ['test-core', 'Run tests', 'bun run test'],
    ['test-gates', 'Run sandbox executor tests', 'bun run test'],
    ['subprocess-tests', 'Run real-subprocess tests', 'bun ../../scripts/run-core-tests.ts --subprocess'],
  ]) {
    const steps = candidate.jobs[job!]!.steps.filter((step) => step.name === name)
    if (
      steps.length !== 1 ||
      !steps[0]!.run?.includes(command!) ||
      steps[0]!.if !== undefined ||
      steps[0]!['continue-on-error'] !== undefined
    )
      errors.push(job!)
  }
  return errors
}

test('every split suite uses completion-checked execution', () => {
  // Platform consumes Core's worktree container. Start and verify it before
  // Bun launches package scripts concurrently, including after a teardown.
  expect(JSON.parse(read('package.json')).scripts.test).toBe("bun run test:db:up && bun run --filter '*' test")
  expect(validate(workflow)).toEqual([])
  for (const name of ['cli']) {
    const manifest = JSON.parse(read(`apps/${name}/package.json`))
    expect(manifest.scripts.test).toContain('scripts/test-runner.ts')
  }
  expect(JSON.parse(read('apps/core/package.json')).scripts.test).toBe('bun ../../scripts/run-core-tests.ts')
  expect(read('scripts/run-core-tests.ts')).toContain("import { discoverTests, runTests } from './test-runner'")
  // The preload's local no-database fallback is for focused `bun test` only.
  expect(read('scripts/run-core-tests.ts')).toContain("process.env.FICUS_TEST_REQUIRE_DB = '1'")
})

test('replacing any guarded lane with bare bun test is red', () => {
  for (const job of ['test-core', 'test-gates', 'subprocess-tests']) {
    const candidate = structuredClone(workflow)
    for (const step of candidate.jobs[job]!.steps) if (step.name?.startsWith('Run ')) step.run = 'bun test'
    expect(validate(candidate)).toContain(job)
  }
})
