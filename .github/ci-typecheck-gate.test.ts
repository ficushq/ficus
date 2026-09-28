import { describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Step {
  name?: string
  run?: string
  if?: unknown
  'continue-on-error'?: unknown
  'working-directory'?: string
  env?: Record<string, string>
  uses?: string
  with?: Record<string, unknown>
}

interface Job {
  if?: unknown
  'runs-on'?: string
  env?: Record<string, string>
  steps?: Step[]
}

interface Workflow {
  env?: Record<string, string>
  jobs?: Record<string, Job>
}

interface WorkspaceManifest {
  path: string
  scripts?: Record<string, string>
}

const repoRoot = join(import.meta.dir, '..')
const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, 'workflows/ci.yml'), 'utf8')) as Workflow
const diagnosticsScriptPath = join(import.meta.dir, 'core-typecheck-diagnostics.sh')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
  workspaces?: string[]
}
const workspaceManifests = (packageJson.workspaces ?? [])
  .flatMap((pattern) =>
    [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })].map(
      (path): WorkspaceManifest => ({
        path,
        ...JSON.parse(readFileSync(join(repoRoot, path), 'utf8')),
      })
    )
  )
  .sort((left, right) => left.path.localeCompare(right.path))

function validateTypecheckGate(
  candidate: Workflow,
  scripts: Record<string, string> | undefined = packageJson.scripts,
  manifests: WorkspaceManifest[] = workspaceManifests
): string[] {
  const errors: string[] = []
  const job = candidate.jobs?.['test-typecheck']
  const gates = job?.steps?.filter((step) => step.name === 'Typecheck all packages')

  if (job?.if !== undefined) errors.push('the test job must be unconditional')

  // The guard steps were consolidated into the `test-gates` lane when the suites
  // were split; the steps they guard stayed with their lane.
  const guards = candidate.jobs?.['test-gates']?.steps?.filter((step) => step.name === 'Validate CI typecheck gate')
  if (
    guards?.length !== 1 ||
    guards[0].run !== 'bun test ./ci-typecheck-gate.test.ts' ||
    guards[0]['working-directory'] !== '.github' ||
    guards[0].if !== undefined ||
    guards[0]['continue-on-error'] !== undefined
  ) {
    errors.push('the test job must run the workflow guard fail closed')
  }

  if (gates?.length !== 1) {
    errors.push('the test job must contain exactly one active typecheck gate')
    return errors
  }

  const gate = gates[0]
  if (gate.run !== 'bun run typecheck') {
    errors.push('the typecheck gate must invoke the canonical root command exactly')
  }
  if ([candidate.env, job?.env, gate.env].some((env) => env?.NODE_OPTIONS !== undefined)) {
    errors.push('the typecheck gate must not multiply the raised V8 ceiling across parallel workspaces')
  }
  if (gate.env?.CORE_TYPECHECK_NODE_OPTIONS !== '--max-old-space-size=6144') {
    errors.push('the typecheck gate must provide Core a 6 GiB V8 heap ceiling')
  }
  if (gate.if !== undefined) errors.push('the typecheck gate must be unconditional')
  if (gate['continue-on-error'] !== undefined) {
    errors.push('the typecheck gate must fail closed')
  }
  if (scripts?.typecheck !== "bun run --filter '*' typecheck") {
    errors.push('the root typecheck script must cover every workspace')
  }
  for (const manifest of manifests) {
    if (!manifest.scripts?.typecheck) {
      errors.push(`workspace ${manifest.path} must define a typecheck script`)
    }
  }
  for (const manifest of manifests.filter((manifest) => manifest.path !== 'apps/core/package.json')) {
    if (manifest.scripts?.typecheck?.includes('CORE_TYPECHECK_NODE_OPTIONS')) {
      errors.push(`workspace ${manifest.path} must not consume the Core-only heap variable`)
    }
  }
  const core = manifests.find((manifest) => manifest.path === 'apps/core/package.json')
  if (core?.scripts?.typecheck !== 'NODE_OPTIONS="${CORE_TYPECHECK_NODE_OPTIONS:-${NODE_OPTIONS:-}}" tsc --noEmit') {
    errors.push('Core alone must consume the CI-only raised V8 ceiling')
  }

  return errors
}

describe('CI typecheck gate', () => {
  test('uses the canonical fail-closed root typecheck command', () => {
    expect(validateTypecheckGate(workflow)).toEqual([])
  })

  test.each([
    [
      'shared-only command',
      { run: 'bun run --filter @ficus/shared typecheck' },
      'the typecheck gate must invoke the canonical root command exactly',
    ],
    [
      'similarly named script',
      { run: 'bun run typecheck:ci' },
      'the typecheck gate must invoke the canonical root command exactly',
    ],
    ['conditional gate', { if: 'false' }, 'the typecheck gate must be unconditional'],
    ['advisory gate', { 'continue-on-error': true }, 'the typecheck gate must fail closed'],
    [
      'non-failing wrapper',
      { run: 'bun run typecheck || true' },
      'the typecheck gate must invoke the canonical root command exactly',
    ],
  ])('rejects a %s', (_name, mutation, expectedError) => {
    const candidate = structuredClone(workflow)
    const gate = candidate.jobs?.['test-typecheck']?.steps?.find((step) => step.name === 'Typecheck all packages')
    Object.assign(gate!, mutation)

    expect(validateTypecheckGate(candidate)).toContain(expectedError)
  })

  test('reports runner and cgroup memory context before typechecking', () => {
    const steps = workflow.jobs?.['test-typecheck']?.steps ?? []
    const reportIndex = steps.findIndex((step) => step.name === 'Report typecheck memory context')
    const gateIndex = steps.findIndex((step) => step.name === 'Typecheck all packages')

    expect(reportIndex).toBe(gateIndex - 1)
    expect(steps[reportIndex]?.run).toContain('/proc/meminfo')
    expect(steps[reportIndex]?.run).toContain('/sys/fs/cgroup/memory.max')
    expect(steps[reportIndex]?.run).toContain('cgroup_memory_context=unavailable')
    expect(steps[reportIndex]?.run).toContain('heap_size_limit')
  })

  test('pins the raised V8 heap to Core without multiplying it across parallel workspaces', () => {
    const gate = workflow.jobs?.['test-typecheck']?.steps?.find((step) => step.name === 'Typecheck all packages')
    const core = workspaceManifests.find((manifest) => manifest.path === 'apps/core/package.json')

    expect(gate?.env?.NODE_OPTIONS).toBeUndefined()
    expect(gate?.env?.CORE_TYPECHECK_NODE_OPTIONS).toBe('--max-old-space-size=6144')
    expect(core?.scripts?.typecheck).toBe(
      'NODE_OPTIONS="${CORE_TYPECHECK_NODE_OPTIONS:-${NODE_OPTIONS:-}}" tsc --noEmit'
    )
  })

  test('rejects a missing Core heap ceiling', () => {
    const candidate = structuredClone(workflow)
    const gate = candidate.jobs?.['test-typecheck']?.steps?.find((step) => step.name === 'Typecheck all packages')
    gate!.env = {}

    expect(validateTypecheckGate(candidate)).toContain('the typecheck gate must provide Core a 6 GiB V8 heap ceiling')
  })

  test('rejects a global heap ceiling inherited by parallel workspace typechecks', () => {
    const candidate = structuredClone(workflow)
    const gate = candidate.jobs?.['test-typecheck']?.steps?.find((step) => step.name === 'Typecheck all packages')
    gate!.env = {
      CORE_TYPECHECK_NODE_OPTIONS: '--max-old-space-size=6144',
      NODE_OPTIONS: '--max-old-space-size=6144',
    }

    expect(validateTypecheckGate(candidate)).toContain(
      'the typecheck gate must not multiply the raised V8 ceiling across parallel workspaces'
    )
  })

  test.each([
    ['workflow', (candidate: Workflow) => (candidate.env = { NODE_OPTIONS: '--max-old-space-size=6144' })],
    [
      'test job',
      (candidate: Workflow) => (candidate.jobs!['test-typecheck'].env = { NODE_OPTIONS: '--max-old-space-size=6144' }),
    ],
  ])('rejects a global heap ceiling at %s scope', (_scope, mutate) => {
    const candidate = structuredClone(workflow)
    mutate(candidate)

    expect(validateTypecheckGate(candidate)).toContain(
      'the typecheck gate must not multiply the raised V8 ceiling across parallel workspaces'
    )
  })

  test('rejects a non-Core workspace consuming the Core-only heap variable', () => {
    const manifests = structuredClone(workspaceManifests)
    const nonCore = manifests.find((manifest) => manifest.path !== 'apps/core/package.json')!
    nonCore.scripts!.typecheck = 'NODE_OPTIONS="$CORE_TYPECHECK_NODE_OPTIONS" tsc --noEmit'

    expect(validateTypecheckGate(workflow, packageJson.scripts, manifests)).toContain(
      `workspace ${nonCore.path} must not consume the Core-only heap variable`
    )
  })

  test('rejects a Core script that does not consume the scoped ceiling', () => {
    expect(
      validateTypecheckGate(workflow, packageJson.scripts, [
        ...workspaceManifests.filter((manifest) => manifest.path !== 'apps/core/package.json'),
        { path: 'apps/core/package.json', scripts: { typecheck: 'tsc --noEmit' } },
      ])
    ).toContain('Core alone must consume the CI-only raised V8 ceiling')
  })

  test('measures only revisions in fresh Core history, including an initial commit without a parent', () => {
    const diagnostics = workflow.jobs?.['core-typecheck-diagnostics']
    const measure = diagnostics?.steps?.find((step) => step.name === 'Measure Core typecheck revisions')
    const upload = diagnostics?.steps?.find((step) => step.name === 'Upload Core typecheck diagnostics')
    const fixture = mkdtempSync(join(tmpdir(), 'tau-diagnostic-history-'))
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    const script = readFileSync(diagnosticsScriptPath, 'utf8')
    try {
      git('init', '--quiet')
      git('config', 'user.name', 'Diagnostic fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      const expected: string[] = []
      for (const name of ['initial', 'next']) {
        git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', name)
        const candidateSha = git('rev-parse', 'HEAD')
        expected.push(candidateSha)
        const revisions = Bun.spawnSync({
          cmd: [
            'bash',
            '-c',
            'source "$1"; measure_revision() { echo "$1"; }; run_diagnostics',
            'diagnostic-revisions',
            diagnosticsScriptPath,
          ],
          cwd: fixture,
          env: { ...process.env, GITHUB_SHA: candidateSha },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(revisions.exitCode).toBe(0)
        expect(revisions.stdout.toString().trim().split('\n')).toEqual(expected)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
    expect(diagnostics?.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(diagnostics?.['runs-on']).toBe('ubuntu-24.04')
    expect(measure?.run).toContain('core-typecheck-diagnostics.sh')
    expect(script.match(/NODE_OPTIONS="\$DIAGNOSTIC_NODE_OPTIONS"/g)).toHaveLength(2)
    expect(script).toContain("DIAGNOSTIC_NODE_OPTIONS='--max-old-space-size=6144'")
    expect(upload).toMatchObject({
      if: 'always()',
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'core-typecheck-diagnostics-${{ github.sha }}',
        path: '${{ runner.temp }}/core-typecheck-*.log',
        'if-no-files-found': 'error',
      },
    })
  })

  test('diagnostics continue after a controlled failure and aggregate the failure', () => {
    const probe = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        `source "$1"
measure_revision() {
  echo "visited=$1"
  [[ "$1" != first ]]
}
run_measurements first second third`,
        'diagnostic-probe',
        diagnosticsScriptPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(probe.exitCode).toBe(1)
    expect(probe.stdout.toString().trim().split('\n')).toEqual(['visited=first', 'visited=second', 'visited=third'])
  })

  test('diagnostics reject an empty revision list instead of a false green', () => {
    const probe = Bun.spawnSync(
      [
        'bash',
        '-c',
        'source "$1"; diagnostic_revisions() { :; }; run_diagnostics',
        'empty-revisions',
        diagnosticsScriptPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    expect(probe.exitCode).toBe(65)
    expect(probe.stderr.toString()).toContain('No diagnostic revisions were collected')
  })

  test('diagnostics reject a zero exit with missing required measurements', () => {
    const probe = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        `source "$1"
log=$(mktemp)
export GITHUB_STEP_SUMMARY=$(mktemp)
finish_measurement candidate abc123 0 "$log"`,
        'diagnostic-validation-probe',
        diagnosticsScriptPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(probe.exitCode).toBe(65)
    expect(probe.stdout.toString()).toContain(
      'measurement_validation=failed missing=exact_sha,memory_used,check_time,total_time,max_rss'
    )
  })

  test('diagnostics reject a partial or malformed required measurement', () => {
    const probe = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        `source "$1"
log=$(mktemp)
export GITHUB_STEP_SUMMARY=$(mktemp)
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cat > "$log" <<EOF
=== revision=candidate exact_sha=$sha ===
Memory used: 1234K
Check time: unknown
Total time: 18.33s
 Maximum resident set size (kbytes): 2802840
EOF
finish_measurement candidate "$sha" 0 "$log"`,
        'diagnostic-partial-probe',
        diagnosticsScriptPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(probe.exitCode).toBe(65)
    expect(probe.stdout.toString()).toContain('measurement_validation=failed missing=check_time')
  })

  test('rejects a newly added workspace without a typecheck script', () => {
    const candidate = structuredClone(workflow)

    expect(
      validateTypecheckGate(candidate, packageJson.scripts, [
        ...workspaceManifests,
        { path: 'apps/new-workspace/package.json', scripts: {} },
      ])
    ).toEqual(['workspace apps/new-workspace/package.json must define a typecheck script'])
  })

  test('rejects workspace package-list drift in the root script', () => {
    const candidate = structuredClone(workflow)

    expect(validateTypecheckGate(candidate, { typecheck: 'bun run --filter @ficus/shared typecheck' })).toEqual([
      'the root typecheck script must cover every workspace',
    ])
  })
})
