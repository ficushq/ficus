import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRootEnvForStandaloneScript, resolveRootEnvDatabaseUrl } from './load-root-env'
import { MONOREPO_ROOT } from '../lib/paths'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function tempRoot(envContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tau-root-env-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (envContent !== undefined) writeFileSync(join(dir, '.env'), envContent)
  return dir
}

// This file's real-entrypoint suite below shells out to a real
// `bun run db:migrate` subprocess — too jitter-prone for the shared CI
// runner. It runs only in the dedicated `subprocess-tests` CI job (see
// ci.yml); the main sweep sets FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('loadRootEnvForStandaloneScript', () => {
  test('supplies a variable the process does not have', () => {
    const key = `FICUS_ROOT_ENV_TEST_${process.pid}`
    cleanups.push(() => delete process.env[key])
    const root = tempRoot(`${key}=from-file\n`)

    const loaded = loadRootEnvForStandaloneScript(root)

    expect(process.env[key]).toBe('from-file')
    expect(loaded).toContain(key)
  })

  test('NEVER overrides a variable that is already set — explicit env beats the file', () => {
    const key = `FICUS_ROOT_ENV_TEST_KEEP_${process.pid}`
    process.env[key] = 'explicit'
    cleanups.push(() => delete process.env[key])
    const root = tempRoot(`${key}=from-file\n`)

    const loaded = loadRootEnvForStandaloneScript(root)

    expect(process.env[key]).toBe('explicit')
    expect(loaded).not.toContain(key)
  })

  test('missing file is a silent no-op', () => {
    const root = tempRoot(undefined)
    expect(loadRootEnvForStandaloneScript(root)).toEqual([])
  })

  test('resolves the root database URL without overriding the invoking environment', () => {
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://explicit@localhost/explicit'
    cleanups.push(() => {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    })
    const root = tempRoot('DATABASE_URL=postgres://root@localhost/root\n')

    expect(resolveRootEnvDatabaseUrl(root)).toBe('postgres://root@localhost/root')
    expect(process.env.DATABASE_URL).toBe('postgres://explicit@localhost/explicit')
  })
})

describe('loadRootEnvForStandaloneScript legacy TAU_ keys (one release)', () => {
  test("bridges the file's TAU_X to FICUS_X in its own record before merging", () => {
    const suffix = `ROOT_ENV_BRIDGE_${process.pid}`
    cleanups.push(() => {
      delete process.env[`FICUS_${suffix}`]
      delete process.env[`TAU_${suffix}`]
    })
    const root = tempRoot(`TAU_${suffix}=from-file\n`)

    const loaded = loadRootEnvForStandaloneScript(root)

    expect(process.env[`FICUS_${suffix}`]).toBe('from-file')
    expect(process.env[`TAU_${suffix}`]).toBeUndefined()
    expect(loaded).toEqual([`FICUS_${suffix}`])
  })

  test("never lets the file's legacy encryption key replace an explicit FICUS_ one", () => {
    const key = `FICUS_ROOT_ENV_ENCRYPTION_KEY_${process.pid}`
    const legacy = `TAU_ROOT_ENV_ENCRYPTION_KEY_${process.pid}`
    process.env[key] = 'explicit'
    cleanups.push(() => {
      delete process.env[key]
      delete process.env[legacy]
    })
    const root = tempRoot(`${legacy}=from-file\n`)

    const loaded = loadRootEnvForStandaloneScript(root)

    expect(process.env[key]).toBe('explicit')
    expect(process.env[legacy]).toBeUndefined()
    expect(loaded).toEqual([])
  })
})

// ── The real seam: the ACTUAL `bun run db:migrate` entrypoint ────────────────
//
// Tenant VMs deliver DATABASE_URL only through the rendered repo-root .env;
// the setup toolkit runs `(cd apps/core && bun run db:migrate)` with a bare
// environment. Dev/CI/tests all inject DATABASE_URL directly, which is
// exactly why dropping the root-.env load shipped without a single failing
// test (fleet-wide provisioning outage, 2026-08-13). These two cases drive
// the real script the way the toolkit does.
//
// They are skipped when the repo root already has a .env (a developer
// machine): writing or deleting a developer's real .env from a test is not
// acceptable, and CI — which has no root .env — is the environment this seam
// exists to protect anyway.
const rootEnvPath = join(MONOREPO_ROOT, '.env')
const canUseRealRoot = !existsSync(rootEnvPath)

async function runMigrateBare(): Promise<{ exitCode: number; stderr: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'DATABASE_URL') env[k] = v
  }
  const proc = Bun.spawn(['bun', 'run', 'db:migrate'], {
    cwd: join(MONOREPO_ROOT, 'apps/core'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ])
  return { exitCode, stderr: `${stderr}\n${stdout}` }
}

describe.skipIf(!canUseRealRoot || process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')(
  'run-migrations env delivery (real entrypoint, toolkit invocation shape)',
  () => {
    test('with no root .env and no explicit DATABASE_URL, the runner fails closed', async () => {
      const { exitCode, stderr } = await runMigrateBare()
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('explicit DATABASE_URL override')
    }, 30_000)

    test('a root .env alone is refused before a database connection is attempted', async () => {
      writeFileSync(
        rootEnvPath,
        'DATABASE_URL=postgres://tau:migration-credential-sentinel-7c4e@127.0.0.1:1/tau_nowhere\n'
      )
      cleanups.push(() => unlinkSync(rootEnvPath))

      const { exitCode, stderr } = await runMigrateBare()

      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('explicit DATABASE_URL override')
      expect(stderr).toContain('Refused target: 127.0.0.1:1/tau_nowhere')
      expect(stderr).not.toContain('migration-credential-sentinel-7c4e')
      expect(stderr).not.toContain('ECONNREFUSED')
    }, 30_000)
  }
)
