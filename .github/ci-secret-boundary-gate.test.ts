import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const wrapper = readFileSync(resolve(root, '.github/run-secret-boundary-tests.sh'), 'utf8')
const corePackage = JSON.parse(readFileSync(resolve(root, 'apps/core/package.json'), 'utf8'))
const testSetup = readFileSync(resolve(root, 'apps/core/src/test-setup.ts'), 'utf8')
const validateConnection = readFileSync(resolve(root, 'apps/core/src/db/validate-connection.ts'), 'utf8')

test('CI runs the explicit sterile secret-boundary wrapper without ambient credentials', () => {
  expect(workflow).toContain('name: Create isolated sterile secret-boundary database')
  expect(workflow).toContain('CREATE DATABASE tau_secret_boundary_test;')
  expect(workflow).toContain('psql -v ON_ERROR_STOP=1')
  expect(workflow).toContain('name: Run sterile secret-boundary tests')
  expect(workflow).toContain('run: bash .github/run-secret-boundary-tests.sh')
  expect(workflow).toContain('DATABASE_URL: postgres://postgres:postgres@localhost:5433/tau_secret_boundary_test')
  expect(workflow).toContain("SECRET_BOUNDARY_REQUIRE_ISOLATED_DB: '1'")
  expect(workflow.indexOf('name: Create isolated sterile secret-boundary database')).toBeLessThan(
    workflow.indexOf('name: Run sterile secret-boundary tests')
  )
  expect(workflow).not.toMatch(/Run sterile secret-boundary tests[\s\S]{0,200}continue-on-error:\s*true/)
  expect(wrapper).toContain('env -i')
  expect(wrapper).toContain('CI=true')
  expect(wrapper).toContain('TERM="${TERM:-dumb}"')
  expect(wrapper).toContain('FICUS_TEST_SCHEMA_PUSH_NO_FORCE=1')
  expect(wrapper).toContain('psql "$DATABASE_URL" -v ON_ERROR_STOP=1')
  expect(wrapper).toContain('timeout --foreground 30s bun test')
  expect(wrapper).toContain('DATABASE_URL" != */tau_secret_boundary_test')
  expect(testSetup).toContain("['tau_test', 'tau_secret_boundary_test'].includes(databaseName)")
  expect(testSetup).toContain("process.env.FICUS_TEST_SCHEMA_PUSH_NO_FORCE === '1'")
  expect(validateConnection).toContain("dbName === 'tau_secret_boundary_test'")
  expect(validateConnection).toContain("process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB === '1'")
  for (const path of [
    'apps/core/src/services/security/content-safety-registry.test.ts',
    'apps/core/src/services/security/content-safety.test.ts',
    'apps/core/src/services/security/logger-content-safety.test.ts',
    'apps/core/src/services/security/stored-secret-tool-audit.test.ts',
    'apps/core/src/services/security/stored-secret-tool-containment.test.ts',
    'apps/core/src/services/security/tool-output-redaction.test.ts',
    'apps/core/src/services/secrets/store-hermetic.test.ts',
    'apps/core/src/services/secrets/store.test.ts',
    'apps/core/src/entities/agent-runners/base.test.ts',
  ]) {
    expect(wrapper).toContain(path)
  }
  expect(corePackage.scripts['test:secret-boundaries']).toBe('bash ../../.github/run-secret-boundary-tests.sh')

  const sharedDbAttempt = Bun.spawnSync(['bash', resolve(root, '.github/run-secret-boundary-tests.sh')], {
    env: {
      HOME: process.env.HOME ?? '/tmp',
      PATH: process.env.PATH ?? '',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/tau_test',
      SECRET_BOUNDARY_REQUIRE_ISOLATED_DB: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(sharedDbAttempt.exitCode).not.toBe(0)
  expect(sharedDbAttempt.stderr.toString()).toContain('requires its isolated database')

  const unreachableDbAttempt = Bun.spawnSync(['bash', resolve(root, '.github/run-secret-boundary-tests.sh')], {
    env: {
      HOME: process.env.HOME ?? '/tmp',
      PATH: process.env.PATH ?? '',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/tau_secret_boundary_test',
      SECRET_BOUNDARY_REQUIRE_ISOLATED_DB: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  })
  expect(unreachableDbAttempt.exitCode).not.toBe(0)
  expect(unreachableDbAttempt.stderr.toString()).toContain('database is unreachable')
})
