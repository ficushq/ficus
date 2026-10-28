import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  expect(fixture).toContain('timeout --kill-after=5s 150s bash "$TRACE" "$TARGET"')
  expect(fixture).toContain('FICUS_CI_PROVISION_EXIT status=')
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
