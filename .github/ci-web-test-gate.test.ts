import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import {
  discoverTestFiles,
  parseBunTestSummary,
  validateBaselineAndInventory,
  validateFullTestResult,
  type TestBaseline,
} from '../apps/web/scripts/run-full-test-gate'

interface Step {
  name?: string
  run?: string
  if?: unknown
  'continue-on-error'?: unknown
  'working-directory'?: string
  uses?: string
  with?: Record<string, unknown>
}
interface Workflow {
  jobs?: Record<string, { if?: unknown; needs?: string[]; steps?: Step[] }>
}

const repoRoot = join(import.meta.dir, '..')
const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, 'workflows/ci.yml'), 'utf8')) as Workflow
const webManifest = JSON.parse(readFileSync(join(repoRoot, 'apps/web/package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}
const baseline = JSON.parse(readFileSync(join(repoRoot, 'apps/web/test-baseline.json'), 'utf8')) as {
  fileCount: number
  testCount: number
  files: string[]
}
const bunVersion = readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim()
const runnerSource = readFileSync(join(repoRoot, 'apps/web/scripts/run-full-test-gate.ts'), 'utf8')
const orderRunnerSource = readFileSync(join(repoRoot, 'apps/web/scripts/run-dom-order-gate.ts'), 'utf8')
const orderCases = JSON.parse(readFileSync(join(repoRoot, 'apps/web/scripts/dom-order-cases.json'), 'utf8')) as {
  schemaVersion: number
  cases: { name: string; seed: number }[]
}

type SpawnValue = 'owner' | 'spawn' | 'other'
function hasOnlyCanonicalSpawnCalls(source: string): boolean {
  const file = ts.createSourceFile('run-dom-order-gate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const canonicalCalls: string[] = []
  let invalid = false
  const value = (node: ts.Expression | undefined, env: Map<string, SpawnValue>): SpawnValue => {
    if (!node) return 'other'
    if (ts.isParenthesizedExpression(node)) return value(node.expression, env)
    if (ts.isIdentifier(node)) return env.get(node.text) ?? 'other'
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'spawn')
      return value(node.expression, env) === 'owner' ? 'spawn' : 'other'
    if (ts.isElementAccessExpression(node)) {
      const key = ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined
      return key === 'spawn' && value(node.expression, env) === 'owner' ? 'spawn' : 'other'
    }
    return 'other'
  }
  const bind = (name: ts.BindingName, state: SpawnValue, env: Map<string, SpawnValue>) => {
    if (ts.isIdentifier(name)) env.set(name.text, state)
    else
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue
        const key =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined
        bind(element.name, state === 'owner' && key === 'spawn' ? 'spawn' : 'other', env)
      }
  }
  const visit = (node: ts.Node, env: Map<string, SpawnValue>) => {
    if (ts.isFunctionLike(node)) {
      const local = new Map(env)
      const orchestration = ts.isFunctionDeclaration(node) && node.name?.text === 'runDomOrderGate'
      for (const parameter of node.parameters)
        bind(
          parameter.name,
          orchestration && ts.isIdentifier(parameter.name) && parameter.name.text === 'io' ? 'owner' : 'other',
          local
        )
      if (node.body) visit(node.body, local)
      return
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, env)
      bind(node.name, value(node.initializer, env), env)
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      visit(node.right, env)
      const state = value(node.right, env)
      if (ts.isIdentifier(node.left)) env.set(node.left.text, state)
      else if (ts.isObjectLiteralExpression(node.left))
        for (const property of node.left.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
            const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ''
            env.set(property.initializer.text, state === 'owner' && key === 'spawn' ? 'spawn' : 'other')
          } else if (ts.isShorthandPropertyAssignment(property)) {
            env.set(property.name.text, state === 'owner' && property.name.text === 'spawn' ? 'spawn' : 'other')
          }
        }
      else visit(node.left, env)
      return
    }
    if (ts.isCallExpression(node)) {
      if (value(node.expression, env) === 'spawn') {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === 'Bun' || node.expression.expression.text === 'io')
        )
          canonicalCalls.push(node.expression.expression.text)
        else invalid = true
      }
      for (const argument of node.arguments) visit(argument, env)
      return
    }
    ts.forEachChild(node, (child) => visit(child, env))
  }
  visit(file, new Map<string, SpawnValue>([['Bun', 'owner']]))
  return (
    !invalid &&
    canonicalCalls.length === 2 &&
    canonicalCalls.filter((owner) => owner === 'Bun').length === 1 &&
    canonicalCalls.filter((owner) => owner === 'io').length === 1
  )
}

export function validateWebTestGate(
  candidate: Workflow,
  script = webManifest.scripts?.['test:ci'],
  runner = runnerSource,
  orderRunner = orderRunnerSource
): string[] {
  const errors: string[] = []
  const job = candidate.jobs?.['test-web']
  const guardJob = candidate.jobs?.['test-gates']
  const steps = job?.steps ?? []
  // The suite moved into its own `test-web` lane, so "must live in the job named
  // test" is no longer the right invariant -- but the danger it guarded against
  // is: a gate parked in a job nothing requires does not gate anything. Keep it
  // sharp by requiring the owning lane to be one the REQUIRED `test` aggregator
  // depends on, so a future lane cannot quietly escape the merge gate.
  const requiredLanes = new Set(candidate.jobs?.test?.needs ?? [])
  const gatesOutsideLane = Object.entries(candidate.jobs ?? {}).flatMap(([name, value]) =>
    name === 'test-web' ? [] : (value.steps ?? []).filter((step) => step.name === 'Run full web test gate')
  )
  if (gatesOutsideLane.length) errors.push('the web test gate may not run in a separate advisory job')
  if (!requiredLanes.has('test-web')) errors.push('the test-web lane must be required by the `test` aggregator')
  if (job?.if !== undefined) errors.push('the test job must be unconditional')
  const installIndex = steps.findIndex(
    (step) => step.name === 'Install dependencies' && step.run === 'bun install --frozen-lockfile'
  )
  if (installIndex < 0) errors.push('the test job must install dependencies from the frozen lockfile')
  const gates = steps.filter((step) => step.name === 'Run full web test gate')
  if (gates.length !== 1) errors.push('the test job must contain exactly one active web test gate')
  const gate = gates[0]
  if (
    !gate ||
    gate.run !== 'bun run --cwd apps/web test:ci' ||
    gate.if !== undefined ||
    gate['continue-on-error'] !== undefined ||
    steps.indexOf(gate) <= installIndex
  ) {
    errors.push('the web test gate must use the canonical fail-closed command after frozen install')
  }
  // The farm ships inside the web build, so its whole suite runs in this lane, fail closed.
  const farm = steps.filter((step) => step.name === 'Run farm tests')
  if (
    farm.length !== 1 ||
    farm[0]!.run !== 'bun run --cwd apps/farm test' ||
    farm[0]!.if !== undefined ||
    farm[0]!['continue-on-error'] !== undefined ||
    steps.indexOf(farm[0]!) <= installIndex
  )
    errors.push('the test job must run the farm tests fail closed after frozen install')
  // Guard steps were consolidated into `test-gates` when the suites were split.
  const guards = (guardJob?.steps ?? []).filter((step) => step.name === 'Validate CI web test gate')
  if (
    guards.length !== 1 ||
    guards[0]?.run !== 'bun test ./ci-web-test-gate.test.ts' ||
    guards[0]?.['working-directory'] !== '.github' ||
    guards[0]?.if !== undefined ||
    guards[0]?.['continue-on-error'] !== undefined
  )
    errors.push('the workflow must run the web gate guard fail closed')
  const setup = steps.find((step) => step.uses === 'oven-sh/setup-bun@v2')
  if (setup?.with?.['bun-version'] !== bunVersion) errors.push(`the test job must pin Bun ${bunVersion}`)
  const cache = steps.find((step) => step.name === 'Cache Bun dependencies')
  const cachePath = String(cache?.with?.path ?? '')
  const cacheKey = String(cache?.with?.key ?? '')
  if (cachePath.trim() !== '~/.bun/install/cache' || cachePath.includes('node_modules')) {
    errors.push('dependency cache must contain only the Bun download cache')
  }
  if (!cacheKey.includes("hashFiles('bun.lock')") || cacheKey.includes('bun.lockb')) {
    errors.push('dependency cache key must hash bun.lock')
  }
  if (script !== 'bun scripts/run-full-test-gate.ts') errors.push('test:ci must invoke the canonical runner exactly')
  const orderGates = steps.filter((step) => step.name === 'Run web DOM order gate')
  const fullIndex = steps.indexOf(gate!)
  const orderGate = orderGates[0]
  if (
    orderGates.length !== 1 ||
    !orderGate ||
    orderGate.run !== 'bun run --cwd apps/web test:dom-order:ci' ||
    orderGate.if !== undefined ||
    orderGate['continue-on-error'] !== undefined ||
    steps.indexOf(orderGate) !== fullIndex + 1
  )
    errors.push('the DOM order gate must be mandatory and immediately follow the full web gate')
  if (webManifest.scripts?.['test:dom-order:ci'] !== 'bun scripts/run-dom-order-gate.ts')
    errors.push('test:dom-order:ci must invoke the canonical runner exactly')
  if (
    JSON.stringify(orderCases) !==
    JSON.stringify({
      schemaVersion: 1,
      cases: [
        { name: 'copper-otter', seed: 305419896 },
        { name: 'violet-comet', seed: 3735928559 },
      ],
    })
  )
    errors.push('DOM order cases must contain the exact two reviewed seeds in configured order')
  const compactOrderRunner = orderRunner.replace(/\s/g, '')
  const exactArgv = "io.spawn(['bun','test',...order.map((file)=>`./${file}`)],webRoot)"
  const artifactIndex = compactOrderRunner.indexOf('awaitatomicArtifact(')
  const spawnIndex = compactOrderRunner.indexOf(exactArgv)
  if (
    /--(?:bail|randomize|rerun|timeout|concurrency|filter|shard)|Math\.random|retry/.test(orderRunner) ||
    !hasOnlyCanonicalSpawnCalls(orderRunner) ||
    spawnIndex < 0 ||
    artifactIndex < 0 ||
    artifactIndex > spawnIndex ||
    !compactOrderRunner.includes('constselected=seedArg===undefined?cases:') ||
    !compactOrderRunner.includes('for(consttestCaseofselected)')
  )
    errors.push('DOM order runner must use the single exact artifact-before-spawn deterministic orchestration')
  const fullCommands = runner.match(/Bun\.spawn\(\['bun', 'test', '\.\/src'\]/g) ?? []
  if (fullCommands.length !== 1 || /for\s*\([^)]*(?:discovered|files)|--filter|--shard|path-ignore/.test(runner)) {
    errors.push('the runner must spawn exactly one unsharded bun test ./src process')
  }
  if (baseline.fileCount <= 0 || baseline.testCount <= 0 || baseline.fileCount !== baseline.files.length) {
    errors.push('the reviewed test baseline must be nonzero and internally consistent')
  }
  return errors
}

describe('full web test runner summary', () => {
  test('parses Bun 1.3.11 ANSI and CRLF output', () => {
    expect(parseBunTestSummary('\x1b[32m 3 pass\x1b[0m\r\n 0 fail\r\nRan 3 tests across 2 files.\r\n')).toEqual({
      pass: 3,
      fail: 0,
      skip: 0,
      todo: 0,
      tests: 3,
      files: 2,
    })
  })
  test.each([
    ['missing summary', ' 3 pass\n 0 fail\n'],
    ['missing pass aggregate', 'Ran 3 tests across 2 files.\n'],
    ['truncated summary', ' 3 pass\nRan 3 tests across'],
    ['duplicate summary', '3 pass\nRan 3 tests across 2 files.\nRan 3 tests across 2 files.'],
    ['malformed trailing summary', '3 pass\nRan 3 tests across 2 files. trailing'],
    ['conflicting aggregates', '3 pass\n2 pass\nRan 3 tests across 2 files.'],
  ])('rejects %s', (_name, output) => {
    expect(() => parseBunTestSummary(output)).toThrow()
  })
})

describe('CI web test gate', () => {
  test('the canonical web suite discovers the browser import boundary guard', async () => {
    expect(await discoverTestFiles()).toContain('src/no-server-only-imports.test.ts')
  })

  test('uses the exact unconditional full-suite contract', () => {
    expect(validateWebTestGate(workflow)).toEqual([])
  })

  test('requires the farm tests, fail closed', () => {
    const missing = structuredClone(workflow)
    const steps = missing.jobs!['test-web']!.steps!
    steps.splice(
      steps.findIndex((step) => step.name === 'Run farm tests'),
      1
    )
    expect(validateWebTestGate(missing)).toContain(
      'the test job must run the farm tests fail closed after frozen install'
    )
    const swallowed = structuredClone(workflow)
    swallowed.jobs!['test-web']!.steps!.find((step) => step.name === 'Run farm tests')!['continue-on-error'] = true
    expect(validateWebTestGate(swallowed).length).toBeGreaterThan(0)
  })

  test.each([
    ['narrowed command', 'bun test ./src/components'],
    ['filter', 'bun run --cwd apps/web test:ci --filter Chat'],
    ['error swallowing', 'bun run --cwd apps/web test:ci || true'],
    ['similar script', 'bun run --cwd apps/web test'],
  ])('rejects a %s', (_name, run) => {
    const candidate = structuredClone(workflow)
    const gate = candidate.jobs!['test-web']!.steps!.find((step) => step.name === 'Run full web test gate')!
    gate.run = run
    expect(validateWebTestGate(candidate).length).toBeGreaterThan(0)
  })

  test('rejects runtime, lockfile, and module-tree cache drift', () => {
    const candidate = structuredClone(workflow)
    const steps = candidate.jobs!['test-web']!.steps!
    // Drift the pin to a value that can never equal the reviewed .bun-version so
    // the guard is exercised regardless of which Bun the repo currently pins.
    steps.find((step) => step.uses === 'oven-sh/setup-bun@v2')!.with = { 'bun-version': '0.0.0-drift' }
    const cache = steps.find((step) => step.name === 'Cache Bun dependencies')!
    cache.with = { path: '~/.bun/install/cache\nnode_modules', key: "bun-${{ hashFiles('**/bun.lockb') }}" }
    expect(validateWebTestGate(candidate)).toEqual(
      expect.arrayContaining([
        `the test job must pin Bun ${bunVersion}`,
        'dependency cache must contain only the Bun download cache',
        'dependency cache key must hash bun.lock',
      ])
    )
  })

  test.each([
    ['per-file loop', "for (const file of discovered) Bun.spawn(['bun', 'test', file])"],
    ['shard', "Bun.spawn(['bun', 'test', './src', '--shard=1/2'])"],
    ['exclusion', "Bun.spawn(['bun', 'test', './src', '--path-ignore-patterns=slow'])"],
  ])('rejects runner %s', (_name, runner) => {
    expect(validateWebTestGate(workflow, webManifest.scripts?.['test:ci'], runner)).toContain(
      'the runner must spawn exactly one unsharded bun test ./src process'
    )
  })

  test('requires exact two fixed seeds and deterministic runner source', () => {
    expect(orderCases).toEqual({
      schemaVersion: 1,
      cases: [
        { name: 'copper-otter', seed: 305419896 },
        { name: 'violet-comet', seed: 3735928559 },
      ],
    })
    for (const mutation of [
      orderRunnerSource + '\nMath.random()',
      orderRunnerSource.replace("['bun', 'test', ...order.map", "['bun', 'test', '--bail', ...order.map"),
      orderRunnerSource.replace('for (const testCase of selected)', 'for (const testCase of selected.slice(0, 1))'),
      orderRunnerSource.replace('for (const testCase of selected)', 'for (const testCase of [...selected].reverse())'),
      orderRunnerSource.replace('? cases', '? [cases[0]!, cases[0]!]'),
      orderRunnerSource.replace('await atomicArtifact(', 'void atomicArtifact('),
      orderRunnerSource.replace('...order.map((file)', '...discovered.map((file)'),
      orderRunnerSource.replace('const child = io.spawn', 'io.spawn(command, webRoot); const child = io.spawn'),
      orderRunnerSource.replace(
        'const child = io.spawn',
        "const alternateSpawn = io.spawn; alternateSpawn(['bun', 'test'], webRoot); const child = io.spawn"
      ),
      orderRunnerSource.replace(
        'const child = io.spawn',
        "const computedSpawn = io['spawn']; computedSpawn(['bun', 'test'], webRoot); const child = io.spawn"
      ),
      orderRunnerSource.replace(
        'const child = io.spawn',
        "const { spawn: hiddenSpawn } = io; hiddenSpawn(['bun', 'test'], webRoot); const child = io.spawn"
      ),
      orderRunnerSource.replace(
        'const child = io.spawn',
        "const alternateIo = io; const alternateSpawn = alternateIo['spawn']; alternateSpawn(['bun', 'test'], webRoot); const child = io.spawn"
      ),
    ])
      expect(validateWebTestGate(workflow, webManifest.scripts?.['test:ci'], runnerSource, mutation)).toContain(
        'DOM order runner must use the single exact artifact-before-spawn deterministic orchestration'
      )
  })

  test('allows shadowed and invalidated non-spawn values', () => {
    const shadowed = orderRunnerSource + '\nfunction unrelated(io: { spawn(): void }) { io.spawn() }'
    const reassigned = orderRunnerSource.replace(
      'const child = io.spawn',
      'let alternateIo = io; alternateIo = { spawn() {} }; alternateIo.spawn(); const child = io.spawn'
    )
    expect(validateWebTestGate(workflow, webManifest.scripts?.['test:ci'], runnerSource, shadowed)).toEqual([])
    expect(validateWebTestGate(workflow, webManifest.scripts?.['test:ci'], runnerSource, reassigned)).toEqual([])
  })

  test('rejects removed, advisory, misplaced, or altered DOM order invocation', () => {
    for (const mutation of ['removed', 'advisory', 'misplaced', 'altered'] as const) {
      const candidate = structuredClone(workflow)
      const steps = candidate.jobs!['test-web']!.steps!
      const gate = steps.find((x) => x.name === 'Run web DOM order gate')!
      if (mutation === 'removed') steps.splice(steps.indexOf(gate), 1)
      if (mutation === 'advisory') gate['continue-on-error'] = true
      // Move it BEFORE the full web gate. Pushing it to the end used to be a real
      // misplacement in the monolithic job; in the `test-web` lane the DOM gate is
      // already last, so that splice became an identity and the case proved nothing.
      if (mutation === 'misplaced') {
        const webIndex = steps.findIndex((step) => step.name === 'Run full web test gate')
        steps.splice(steps.indexOf(gate), 1)
        steps.splice(webIndex, 0, gate)
      }
      if (mutation === 'altered') gate.run = 'bun test ./src'
      expect(validateWebTestGate(candidate).length).toBeGreaterThan(0)
    }
  })

  test('rejects conditional, advisory, duplicate, and removed gates', () => {
    for (const mutation of ['conditional', 'advisory', 'duplicate', 'removed'] as const) {
      const candidate = structuredClone(workflow)
      const steps = candidate.jobs!['test-web']!.steps!
      const gate = steps.find((step) => step.name === 'Run full web test gate')!
      if (mutation === 'conditional') gate.if = 'false'
      if (mutation === 'advisory') gate['continue-on-error'] = true
      if (mutation === 'duplicate') steps.push({ ...gate })
      if (mutation === 'removed') steps.splice(steps.indexOf(gate), 1)
      expect(validateWebTestGate(candidate).length).toBeGreaterThan(0)
    }
  })
})

describe('full web result validation mutations', () => {
  const contract: TestBaseline = {
    schemaVersion: 1,
    fileCount: 2,
    testCount: 3,
    skipCount: 0,
    files: ['src/a.test.ts', 'src/b.test.ts'],
  }
  const valid = ' 3 pass\n 0 fail\nRan 3 tests across 2 files.'

  test('reports malformed and conflicting terminal summaries exactly', () => {
    expect(() => parseBunTestSummary('3 pass\nRan 3 tests across 2 files. trailing')).toThrow(
      'expected exactly one complete terminal summary, found 0'
    )
    expect(() => parseBunTestSummary('3 pass\n2 pass\nRan 3 tests across 2 files.')).toThrow(
      'found conflicting pass aggregates'
    )
  })

  test('rejects drops below the baseline floors; growth needs no baseline edit', () => {
    // Floors, not pins (2026-08-27): decreases reject, increases pass.
    expect(validateFullTestResult(contract, contract.files, ' 2 pass\nRan 2 tests across 2 files.', 0)).toContain(
      'collected tests fell below the baseline floor (2 < 3); deliberate removals must lower the floor in test-baseline.json'
    )
    expect(validateFullTestResult(contract, contract.files, ' 3 pass\nRan 3 tests across 1 file.', 0)).toContain(
      'collected 1 files but discovered 2 — collection lost files'
    )
    expect(validateFullTestResult({ ...contract, testCount: 2 }, contract.files, valid, 0)).toEqual([])
    expect(validateBaselineAndInventory({ ...contract, testCount: 0 }, contract.files)).toContain(
      'invalid non-positive test baseline'
    )
    expect(validateBaselineAndInventory({ ...contract, fileCount: 1 }, contract.files)).toContain(
      'test baseline file count/list is inconsistent'
    )
  })

  test('rejects fail/skip/todo and exit-code contradictions with exact diagnostics', () => {
    expect(
      validateFullTestResult(contract, contract.files, ' 2 pass\n 1 fail\nRan 3 tests across 2 files.', 0)
    ).toContain('expected 0 failures, received 1')
    expect(validateFullTestResult(contract, contract.files, valid, 1)).toContain('test process exited 1')
    expect(
      validateFullTestResult(contract, contract.files, ' 2 pass\n 1 skip\nRan 3 tests across 2 files.', 0)
    ).toContain('expected 0 skipped tests, received 1')
    expect(
      validateFullTestResult(contract, contract.files, ' 2 pass\n 1 todo\nRan 3 tests across 2 files.', 0)
    ).toContain('expected 0 todo tests, received 1')
  })

  test.each([
    ['missing', ['src/a.test.ts'], 'src/b.test.ts'],
    ['renamed', ['src/a.test.ts', 'src/c.test.ts'], 'src/b.test.ts'],
    ['moved', ['src/a.test.ts', 'src/nested/b.test.ts'], 'src/b.test.ts'],
  ])('rejects a %s inventory (baseline file lost from discovery)', (_name, files, lost) => {
    expect(validateBaselineAndInventory(contract, files)).toEqual([
      `baseline test files missing from discovery: ${lost}`,
    ])
  })

  test('an added test file passes with no baseline edit (floor semantics)', () => {
    expect(validateBaselineAndInventory(contract, [...contract.files, 'src/c.test.ts'])).toEqual([])
  })

  test('discovery rejects zero files and a symlink escape', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'web-gate-empty-'))
    await expect(discoverTestFiles(empty)).rejects.toThrow('test discovery scanned zero files')

    const root = await mkdtemp(join(tmpdir(), 'web-gate-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'web-gate-outside-'))
    await writeFile(join(outside, 'escape.test.ts'), "import { test } from 'bun:test'\n")
    await mkdir(join(root, 'nested'))
    await symlink(join(outside, 'escape.test.ts'), join(root, 'nested/escape.test.ts'))
    await expect(discoverTestFiles(root)).rejects.toThrow('test file escapes source root: nested/escape.test.ts')
  })
})

describe('CI web workflow placement mutations', () => {
  test('rejects a gate moved before frozen install', () => {
    const candidate = structuredClone(workflow)
    const steps = candidate.jobs!['test-web']!.steps!
    const gate = steps.splice(
      steps.findIndex((step) => step.name === 'Run full web test gate'),
      1
    )[0]!
    steps.unshift(gate)
    expect(validateWebTestGate(candidate)).toContain(
      'the web test gate must use the canonical fail-closed command after frozen install'
    )
  })

  test('rejects changed-file/path-filter variants and a separate advisory job', () => {
    const filtered = structuredClone(workflow)
    filtered.jobs!['test-web']!.steps!.find((step) => step.name === 'Run full web test gate')!.run =
      'git diff --quiet apps/web || bun run --cwd apps/web test:ci'
    expect(validateWebTestGate(filtered)).toContain(
      'the web test gate must use the canonical fail-closed command after frozen install'
    )

    const advisory = structuredClone(workflow)
    advisory.jobs!.advisory = {
      steps: [{ name: 'Run full web test gate', run: 'bun run --cwd apps/web test:ci', 'continue-on-error': true }],
    }
    expect(validateWebTestGate(advisory)).toContain('the web test gate may not run in a separate advisory job')
  })
})
