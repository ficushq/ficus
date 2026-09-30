import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown; 'working-directory'?: string }
type Workflow = { jobs?: Record<string, { if?: unknown; steps?: Step[] }> }

const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, 'workflows/ci.yml'), 'utf8')) as Workflow

function validate(candidate: Workflow): string[] {
  const errors: string[] = []
  const job = candidate.jobs?.['test-gates']
  if (job?.if !== undefined) errors.push('test job must be unconditional')
  const tests = job?.steps?.filter((step) => step.name === 'Run sandbox executor tests') ?? []
  if (
    tests.length !== 1 ||
    tests[0]?.run !== 'bun run test' ||
    tests[0]?.['working-directory'] !== 'packages/sandbox-server' ||
    tests[0]?.if !== undefined ||
    tests[0]?.['continue-on-error'] !== undefined
  )
    errors.push('sandbox executor suite must run unconditionally and fail closed')
  const guards = job?.steps?.filter((step) => step.name === 'Validate sandbox executor CI gate') ?? []
  if (
    guards.length !== 1 ||
    guards[0]?.run !== 'bun test ./ci-sandbox-executor-gate.test.ts' ||
    guards[0]?.['working-directory'] !== '.github' ||
    guards[0]?.if !== undefined ||
    guards[0]?.['continue-on-error'] !== undefined
  )
    errors.push('workflow guard must run unconditionally and fail closed')
  // Typecheck moved to its own lane when the suites were split; this gate still
  // pins the canonical command, just where it now lives.
  const typecheck =
    candidate.jobs?.['test-typecheck']?.steps?.filter((step) => step.name === 'Typecheck all packages') ?? []
  if (typecheck.length !== 1 || typecheck[0]?.run !== 'bun run typecheck')
    errors.push('canonical typecheck gate changed')
  return errors
}

describe('sandbox executor CI gate', () => {
  test('discovers every sandbox file in a fresh completion-checked process', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../packages/sandbox-server/package.json'), 'utf8'))
    expect(manifest.scripts.test).toBe('bun ../../scripts/test-runner.ts --isolated src')
  })

  test('rejects the former shared-process command', () => {
    const candidate = structuredClone(workflow)
    candidate.jobs!['test-gates']!.steps!.find((step) => step.name === 'Run sandbox executor tests')!.run = 'bun test'
    expect(validate(candidate)).toContain('sandbox executor suite must run unconditionally and fail closed')
  })
  test('runs the complete package suite in the unconditional Linux test job', () => {
    expect(validate(workflow)).toEqual([])
  })

  test('rejects conditional or advisory package coverage', () => {
    // Lane-shaped, matching the real workflow: the guard and the package suite
    // live in `test-gates`, typecheck in `test-typecheck`. A single-job fixture
    // would no longer reach the validator's lookups, so the mutation below
    // would assert against an empty job and pass without proving anything.
    const candidate: Workflow = {
      jobs: {
        'test-gates': {
          steps: [
            {
              name: 'Validate sandbox executor CI gate',
              run: 'bun test ./ci-sandbox-executor-gate.test.ts',
              'working-directory': '.github',
            },
            {
              name: 'Run sandbox executor tests',
              run: 'bun run test',
              'working-directory': 'packages/sandbox-server',
              if: 'false',
              'continue-on-error': true,
            },
          ],
        },
        'test-typecheck': {
          steps: [{ name: 'Typecheck all packages', run: 'bun run typecheck' }],
        },
      },
    }
    expect(validate(candidate)).toContain('sandbox executor suite must run unconditionally and fail closed')
  })
})
