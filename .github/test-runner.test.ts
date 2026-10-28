import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  expect(() => assertTestCompletion(summary, null, 15, 1)).toThrow('15')
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

test('extra bun test arguments reach every batch, such as a test name pattern', async () => {
  const cwd = await fixture({
    'src/a.test.ts':
      'import { test, expect } from "bun:test"; test("wanted", () => expect(1).toBe(1)); test("other", () => expect(1).toBe(2))',
  })
  await expect(runTests({ cwd, roots: ['src'] })).rejects.toThrow('Test suite failed')
  await runTests({ cwd, roots: ['src'], args: ['--test-name-pattern=wanted'] })
  await runTests({ cwd, roots: ['src'], isolated: true, args: ['--test-name-pattern=wanted'] })
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

test('cancellation escalates a TERM-resistant test child and returns without a survivor', async () => {
  const cwd = await fixture({
    'src/hung.test.ts':
      'import {test} from "bun:test"; import {writeFileSync} from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync("ready", String(process.pid)); test("hung", async () => { await Bun.sleep(60000) }, 65000)',
  })
  const runner = join(import.meta.dir, '../scripts/test-runner.ts')
  const entry = join(cwd, 'run.ts')
  await Bun.write(
    entry,
    `import {runTests} from ${JSON.stringify(runner)}; try { await runTests({cwd:${JSON.stringify(cwd)}, roots:['src'], stopGraceMs:100}) } catch { process.exitCode=1 }`
  )
  const child = Bun.spawn([process.execPath, entry], { cwd, stdout: 'pipe', stderr: 'pipe' })
  let pid: number | undefined
  try {
    for (let i = 0; i < 100; i++) {
      if (await Bun.file(join(cwd, 'ready')).exists()) {
        pid = Number(await Bun.file(join(cwd, 'ready')).text())
        break
      }
      await Bun.sleep(20)
    }
    expect(pid).toBeDefined()
    child.kill('SIGTERM')
    const result = await Promise.race([child.exited, Bun.sleep(2000).then(() => 'timeout')])
    expect(result).toBe(1)
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The test child may already have exited after escalation.
      }
    }
    child.kill('SIGKILL')
    await child.exited
  }
})

async function budgetRun(files: Record<string, string>, budgetMs: number) {
  const cwd = await fixture(files)
  const entry = join(cwd, 'run.ts')
  const report = join(cwd, 'summary.md')
  await Bun.write(
    entry,
    `import {runTests} from ${JSON.stringify(join(import.meta.dir, '../scripts/test-runner.ts'))};
try { await runTests({cwd:${JSON.stringify(cwd)},roots:['src'],isolated:true,deadline:Date.now()+${budgetMs},stopGraceMs:100}) }
catch { process.exitCode=1 }`
  )
  const child = Bun.spawn([process.execPath, entry], {
    cwd,
    env: { ...process.env, GITHUB_STEP_SUMMARY: report },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return {
      cwd,
      exit,
      stdout,
      stderr,
      summary: (await Bun.file(report).exists()) ? await Bun.file(report).text() : '',
    }
  } finally {
    child.kill('SIGKILL')
    await child.exited
  }
}

test('deadline stops a TERM-resistant child, reports incomplete and unstarted files, and fails', async () => {
  const result = await budgetRun(
    {
      'src/a.test.ts':
        'import {test} from "bun:test"; import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync("pid",String(process.pid)); test("hung",()=>Bun.sleep(2000),3000)',
      'src/b.test.ts': 'throw new Error("must not start")',
    },
    300
  )
  expect(result.exit).toBe(1)
  expect(result.stdout).toContain('Lane deadline exceeded')
  expect(result.stdout).toMatch(/INCOMPLETE\s+\d+\.\d+s\s+\.\/src\/a.test.ts/)
  expect(result.stdout).toContain('UNSTARTED 0.000s ./src/b.test.ts')
  expect(result.summary).toContain('INCOMPLETE')
  expect(() => process.kill(Number(readFileSync(join(result.cwd, 'pid'), 'utf8')), 0)).toThrow()
}, 5000)

test('an expired deadline starts no files and still reports the complete inventory', async () => {
  const result = await budgetRun({ 'src/a.test.ts': 'throw new Error("must not start")' }, -1)
  expect(result.exit).toBe(1)
  expect(result.stdout).toContain('UNSTARTED 0.000s ./src/a.test.ts')
  expect(result.stdout).toContain('Lane deadline exceeded')
})

test('timings are real per-file durations sorted slowest first and include failed files', async () => {
  const result = await budgetRun(
    {
      'src/a.test.ts': 'import {test} from "bun:test"; test("fast",()=>{})',
      'src/b.test.ts':
        'import {test,expect} from "bun:test"; test("slow failure",async()=>{await Bun.sleep(100);expect(1).toBe(2)})',
      'src/c.test.ts': 'throw new Error("must not start")',
    },
    3000
  )
  expect(result.exit).toBe(1)
  const rows = result.stdout.split('\n').filter((line) => /^(PASSED|FAILED|UNSTARTED) \d/.test(line))
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^FAILED .*b.test.ts$/)
  expect(rows[1]).toMatch(/^PASSED .*a.test.ts$/)
  expect(rows[2]).toMatch(/^UNSTARTED .*c.test.ts$/)
  expect(result.summary).toContain('Per-file timing')
})

test('invalid deadlines fail closed', async () => {
  const cwd = await fixture({ 'src/a.test.ts': '' })
  for (const deadline of [NaN, Infinity, 0])
    await expect(runTests({ cwd, roots: ['src'], deadline })).rejects.toThrow('Deadline')
})

test('deadline gives the child time to clean up, but graceful termination cannot turn it green', async () => {
  const result = await budgetRun(
    {
      'src/a.test.ts':
        'import {test} from "bun:test"; import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{writeFileSync("cleaned","yes");process.exit(0)}); test("hung",()=>Bun.sleep(2000),3000)',
    },
    300
  )
  expect(result.exit).toBe(1)
  expect(result.stdout).toContain('Lane deadline exceeded')
  expect(result.stdout).toContain('INCOMPLETE')
  expect(readFileSync(join(result.cwd, 'cleaned'), 'utf8')).toBe('yes')
})

test('passing files also emit a complete timing summary', async () => {
  const result = await budgetRun({ 'src/a.test.ts': 'import {test} from "bun:test"; test("pass",()=>{})' }, 3000)
  expect(result.exit).toBe(0)
  expect(result.stdout).toContain('Test suite passed')
  expect(result.summary).toMatch(/PASSED \d+\.\d+s \.\/src\/a.test.ts/)
})
