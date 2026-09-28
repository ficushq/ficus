import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

function runBoot(extra: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('TAU_') || key.startsWith('FICUS_')) continue
    env[key] = value
  }
  const proc = Bun.spawnSync(
    [
      'bun',
      '-e',
      `import './packages/k8s-sandbox/src/boot/legacy-env'; console.log(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('TAU_'))) + ' ' + process.env.FICUS_BOX_HOME)`,
    ],
    { cwd: REPO_ROOT, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' }
  )
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test('the sandbox bridge moves TAU_ names and warns with the shared line', () => {
  const result = runBoot({ TAU_BOX_HOME: '/home/box' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim().split('\n').at(-1)).toBe('[] /home/box')
  expect(result.stdout + result.stderr).toContain(
    '[sandbox] legacy TAU_* environment moved to FICUS_*: TAU_BOX_HOME (rename them; TAU_* is ignored from the next release)'
  )
})

test('the sandbox bridge reports a conflict by name and never prints either value', () => {
  const result = runBoot({ TAU_ENCRYPTION_KEY: 'legacy-key-value', FICUS_ENCRYPTION_KEY: 'stray-key-value' })
  expect(result.exitCode).toBe(0)
  const logs = result.stdout + result.stderr
  expect(logs).toContain('legacy TAU_* and FICUS_* disagree for: TAU_ENCRYPTION_KEY')
  expect(logs).not.toContain('legacy-key-value')
  expect(logs).not.toContain('stray-key-value')
})
