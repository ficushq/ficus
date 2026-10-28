import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
