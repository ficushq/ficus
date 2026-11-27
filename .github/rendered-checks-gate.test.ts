import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shardMatrix, validatePlanOutcome } from './rendered-checks-gate'

interface Step {
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  'working-directory'?: string
  'continue-on-error'?: unknown
}
interface Job {
  name?: string
  needs?: string | string[]
  if?: string
  'timeout-minutes'?: number
  'continue-on-error'?: unknown
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> }
  outputs?: Record<string, string>
  steps?: Step[]
}

const workflowText = readFileSync(join(import.meta.dir, 'workflows/ci.yml'), 'utf8')
const workflow = Bun.YAML.parse(workflowText) as { on: Record<string, unknown>; jobs: Record<string, Job> }
const jobs = workflow.jobs

describe('verdict', () => {
  test('passes only a successful plan with nothing to run, or one whose checks all passed', () => {
    expect(validatePlanOutcome('success', 'false', 'skipped')).toEqual({ ok: true })
    expect(validatePlanOutcome('success', 'true', 'success')).toEqual({ ok: true })
  })

  test.each([
    ['success', 'true', 'failure'],
    ['success', 'true', 'cancelled'],
    // Checks were selected but never ran: absence of evidence is not a pass.
    ['success', 'true', 'skipped'],
    ['success', 'false', 'success'],
    ['failure', '', 'skipped'],
    ['cancelled', '', 'skipped'],
    ['success', '', 'skipped'],
    ['', '', ''],
  ])('rejects plan=%p run=%p checks=%p', (plan, run, checks) => {
    expect(validatePlanOutcome(plan, run, checks).ok).toBe(false)
  })
})

test('shards are named for the job list', () => {
  expect(shardMatrix([])).toEqual([])
  expect(shardMatrix(['check-spend-layout.ts', 'check-voice-progress.ts'])).toEqual([
    { name: '1 of 1', checks: 'check-spend-layout.ts check-voice-progress.ts' },
  ])
})

describe('workflow wiring', () => {
  const plan = jobs['rendered-checks-plan']!
  const run = jobs['rendered-checks-run']!
  const verdict = jobs['rendered-checks']!

  test('runs on pull requests and nightly', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request', 'push', 'schedule']))
  })

  test('the plan reads the full history and publishes its selection', () => {
    expect(plan.steps!.find((step) => step.uses === 'actions/checkout@v7')).toMatchObject({
      with: { 'fetch-depth': 0 },
    })
    expect(plan.steps!.some((step) => step.run === 'bun .github/rendered-checks-gate.ts plan')).toBe(true)
    expect(plan.outputs).toEqual({ run: '${{ steps.plan.outputs.run }}', shards: '${{ steps.plan.outputs.shards }}' })
  })

  test('each planned shard runs its checks with Chromium, under a timeout, without hiding failures', () => {
    expect(run.needs).toBe('rendered-checks-plan')
    expect(run.if).toContain("needs.rendered-checks-plan.outputs.run == 'true'")
    expect(run.strategy?.['fail-fast']).toBe(false)
    expect(run.strategy?.matrix?.shard).toBe('${{ fromJSON(needs.rendered-checks-plan.outputs.shards) }}')
    expect(run['timeout-minutes']).toBeGreaterThan(0)
    expect(run['continue-on-error']).toBeUndefined()
    for (const step of run.steps!) expect(step['continue-on-error']).toBeUndefined()
    const names = run.steps!.map((step) => step.name)
    expect(names.indexOf('Install Chromium')).toBeGreaterThan(-1)
    const checks = run.steps!.find((step) => step.name === 'Run rendered checks')!
    expect(names.indexOf('Install Chromium')).toBeLessThan(names.indexOf('Run rendered checks'))
    expect(checks).toMatchObject({
      'working-directory': 'apps/web',
      env: { CHECKS: '${{ matrix.shard.checks }}' },
      run: 'bun scripts/run-rendered-checks.ts $CHECKS',
    })
  })

  test('the verdict always reports and reads both jobs', () => {
    expect(verdict.name).toBe('rendered checks')
    expect(verdict.if).toBe('${{ always() }}')
    expect(verdict.needs).toEqual(['rendered-checks-plan', 'rendered-checks-run'])
    const step = verdict.steps!.find((entry) => entry.run === 'bun .github/rendered-checks-gate.ts verify-result')!
    expect(step.env).toEqual({
      PLAN_RESULT: '${{ needs.rendered-checks-plan.result }}',
      RUN_CHECKS: '${{ needs.rendered-checks-plan.outputs.run }}',
      CHECKS_RESULT: '${{ needs.rendered-checks-run.result }}',
    })
  })

  test('the required `test` check depends on the verdict', () => {
    expect(jobs.test!.needs).toContain('rendered-checks')
    const step = jobs.test!.steps!.find((entry) => entry.run === 'bun .github/lane-gate.ts verify-result')!
    expect(step.env!.LANE_NAMES!.split(',')).toContain('rendered-checks')
  })

  test('the gates lane runs the mapping test', () => {
    const step = jobs['test-gates']!.steps!.find(
      (entry) => entry.name === 'Validate rendered web check mapping and gate'
    )!
    expect(step.run).toBe('bun test ./rendered-checks-gate.test.ts ../apps/web/scripts/rendered-checks.test.ts')
    expect(step['working-directory']).toBe('.github')
    expect(step['continue-on-error']).toBeUndefined()
  })
})
