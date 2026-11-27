/**
 * The rendered-check mapping and runner. CI runs this from .github (test / gates):
 *   cd .github && bun test ../apps/web/scripts/rendered-checks.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  RENDERED_CHECKS,
  RUN_ALL_PATTERNS,
  coverageByCheck,
  planShards,
  selectChecks,
  webRoot,
} from './rendered-checks'
import { parseArguments, runCheck, runChecks, summary } from './run-rendered-checks'

const scriptsDir = resolve(webRoot, 'scripts')
const everyScript = RENDERED_CHECKS.map((check) => check.script)
const coverage = await coverageByCheck()

describe('mapping', () => {
  test('every check-*.ts in apps/web/scripts is mapped exactly once, and nothing else is', () => {
    const onDisk = readdirSync(scriptsDir)
      .filter((name) => /^check-.*\.ts$/.test(name))
      .sort()
    expect([...everyScript].sort()).toEqual(onDisk)
    expect(new Set(everyScript).size).toBe(everyScript.length)
  })

  test.each(RENDERED_CHECKS.map((check) => [check.script, check] as const))(
    '%s names the fixture its page loads',
    (_, check) => {
      expect(existsSync(resolve(webRoot, check.fixture))).toBe(true)
      const source = readFileSync(resolve(scriptsDir, check.script), 'utf8')
      const loaded = [...new Set(source.match(/scripts\/fixtures\/[\w.-]+\.tsx?/g) ?? [])]
      expect(loaded).toEqual([check.fixture])
      expect(check.seconds).toBeGreaterThan(0)
    }
  )

  test.each(RENDERED_CHECKS.map((check) => [check.script, check] as const))(
    '%s covers the check, its fixture and the components it renders',
    (_, check) => {
      const covered = coverage.get(check.script)!
      expect(covered.has(`apps/web/scripts/${check.script}`)).toBe(true)
      expect(covered.has(`apps/web/${check.fixture}`)).toBe(true)
      // Every fixture renders real components with the real stylesheet.
      expect([...covered].some((path) => /^apps\/web\/src\/.*\.tsx$/.test(path))).toBe(true)
      expect([...covered].some((path) => /^apps\/web\/src\/.*\.css$/.test(path))).toBe(true)
      for (const path of covered) expect(path.startsWith('..') || path.includes('node_modules/')).toBe(false)
    }
  )

  test('the shared fixture server is covered through the import graph or a run-all path', () => {
    for (const check of RENDERED_CHECKS) {
      const source = readFileSync(resolve(scriptsDir, check.script), 'utf8')
      if (source.includes("from './fixture-server'"))
        expect(coverage.get(check.script)!.has('apps/web/scripts/fixture-server.ts')).toBe(true)
    }
    expect(RUN_ALL_PATTERNS).toContain('apps/web/scripts/fixture-server.ts')
  })
})

describe('selection', () => {
  const selected = (...paths: string[]) => selectChecks(paths, coverage).checks

  test('the Farm decision card selects the review brief check', () => {
    expect(selected('apps/farm/src/actions/WorkflowDecision.tsx')).toContain('check-workflow-review-brief.ts')
  })

  test('the review modal selects both review checks', () => {
    const checks = selected('apps/web/src/components/WorkflowReviewModal.tsx')
    expect(checks).toContain('check-workflow-review-brief.ts')
    expect(checks).toContain('check-workflow-review-chat.ts')
  })

  test('workspace package sources count', () => {
    expect(selected('packages/shared/src/workflow-decision-brief.ts')).toContain('check-workflow-review-brief.ts')
  })

  test('a fixture selects the checks that load it, and only those', () => {
    expect(selected('apps/web/scripts/fixtures/work-stream-detail.tsx')).toEqual([
      'check-work-stream-dependencies-layout.ts',
      'check-work-stream-detail-layout.ts',
    ])
    expect(selected('apps/web/scripts/check-spend-layout.ts')).toEqual(['check-spend-layout.ts'])
  })

  test('changes nothing renders select nothing', () => {
    expect(selected('apps/core/src/index.ts', 'docs/wiki/ci-cd.md', 'apps/web/src/api/client.test.ts')).toEqual([])
    expect(selected()).toEqual([])
  })

  test.each(['apps/web/scripts/fixture-server.ts', 'bun.lock', 'apps/core/package.json', '.github/workflows/ci.yml'])(
    '%s runs every check',
    (path) => {
      const selection = selectChecks(['docs/readme.md', path], coverage)
      expect(selection).toEqual({ all: true, reason: path, checks: everyScript })
    }
  )
})

describe('shards', () => {
  test('every selected check lands in exactly one of at most five shards', () => {
    const shards = planShards(everyScript)
    expect(shards.length).toBeGreaterThan(1)
    expect(shards.length).toBeLessThanOrEqual(5)
    expect(shards.flat().sort()).toEqual([...everyScript].sort())
    const seconds = shards.map((shard) =>
      shard.reduce((sum, script) => sum + RENDERED_CHECKS.find((check) => check.script === script)!.seconds, 0)
    )
    // Longest-first onto the lightest shard keeps them within one long check of each other.
    const longest = Math.max(...RENDERED_CHECKS.map((check) => check.seconds))
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThanOrEqual(longest)
  })

  test('a small selection uses one shard and none needs none', () => {
    expect(planShards(['check-spend-layout.ts', 'check-voice-progress.ts'])).toEqual([
      ['check-spend-layout.ts', 'check-voice-progress.ts'],
    ])
    expect(planShards([])).toEqual([])
  })

  test('an unmapped name is refused', () => {
    expect(() => planShards(['check-unknown.ts'])).toThrow('not a rendered check')
  })
})

describe('runner', () => {
  const quiet = { log: () => {} }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test('reports pass and failure by exit code, and keeps going after a failure', async () => {
    const results = await runChecks(['pass', 'fail', 'pass-again'], {
      ...quiet,
      command: (name) => ['bash', '-c', name === 'fail' ? 'exit 3' : 'exit 0'],
    })
    expect(results.map((result) => [result.script, result.status, result.exit])).toEqual([
      ['pass', 'passed', 0],
      ['fail', 'failed', 3],
      ['pass-again', 'passed', 0],
    ])
    expect(summary(results)).toContain('2 of 3 passed')
  })

  test('a check that outlives its timeout fails, and its whole process tree is killed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rendered-checks-'))
    const pidFile = join(dir, 'pid')
    const result = await runCheck('hang', {
      timeoutMs: 1000,
      command: () => ['bash', '-c', `sleep 60 & echo $! > ${pidFile}; wait`],
    })
    expect(result.status).toBe('timed out')
    expect(result.seconds).toBeLessThan(10)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })

  test('a browser left behind by a finished check is killed before the next one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rendered-checks-'))
    const pidFile = join(dir, 'pid')
    const result = await runCheck('leaks', {
      command: () => ['bash', '-c', `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0`],
    })
    expect(result.status).toBe('passed')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })

  test('a command that cannot start fails', async () => {
    const result = await runCheck('missing', { command: () => ['/nonexistent/rendered-check-binary'] })
    expect(result.status).toBe('failed')
  })
})

describe('arguments', () => {
  test('modes', () => {
    expect(parseArguments([])).toEqual({ mode: 'all', list: false, timeoutSeconds: 600 })
    expect(parseArguments(['--changed', 'origin/main', '--list'])).toEqual({
      mode: 'changed',
      base: 'origin/main',
      list: true,
      timeoutSeconds: 600,
    })
    expect(parseArguments(['scripts/check-spend-layout.ts', 'check-squad-cards.ts', '--timeout', '30'])).toEqual({
      mode: 'named',
      scripts: ['check-spend-layout.ts', 'check-squad-cards.ts'],
      list: false,
      timeoutSeconds: 30,
    })
  })

  test('refuses what it cannot honour', () => {
    expect(() => parseArguments(['check-unknown.ts'])).toThrow('not a rendered check')
    expect(() => parseArguments(['--changed'])).toThrow('needs a base ref')
    expect(() => parseArguments(['--timeout', '0'])).toThrow('positive')
    expect(() => parseArguments(['--changed', 'main', 'check-spend-layout.ts'])).toThrow('not both')
    expect(() => parseArguments(['--bogus'])).toThrow('unknown option')
  })
})
