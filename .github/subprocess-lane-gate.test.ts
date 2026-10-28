import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { coreTestPlan, subprocessShardFiles } from '../scripts/run-core-tests'

/**
 * Keeps the `subprocess-tests` lane's membership honest.
 *
 * ci.yml's `test` job runs the whole Core sweep as a single `bun test` over
 * ~762 files on one shared runner, after a monorepo typecheck, a CLI build,
 * the web gate, the mobile suite and the platform suite. A separate
 * `subprocess-tests` job with its own runner and Postgres already exists for
 * the expensive class — tests that spawn a real `bun` subprocess — but its
 * membership was a hand-maintained list. Every NEW such test silently
 * defaulted into the contended job.
 *
 * That drift is the structural defect, not the placement of any one file
 * (docs/history/design/ci-stability-and-flake-eradication.md, B2). This gate is the
 * fix: adding a real-bun-spawning test to apps/core without adding it to the
 * lane fails here, with a message saying exactly what to do.
 *
 * When it first ran, eleven files had already drifted — including three that
 * appear in the failure catalogue by name (`store-hermetic`, `kubeconfig`,
 * `node-conformance-registration`) and one, `cli-help.test.ts`, running a full
 * `bun run build:cli` inside the shared job.
 *
 * Scope: `apps/core` only, which is where the lane lives.
 */

const REPO_ROOT = join(import.meta.dir, '..')
const CORE_SRC = join(REPO_ROOT, 'apps/core/src')
const WORKFLOW = join(REPO_ROOT, '.github/workflows/ci.yml')

/**
 * True when `source` spawns a real `bun` subprocess.
 *
 * Deliberately conservative: it looks for a spawn call whose command mentions
 * `process.execPath`, a literal `bun`, or a conventionally-named executable
 * variable, within a window after the call. A command assembled from an opaque
 * variable can evade it — this catches the shapes the repo actually uses, and
 * a miss means a file is not FORCED into the lane, never that a listed file is
 * silently dropped.
 */
export function spawnsRealBun(source: string): boolean {
  // Capturing a process through the shared ownership helpers is still a real
  // spawn. Otherwise improving diagnostics silently removes lane detection.
  if (/\b(?:spawnFileCapturedChild|runFileCapturedProcess|runCapturedProcess)\s*\(/.test(source)) return true
  const spawnCall = /Bun\.spawn(?:Sync)?\(/g
  for (let match = spawnCall.exec(source); match !== null; match = spawnCall.exec(source)) {
    const window = source.slice(match.index, match.index + 300)
    if (/process\.execPath|executablePath|bunExecutable|bunBin|['"]bun['"]/.test(window)) return true
  }
  return false
}

function testFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...testFilesUnder(full))
    } else if (entry.endsWith('.test.ts')) {
      found.push(full)
    }
  }
  return found
}

/** The `src/…` paths listed in the lane's `bun test` invocation. */
function laneMembers(): string[] {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const step = workflow.indexOf('Run real-subprocess tests')
  expect(step).toBeGreaterThan(-1)
  // The step's `run:` block ends at the next key at its indentation.
  const block = workflow.slice(step, workflow.indexOf('\n        env:', step))
  return [...block.matchAll(/(src\/[\w./-]+\.test\.ts)/g)].map((m) => m[1]!)
}

describe('subprocess-tests lane membership', () => {
  test('every apps/core test that spawns a real bun subprocess is in the lane', () => {
    const lane = new Set(laneMembers())
    const drifted = testFilesUnder(CORE_SRC)
      .filter((file) => spawnsRealBun(readFileSync(file, 'utf8')))
      .map((file) => `src/${file.slice(CORE_SRC.length + 1)}`)
      .filter((rel) => !lane.has(rel))
      .sort()

    expect(
      drifted,
      drifted.length === 0
        ? ''
        : `These apps/core tests spawn a real bun subprocess but run in the contended \`test\` job:\n` +
            drifted.map((f) => `  ${f}`).join('\n') +
            `\n\nAdd each to the "Run real-subprocess tests" step in .github/workflows/ci.yml. ` +
            `If one genuinely belongs in the shared job, say why in this gate rather than deleting the assertion.`
    ).toEqual([])
  })

  test('every file listed in the lane still exists', () => {
    // A rename that misses the workflow leaves `bun test` naming a path that no
    // longer exists — which Bun does not treat as an error, so the test simply
    // stops running and the lane stays green.
    const missing = laneMembers().filter((rel) => {
      try {
        return !statSync(join(REPO_ROOT, 'apps/core', rel)).isFile()
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  test('the lane is not empty and names the job it belongs to', () => {
    // Guards the parser itself: a workflow edit that breaks the extraction
    // would otherwise make both assertions above pass vacuously against [].
    const workflow = readFileSync(WORKFLOW, 'utf8')
    expect(workflow).toContain('subprocess-tests:')
    expect(laneMembers().length).toBeGreaterThanOrEqual(6)
  })
})

describe('spawnsRealBun', () => {
  test('detects the spawn shapes this repo uses', () => {
    for (const helper of ['spawnFileCapturedChild', 'runFileCapturedProcess', 'runCapturedProcess'])
      expect(spawnsRealBun(`${helper}(command, options)`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawn([process.execPath, join(dir, 'index.ts')])`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawnSync(['bun', 'run', 'build:cli'], { cwd: ROOT })`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawnSync(\n  [executablePath, './fixture.ts'],\n  { cwd: repoRoot }\n)`)).toBe(true)
  })

  test('does not flag cheap shell spawns or non-spawning files', () => {
    // These stay in the shared job on purpose — the lane is for real bun
    // subprocesses, not for every child process.
    expect(spawnsRealBun(`Bun.spawnSync(['bash', '-c', 'echo hi'])`)).toBe(false)
    expect(spawnsRealBun(`Bun.spawn(['pkill', '-TERM', 'x'])`)).toBe(false)
    expect(spawnsRealBun(`const x = 'bun is mentioned in a comment'`)).toBe(false)
  })
})

test('two shards preserve the required aggregate and reserve time for deadline diagnostics', () => {
  const { jobs } = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as any
  const shards = jobs['subprocess-shards']
  expect(shards).toBeDefined()
  expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
  expect(shards['runs-on']).toBe('ubuntu-24.04')
  expect(shards['timeout-minutes']).toBe(20)
  expect(shards.steps[0].run).toContain('FICUS_TEST_DEADLINE_MS=$(( (started + 540) * 1000 ))')
  const run = shards.steps.find((step: any) => step.name === 'Run real-subprocess tests')
  expect(run.run).toContain('--subprocess-shard ${{ matrix.shard }}/2')
  expect(run.if).toBeUndefined()
  expect(run['continue-on-error']).toBeUndefined()
  const setup = shards.steps.slice(1, shards.steps.indexOf(run))
  expect(setup.every((step: any) => step['timeout-minutes'] > 0)).toBe(true)
  expect(setup.find((step: any) => step.uses === 'actions/checkout@v7')['timeout-minutes']).toBe(3)
  expect(setup.find((step: any) => step.name === 'Install dependencies')['timeout-minutes']).toBe(4)
  // Hang limits are not the performance budget; even worst-case setup must
  // leave room for expired-deadline inventory reporting before the outer kill.
  expect(setup.reduce((sum: number, step: any) => sum + step['timeout-minutes'], 0)).toBeLessThanOrEqual(
    shards['timeout-minutes'] - 3
  )
  const report = shards.steps.find((step: any) => step.name === 'Report lane wall time')
  expect(report.if).toBe('always()')
  expect(report.run).toContain('elapsed < 600')
  expect(report.run).toContain('UNSTARTED 0.000s')
  expect(report.env.TEST_OUTCOME).toBe('${{ steps.subprocess.outcome }}')
  expect(jobs['subprocess-tests'].needs).toEqual(['subprocess-shards'])
  expect(jobs['subprocess-tests'].if).toBe('always()')
  expect(jobs['subprocess-tests'].steps[0].env.RESULT).toBe('${{ needs.subprocess-shards.result }}')
  expect(jobs['subprocess-tests'].steps[0].run).toContain('test "$RESULT" = success')
})

test('shard union equals the canonical lane plus every automatically isolated mock file', () => {
  const plan = coreTestPlan()
  expect(plan.subprocess.map((file) => file.slice(2)).sort()).toEqual(laneMembers().sort())
  expect(new Set(laneMembers()).size).toBe(laneMembers().length)
  const union = [1, 2].flatMap((shard) => subprocessShardFiles(plan.isolated, shard as 1 | 2))
  expect(union.sort()).toEqual(plan.isolated)
  expect(new Set(union).size).toBe(plan.isolated.length)
})

test('aggregate shell rejects failed, skipped, cancelled and absent shard results', () => {
  const { jobs } = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as any
  const command = jobs['subprocess-tests'].steps[0].run
  for (const result of ['success', 'failure', 'skipped', 'cancelled', '']) {
    const child = Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, RESULT: result } })
    expect(child.exitCode === 0).toBe(result === 'success')
  }
})
