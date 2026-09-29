import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTestCompletion, discoverTests, runTests } from '../scripts/test-runner'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const summary = ' 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]\n'

test('completion fails closed for early success, missing files, failed tests, signals and malformed exits', () => {
  expect(() => assertTestCompletion(summary, 0, null, 1)).not.toThrow()
  expect(() => assertTestCompletion('', 0, null, 1)).toThrow('final summary')
  expect(() => assertTestCompletion(summary, 0, null, 2)).toThrow('1 of 2')
  expect(() => assertTestCompletion(summary, 101, null, 1)).toThrow('status 101')
  expect(() => assertTestCompletion(summary, null, 'SIGTERM', 1)).toThrow('SIGTERM')
  expect(() => assertTestCompletion(summary, null, null, 1)).toThrow('status null')
  expect(() => assertTestCompletion(summary.replace('0 fail', '1 fail'), 0, null, 1)).toThrow('zero-failure')
  expect(() => assertTestCompletion(summary + summary, 0, null, 1)).toThrow('final summary')
})

async function fixture(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'ficus-runner-test-'))
  scratch.push(cwd)
  await Bun.write(join(cwd, 'bunfig.toml'), '[test]\ntimeout = 5000\n')
  for (const [name, source] of Object.entries(files)) await Bun.write(join(cwd, name), source)
  return cwd
}

test('real process.exit(0) is red and an ordinary passing child is green', async () => {
  const cwd = await fixture({ 'src/early.test.ts': 'process.exit(0)' })
  await expect(runTests({ cwd, roots: ['src'] })).rejects.toThrow('Test suite failed')
  await Bun.write(
    join(cwd, 'src/early.test.ts'),
    'import { test, expect } from "bun:test"; test("finished", () => expect(1).toBe(1))'
  )
  await runTests({ cwd, roots: ['src'] })
})

test('isolated files cannot contaminate each other in either order', async () => {
  const cwd = await fixture({
    'src/a.test.ts':
      'import { test, expect } from "bun:test"; test("a", () => { expect(globalThis.polluted).toBeUndefined(); globalThis.polluted = true })',
    'src/b.test.ts':
      'import { test, expect } from "bun:test"; test("b", () => { expect(globalThis.polluted).toBeUndefined(); globalThis.polluted = true })',
  })
  // Mutation proof: reverting to one process must detect the contamination.
  await expect(runTests({ cwd, roots: ['src'] })).rejects.toThrow('Test suite failed')
  await runTests({ cwd, roots: ['src'], isolated: true })
  await runTests({ cwd, roots: ['src'], isolated: true, reverse: true })
})

test('discovery is nonempty, unique and covers supported extensions without fixtures or dependencies', async () => {
  const cwd = await fixture({ 'src/a.test.ts': '', 'src/b.spec.tsx': '', 'src/node_modules/hidden.test.ts': '' })
  expect(discoverTests(cwd, ['src', 'src'])).toEqual(['./src/a.test.ts', './src/b.spec.tsx'])
  expect(() => discoverTests(cwd, ['missing'])).toThrow()
})

test('failing runner flushes a large diagnostic log before its caller exits', async () => {
  const cwd = await fixture({
    'src/failure.test.ts':
      'import { test, expect } from "bun:test"; test("diagnostic tail", () => { console.error("x".repeat(2 * 1024 * 1024)); console.error("END_OF_FAILURE_LOG"); expect(true).toBe(false) })',
  })
  const runner = join(import.meta.dir, '../scripts/test-runner.ts')
  const entry = join(cwd, 'run.ts')
  await Bun.write(
    entry,
    `import { runTests } from ${JSON.stringify(runner)}; try { await runTests({ cwd: ${JSON.stringify(cwd)}, roots: ['src'] }) } catch { process.exit(1) }`
  )
  const child = Bun.spawn([process.execPath, entry], { cwd, stdout: 'pipe', stderr: 'pipe' })
  try {
    const [exitCode, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(1)
    expect(stderr.includes('END_OF_FAILURE_LOG')).toBe(true)
    expect(stderr.includes('1 fail')).toBe(true)
    expect(stderr.includes('Ran 1 test across 1 file.')).toBe(true)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})
