import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const workflow = Bun.YAML.parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))

test('rootless box runtime proof runs on a disposable systemd VM in normal PR CI, without skip fallback', () => {
  const job = workflow.jobs['rootless-box-containment']
  expect(job).toBeDefined()
  expect(job.if).toBeUndefined()
  expect(job['runs-on']).toBe('ubuntu-24.04')
  expect(job['timeout-minutes']).toBeLessThanOrEqual(15)
  const run = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
  expect(run).toContain('FICUS_TEST_DISPOSABLE_SYSTEMD=1')
  expect(run).toContain('scripts/machine/box-cgroup.integration.sh')
  expect(run).toContain('timeout --kill-after=90s 10m')
  expect(run).toContain("grep -Fxq '5 real rootless containment phases passed'")
  expect(run.slice(run.indexOf('out=$(sudo'), run.indexOf('|| status=$?'))).not.toContain('GITHUB_STEP_SUMMARY')
  expect(run).not.toMatch(/sysctl.*(?:unprivileged_userns|apparmor)|continue-on-error|workflow_dispatch/)
})

test('the runtime fixture refuses shared/live hosts and owns bounded payloads and cleanup', () => {
  const fixture = readFileSync(resolve(root, 'scripts/machine/box-cgroup.integration.sh'), 'utf8')
  expect(fixture).toContain('RUNNER_ENVIRONMENT')
  expect(fixture).toContain('GITHUB_ACTIONS')
  expect(fixture).toContain('FICUS_TEST_DISPOSABLE_SYSTEMD')
  expect(fixture).toContain('trap cleanup EXIT')
  expect(fixture).toContain('sleep 120')
  expect(fixture).toContain('cgroup.procs')
  expect(fixture).toContain('containerd-shim-runc-v2')
  expect(fixture).toContain('memory.max')
  expect(fixture).toContain('cpu.max')
  expect(fixture).not.toMatch(/docker (?:system prune|rm.*\$\(|run -d)|pkill|apparmor_restrict_unprivileged_userns/)
})

test('failed runtime acceptance captures bounded exact-account diagnostics before teardown', () => {
  const fixture = readFileSync(resolve(root, 'scripts/machine/box-cgroup.integration.sh'), 'utf8')
  expect(fixture).toContain('diagnose_runtime_failure()')
  expect(fixture).toContain('timeout --kill-after=2s 5s journalctl')
  expect(fixture).toContain('"_UID=$uid" _SYSTEMD_USER_UNIT=docker.service')
  expect(fixture).toContain('show docker.service -p ActiveState -p SubState -p Result -p ExecMainStatus')
  expect(fixture.indexOf('diagnose_runtime_failure "$uid"')).toBeLessThan(fixture.indexOf('--user stop'))
  expect(fixture).not.toContain('-p Environment')
})

test('provision diagnostics preserve streams and failure status without logging commands or environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-ci-trace-'))
  try {
    const script = join(dir, 'synthetic-provision.sh')
    writeFileSync(
      script,
      `set -eu
fixture_phase() {
  printf '%s\\n' fixture-stdout
  printf '%s\\n' fixture-stderr >&2
  test "$1" = argument-not-for-logs
  test "$TRACE_PRIVATE_VALUE" = environment-not-for-logs
  return 73
}
rc=0
fixture_phase "$@" || rc=$?
exit "$rc"
`
    )
    const result = spawnSync(
      'bash',
      [resolve(root, 'scripts/machine/box-provision-ci-trace.sh'), script, 'argument-not-for-logs'],
      {
        env: { ...process.env, TRACE_PRIVATE_VALUE: 'environment-not-for-logs' },
        encoding: 'utf8',
        timeout: 2_000,
      }
    )
    expect(result.status).toBe(73)
    expect(result.stdout).toBe('fixture-stdout\n')
    expect(result.stderr).toContain('fixture-stderr\n')
    expect(result.stderr).toMatch(/FICUS_CI_PROVISION_TRACE pid=\d+ line=\d+ function=fixture_phase/)
    expect(result.stderr).not.toContain('argument-not-for-logs')
    expect(result.stderr).not.toContain('environment-not-for-logs')
    expect(result.stderr).not.toContain('printf')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provision trace exposes a stalled source location without defeating the process-group deadline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-ci-trace-'))
  try {
    const script = join(dir, 'stalled-provision.sh')
    writeFileSync(script, 'fixture_stall() { sleep 5; }\nfixture_stall\n')
    const started = performance.now()
    const result = spawnSync(
      'timeout',
      ['--kill-after=0.1s', '0.1s', 'bash', resolve(root, 'scripts/machine/box-provision-ci-trace.sh'), script],
      {
        encoding: 'utf8',
        timeout: 2_000,
      }
    )
    expect(result.status).toBe(124)
    expect(result.stderr).toMatch(/FICUS_CI_PROVISION_TRACE pid=\d+ line=\d+ function=fixture_stall/)
    expect(performance.now() - started).toBeLessThan(2_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real provision keeps bounded tracing and original five-phase acceptance', () => {
  const fixture = readFileSync(resolve(root, 'scripts/machine/box-cgroup.integration.sh'), 'utf8')
  expect(fixture).toContain('CAPTURE="${TARGET%/*}/box-provision-ci-capture.sh"')
  expect(fixture).toContain('bash "$CAPTURE" 150s bash "$TRACE" "$TARGET"')
  const capture = readFileSync(resolve(root, 'scripts/machine/box-provision-ci-capture.sh'), 'utf8')
  expect(capture).toContain('timeout --kill-after=5s "$duration" "$@" 2>&1')
  expect(capture).toContain('FICUS_CI_PROVISION_EXIT status=')
  for (const phase of [
    'first-provision',
    'unchanged-reprovision',
    'daemon-restart',
    'custom-parent',
    'manager-recreation',
  ]) {
    expect(fixture).toContain(`assert_workload ${phase}`)
  }
  expect(fixture).toContain("printf '5 real rootless containment phases passed\\n'")
})

for (const failure of ['lock', 'timeout'] as const) {
  test(`actual failed-phase capture reaches job output and step summary: ${failure}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ficus-phase-capture-'))
    try {
      const script = join(dir, 'synthetic-provision.sh')
      const summary = join(dir, 'summary.md')
      const scratch = join(dir, 'scratch')
      mkdirSync(scratch)
      writeFileSync(summary, '')
      writeFileSync(
        script,
        `printf '%s\\n' 'full stdout <fixture> & detail'
printf '%s\\n' 'full stderr fixture' >&2
printf '%s\\n' 'FICUS_BOX_LOCK_TIMEOUT box=box_aaaaaaaaaaaa holder_pid=123 wait_seconds=1 lock=/fixture/lock' >&2
printf '%060000d\\n' 0
printf '%060000d\\n' 1 >&2
${failure === 'lock' ? 'exit 73' : 'sleep 5'}
`
      )
      // Transport stub only: execute the EXACT capture entrypoint shared with
      // provision(), never the privileged/disposable-host integration entry.
      const sudo = join(dir, 'sudo')
      writeFileSync(
        sudo,
        '#!/usr/bin/env bash\nbash "$CAPTURE" 1s bash -c \'echo earlier-successful-phase\'\nexec bash "$CAPTURE" "$PHASE_DEADLINE" bash "$TRACE" "$SYNTHETIC" argument-not-for-logs\n'
      )
      chmodSync(sudo, 0o755)
      const run = workflow.jobs['rootless-box-containment'].steps.find(
        (step: { name?: string }) => step.name === 'Prove real daemon, shim and payload ancestry across recreation'
      ).run
      const result = spawnSync('bash', ['-c', run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TMPDIR: scratch,
          CAPTURE: resolve(root, 'scripts/machine/box-provision-ci-capture.sh'),
          TRACE: resolve(root, 'scripts/machine/box-provision-ci-trace.sh'),
          SYNTHETIC: script,
          PHASE_DEADLINE: '1s',
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          GITHUB_RUN_ID: 'synthetic',
          GITHUB_RUN_ATTEMPT: '1',
          TRACE_PRIVATE_VALUE: 'environment-not-for-logs',
        },
        encoding: 'utf8',
        timeout: 3_000,
      })
      const expectedStatus = failure === 'lock' ? 73 : 124
      expect(result.status).toBe(expectedStatus)
      const report = readFileSync(summary, 'utf8')
      for (const output of [result.stdout, report]) {
        expect(output).toContain('full stdout')
        expect(output).toContain('full stderr fixture')
        expect(output).toContain('0'.repeat(60_000))
        expect(output).toContain('0'.repeat(59_999) + '1')
        expect(output).toContain('FICUS_BOX_LOCK_TIMEOUT box=box_aaaaaaaaaaaa holder_pid=123')
        expect(output).toContain(`FICUS_CI_PROVISION_EXIT status=${expectedStatus}`)
        expect(output).not.toContain('argument-not-for-logs')
        expect(output).not.toContain('environment-not-for-logs')
      }
      expect(result.stdout).toContain('<fixture> & detail')
      expect(report).toContain('&lt;fixture&gt; &amp; detail')
      expect(result.stdout).toContain('earlier-successful-phase')
      expect(report).not.toContain('earlier-successful-phase')
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('oversize phase capture fails explicitly and retains middle lock diagnosis within its byte budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-phase-budget-'))
  try {
    const script = join(dir, 'oversize.sh')
    writeFileSync(
      script,
      `head -c 150000 /dev/zero | tr '\\0' a
printf '\\nFICUS_BOX_LOCK_TIMEOUT holder_pid=456\\n' >&2
head -c 150000 /dev/zero | tr '\\0' b
`
    )
    const result = spawnSync(
      'bash',
      [resolve(root, 'scripts/machine/box-provision-ci-capture.sh'), '1s', 'bash', script],
      {
        encoding: 'utf8',
        timeout: 3_000,
      }
    )
    expect(result.status).toBe(74)
    expect(result.stdout).toContain('FICUS_CI_PROVISION_OUTPUT_LIMIT')
    expect(result.stdout).toContain('FICUS_BOX_LOCK_TIMEOUT holder_pid=456')
    expect(result.stdout).toContain('FICUS_CI_PROVISION_EXIT status=0 capture_status=74')
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(140_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
