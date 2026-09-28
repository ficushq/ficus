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
      `import './apps/cli/src/boot/legacy-env'; import './apps/cli/src/boot/legacy-env'; console.log(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('TAU_'))) + ' ' + process.env.FICUS_X)`,
    ],
    { cwd: REPO_ROOT, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' }
  )
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test('the CLI bridge moves TAU_ names and warns on stderr once', () => {
  const result = runBoot({ TAU_X: '1' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('[] 1')
  const line = 'legacy TAU_* environment moved to FICUS_*: TAU_X (rename them; TAU_* is ignored from the next release)'
  expect(result.stderr.split(line).length - 1).toBe(1)
})

test('the CLI bridge is silent on stderr when nothing moved', () => {
  const result = runBoot({ TAU_X: 'old', FICUS_X: 'new' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('[] new')
  expect(result.stderr).toBe('')
})

test('the CLI bridge reports a conflict by name and never prints either value', () => {
  const result = runBoot({ TAU_ENCRYPTION_KEY: 'legacy-key-value', FICUS_ENCRYPTION_KEY: 'stray-key-value' })
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toContain('legacy TAU_* and FICUS_* disagree for: TAU_ENCRYPTION_KEY')
  expect(result.stderr).not.toContain('legacy-key-value')
  expect(result.stderr).not.toContain('stray-key-value')
})
