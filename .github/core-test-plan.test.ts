import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { coreTestPlan, parseCoreTestArgs, selectCoreTests, selectSubprocessLane } from '../scripts/run-core-tests'

const repoRoot = resolve(import.meta.dir, '..')
const coreRoot = resolve(repoRoot, 'apps/core')
const plan = coreTestPlan()
const sharedFile = plan.shared[0]!
const isolatedFile = './src/services/machines/cli-bundle.test.ts'

test('Core lanes are disjoint and execute the complete discovered inventory exactly once', () => {
  const { shared, isolated, files } = plan
  expect([...shared, ...isolated].sort()).toEqual(files)
  expect(new Set([...shared, ...isolated]).size).toBe(files.length)
  expect(shared.length).toBeGreaterThan(0)
  expect(isolated.length).toBeGreaterThan(0)
  for (const file of shared)
    expect(readFileSync(resolve(import.meta.dir, '../apps/core', file), 'utf8')).not.toMatch(
      /\bmock\s*\.\s*module\s*\(/
    )
  expect(isolated).toContain('./src/services/memory/indexer/EmbeddingService.test.ts')
  expect(isolated).toContain(isolatedFile)
})

test('Desktop BigBrain real MCP sessions run only in the isolated subprocess lane', () => {
  // Spawning is indirect through BigbrainClient, so the source-regex membership
  // gate cannot discover these six Bun-backed MCP sessions automatically.
  const file = './src/services/integrations/bigbrain/desktop-host.test.ts'
  expect(plan.subprocess).toContain(file)
  expect(plan.isolated).toContain(file)
  expect(plan.shared).not.toContain(file)
  expect(selectCoreTests(plan, [file], coreRoot)).toEqual({ shared: [], isolated: [file] })
})

test('native shared BigBrain wire smoke is isolated and required with a built pinned artifact', () => {
  const file = './src/services/integrations/bigbrain/shared-upstream.smoke.test.ts'
  expect(plan.subprocess).toContain(file)
  expect(plan.isolated).toContain(file)
  expect(plan.shared).not.toContain(file)
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  expect(workflow).toContain('Build pinned shared BigBrain fixture')
  expect(workflow).toContain("FICUS_BIGBRAIN_REQUIRE_SHARED_SMOKE: '1'")
  expect(workflow).toContain('FICUS_BIGBRAIN_SHARED_ARTIFACT: ${{ runner.temp }}/bigbrain-shared')
})

test('cross-process VM provision proof runs only in the isolated subprocess lane', () => {
  const file = './src/services/sandbox/vm/provision-flight-process.test.ts'
  expect(plan.subprocess).toContain(file)
  expect(plan.isolated).toContain(file)
  expect(plan.shared).not.toContain(file)
  expect(selectCoreTests(plan, [file], coreRoot)).toEqual({ shared: [], isolated: [file] })
})

test('no arguments keep the full-suite selection and CI options', () => {
  expect(parseCoreTestArgs([])).toEqual({ help: false, paths: [], list: false, reverse: false, subprocessOnly: false })
  expect(parseCoreTestArgs(['--subprocess', '--reverse'])).toMatchObject({ subprocessOnly: true, reverse: true })
  expect(selectCoreTests(plan, [])).toEqual({ shared: plan.shared, isolated: plan.isolated })
})

test('file arguments select only those files, each in its normal lane', () => {
  expect(selectCoreTests(plan, [sharedFile, isolatedFile], coreRoot)).toEqual({
    shared: [sharedFile],
    isolated: [isolatedFile],
  })
  // Repository-root-relative and duplicate paths resolve to the same file.
  expect(selectCoreTests(plan, [`apps/core/${sharedFile.slice(2)}`, sharedFile], coreRoot)).toEqual({
    shared: [sharedFile],
    isolated: [],
  })
  const directory = selectCoreTests(plan, ['src/services/machines'], coreRoot)
  const all = [...directory.shared, ...directory.isolated]
  expect(all.length).toBeGreaterThan(1)
  expect(all.length).toBeLessThan(plan.files.length)
  for (const file of all) expect(file.startsWith('./src/services/machines/')).toBe(true)
  expect(parseCoreTestArgs([sharedFile, '-t', 'creates', '--list'])).toEqual({
    help: false,
    paths: [sharedFile],
    list: true,
    reverse: false,
    subprocessOnly: false,
    testNamePattern: 'creates',
  })
  expect(parseCoreTestArgs([sharedFile, '--test-name-pattern=a=b'])).toMatchObject({ testNamePattern: 'a=b' })
})

test('arguments that cannot be honored fail instead of widening to the full suite', () => {
  expect(() => parseCoreTestArgs(['--bogus'])).toThrow('Unknown option: --bogus')
  expect(() => parseCoreTestArgs([sharedFile, '-x'])).toThrow('Unknown option: -x')
  expect(() => parseCoreTestArgs([sharedFile, '-t'])).toThrow('requires a non-empty pattern')
  expect(() => parseCoreTestArgs(['-t', 'creates'])).toThrow('requires at least one path')
  expect(() => parseCoreTestArgs(['--subprocess', '-t', 'x', sharedFile])).toThrow('cannot be combined with a test')
  expect(() => selectSubprocessLane(plan, [sharedFile], coreRoot)).toThrow('exactly the CI subprocess inventory')
  expect(() => selectSubprocessLane(plan, plan.subprocess.slice(1), coreRoot)).toThrow('exactly the CI subprocess')
  expect(() => selectCoreTests(plan, ['src/does-not-exist.test.ts'], coreRoot)).toThrow('No such file or directory')
  expect(() => selectCoreTests(plan, ['../../package.json'], coreRoot)).toThrow('outside apps/core')
  expect(() => selectCoreTests(plan, ['package.json'], coreRoot)).toThrow('No Core test files match')
  expect(() => selectCoreTests(plan, ['src/types'], coreRoot)).toThrow('No Core test files match')
})

// The CI step passes its lane inventory after --subprocess; that must keep
// running the full isolated lane exactly as before (and never the shared lane).
const ciSubprocessArgs = (() => {
  const workflow = Bun.YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
  }
  const run = workflow.jobs['subprocess-tests']!.steps.find((step) => step.name === 'Run real-subprocess tests')!.run!
  const words = run.trim().split(/\s+/)
  expect(words.slice(0, 2)).toEqual(['bun', '../../scripts/run-core-tests.ts'])
  return words.slice(2)
})()

test('the real CI subprocess command still selects the full isolated lane', () => {
  const options = parseCoreTestArgs(ciSubprocessArgs)
  expect(options).toMatchObject({ help: false, subprocessOnly: true })
  if (options.help) throw new Error('unreachable')
  expect(options.paths.length).toBe(plan.subprocess.length)
  expect(selectSubprocessLane(plan, options.paths, coreRoot)).toEqual({ shared: [], isolated: plan.isolated })
  expect(selectSubprocessLane(plan, [], coreRoot)).toEqual({ shared: [], isolated: plan.isolated })
})

async function runner(...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(repoRoot, 'scripts/run-core-tests.ts'), ...args], {
    cwd: coreRoot,
    env: { ...process.env, FICUS_TEST_SKIP_SUBPROCESS: undefined },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test('the runner entrypoint lists only requested files and rejects bad arguments before running anything', async () => {
  const focused = await runner('--list', sharedFile, isolatedFile)
  expect(focused).toEqual({ exitCode: 0, stdout: `shared   ${sharedFile}\nisolated ${isolatedFile}\n`, stderr: '' })
  const ci = await runner('--list', ...ciSubprocessArgs)
  expect(ci.exitCode).toBe(0)
  expect(ci.stdout).toBe(plan.isolated.map((file) => `isolated ${file}\n`).join(''))
  const full = await runner('--list')
  expect(full.exitCode).toBe(0)
  expect(full.stdout.trim().split('\n')).toHaveLength(plan.files.length)
  for (const bad of [
    ['--bogus'],
    ['src/does-not-exist.test.ts'],
    ['../../package.json'],
    ['--subprocess', sharedFile],
  ]) {
    const result = await runner(...bad)
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('PASS')
  }
  expect((await runner('--help')).stdout).toContain('Usage: bun run test')
})
