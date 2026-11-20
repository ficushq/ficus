import { describe, expect, test } from 'bun:test'
import { builtinModules } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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

  test('Bun runtime process fixtures stay isolated even when their spawn command is opaque', () => {
    const lane = laneMembers()
    for (const file of [
      'src/services/machines/host-bun-preview.test.ts',
      'src/services/machines/installed-machine-bundles.test.ts',
      'src/services/sandbox/box-command-restart.test.ts',
      'src/services/sandbox/vm/manager.test.ts',
    ])
      expect(lane).toContain(file)
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

/**
 * Every repository file `entry` loads through relative imports, plus every
 * import that needs installed packages (anything that is neither relative nor
 * a Node/Bun builtin).
 */
function importClosure(entry: string): { files: string[]; packages: string[] } {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.')) {
        const base = resolve(dirname(file), path)
        const target = [base, `${base}.ts`, join(base, 'index.ts')].find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile()
        )
        if (!target) throw new Error(`${relative(REPO_ROOT, file)} imports unresolvable ${path}`)
        visit(target)
      } else if (!path.startsWith('node:') && !path.startsWith('bun:') && path !== 'bun') {
        if (!builtinModules.includes(path)) packages.add(`${relative(REPO_ROOT, file)}: ${path}`)
      }
    }
  }
  visit(entry)
  return { files: [...files], packages: [...packages] }
}

function workflowStep(job: string, name: string): any {
  const { jobs } = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as any
  const step = jobs[job].steps.find((candidate: any) => candidate.name === name)
  expect(step).toBeDefined()
  return step
}

// The fallback runs when setup failed, possibly before `bun install`. A
// workspace-package import (`@ficus/shared/...`) then fails with "Cannot find
// module" and the summary loses the list of files that never started.
test('setup-failure inventory lists unstarted files without installed dependencies', () => {
  const closure = importClosure(join(REPO_ROOT, 'scripts/run-core-tests.ts'))
  expect(closure.packages).toEqual([])

  const report = workflowStep('subprocess-shards', 'Report lane wall time')
  const plan = coreTestPlan()
  for (const shard of [1, 2] as const) {
    // A checkout with no node_modules anywhere on the resolution path: only
    // the script's import closure is copied; apps/ and the workflow are linked.
    const root = mkdtempSync(join(tmpdir(), 'subprocess-inventory-'))
    try {
      for (const file of closure.files) {
        const target = join(root, relative(REPO_ROOT, file))
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(file, target)
      }
      symlinkSync(join(REPO_ROOT, 'apps'), join(root, 'apps'))
      symlinkSync(join(REPO_ROOT, '.github'), join(root, '.github'))
      expect(existsSync(join(root, 'node_modules'))).toBe(false)

      const summary = join(root, 'summary.md')
      const child = Bun.spawnSync(['bash', '-c', report.run.replaceAll('${{ matrix.shard }}', String(shard))], {
        cwd: root,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          TEST_OUTCOME: 'skipped',
          FICUS_TEST_LANE_STARTED: String(Math.floor(Date.now() / 1000)),
          GITHUB_STEP_SUMMARY: summary,
        },
      })
      const stderr = child.stderr.toString()
      expect(stderr).not.toContain('Cannot find module')
      expect(child.exitCode).toBe(0)
      const unstarted = child.stdout
        .toString()
        .split('\n')
        .filter((line) => line.startsWith('UNSTARTED 0.000s '))
        .map((line) => line.slice('UNSTARTED 0.000s '.length))
      expect(unstarted.length).toBeGreaterThan(0)
      expect(unstarted).toEqual(subprocessShardFiles(plan.isolated, shard))
      expect(readFileSync(summary, 'utf8')).toContain(`UNSTARTED 0.000s ${unstarted[0]}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 30000) // Discovers and reads the full Core test inventory once per shard.

describe('subprocess lane PostgreSQL pull retry', () => {
  /** Runs the step with stub `docker`, `timeout` and `sleep`; pulls fail `failures` times. */
  function startPostgres(failures: number) {
    const step = workflowStep('subprocess-shards', 'Start PostgreSQL')
    const dir = mkdtempSync(join(tmpdir(), 'subprocess-postgres-'))
    try {
      const bin = join(dir, 'bin')
      const calls = join(dir, 'calls')
      const count = join(dir, 'pulls')
      mkdirSync(bin)
      writeFileSync(count, '0')
      const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
        chmodSync(join(bin, name), 0o755)
      }
      stub('sleep', 'exit 0')
      stub('timeout', `echo "timeout $*" >> '${calls}'; shift 2; exec "$@"`)
      stub(
        'docker',
        [
          `echo "docker $*" >> '${calls}'`,
          'if [ "$1" = pull ]; then',
          `  n=$(( $(cat '${count}') + 1 )); echo "$n" > '${count}'`,
          `  (( n > ${failures} ))`,
          'fi',
        ].join('\n')
      )
      const child = Bun.spawnSync(['bash', '-e', '-c', step.run], {
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      })
      return {
        step,
        exitCode: child.exitCode,
        output: child.stdout.toString(),
        calls: readFileSync(calls, 'utf8').trim().split('\n'),
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('retries a failed or stalled pull and starts the container from the pulled image', () => {
    const result = startPostgres(2)
    expect(result.exitCode).toBe(0)
    expect(result.step['timeout-minutes']).toBe(3)
    const pulls = result.calls.filter((call) => call.startsWith('docker pull'))
    expect(pulls).toEqual(Array(3).fill('docker pull --quiet paradedb/paradedb:latest'))
    // Each attempt is bounded well inside the step limit.
    expect(result.calls.filter((call) => call.startsWith('timeout'))).toEqual(
      Array(3).fill('timeout --kill-after=5s 50s docker pull --quiet paradedb/paradedb:latest')
    )
    expect(result.output.match(/::warning::/g)).toHaveLength(2)
    const run = result.calls.at(-1)!
    expect(run).toStartWith('docker run -d --name postgres-test')
    expect(run).toEndWith(' paradedb/paradedb:latest')
  })

  test('fails after three attempts without starting a container', () => {
    const result = startPostgres(3)
    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter((call) => call.startsWith('docker pull'))).toHaveLength(3)
    expect(result.calls.some((call) => call.startsWith('docker run'))).toBe(false)
    expect(result.output).toContain('::error::docker pull paradedb/paradedb:latest failed or stalled on all 3 attempts')
  })

  test('the subprocess lane runs the same PostgreSQL image as the test-core job', () => {
    const test = workflowStep('test-core', 'Start PostgreSQL')
    const lane = workflowStep('subprocess-shards', 'Start PostgreSQL')
    const image = (run: string) => run.match(/paradedb\/paradedb\S*/)![0]
    expect(image(lane.run)).toBe(image(test.run))
  })
})
