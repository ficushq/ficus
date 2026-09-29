import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { RENAME_BRIDGE_TAG } from '@ficus/shared/env-naming'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')

/** Boots a secret store in a child process with only the given encryption settings. */
function bootStore(extraEnv: Record<string, string>) {
  const script = [
    "import { SecretStore } from './apps/core/src/services/secrets/store'",
    'await new SecretStore().initialize()',
    'await new SecretStore().initialize()',
    "console.log('STILL RUNNING')",
  ].join('\n')
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/unused',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` }
}

describe('secret store boot with an encryption key from before the Ficus naming', () => {
  test('starts, logs the error once by name only, and never exits', () => {
    const { code, output } = bootStore({ OLD_ENCRYPTION_KEY: 'old-key-value-never-logged' })
    expect(code).toBe(0)
    expect(output).toContain('STILL RUNNING')
    const errors = output.split('\n').filter((line) => line.includes('predate the Ficus naming'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('OLD_ENCRYPTION_KEY')
    expect(errors[0]).toContain(RENAME_BRIDGE_TAG)
    expect(output).not.toContain('old-key-value-never-logged')
  })

  test('says nothing about the naming when no other encryption key is present', () => {
    const { code, output } = bootStore({})
    expect(code).toBe(0)
    expect(output).toContain('STILL RUNNING')
    expect(output).not.toContain('predate the Ficus naming')
  })
})
