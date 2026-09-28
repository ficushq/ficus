import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { assertLocalSetupFixtureEnvironment } from '../apps/core/src/scripts/seed-local-setup-github'

test('local-setup seeds an integration after setup and before the updater rewinds its checkout', () => {
  const workflow = readFileSync(new URL('workflows/ci.yml', import.meta.url), 'utf8')
  const job = workflow.slice(workflow.indexOf('\n  local-setup:'))
  const setup = job.indexOf('- name: Setup (host runtime)')
  const seed = job.indexOf('- name: Seed GitHub integration for the in-app updater')
  const update = job.indexOf('- name: Health, status, and API-native updater support')
  expect(setup).toBeGreaterThan(-1)
  expect(seed).toBeGreaterThan(setup)
  expect(update).toBeGreaterThan(seed)
  expect(job.slice(seed, update)).toContain('bun apps/core/src/scripts/seed-local-setup-github.ts')
  expect(job.slice(seed, update)).toContain('DATABASE_URL: postgres://postgres:postgres@localhost:5433/tau_local_setup')
  expect(job).not.toContain('gh auth login')
})

test('CI credential seeding refuses non-CI, inherited databases, and missing secrets', () => {
  const env = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/tau_local_setup',
    GH_TOKEN: 'fixture-token',
    FICUS_PASSWORD: 'fixture-password',
    FICUS_ENCRYPTION_KEY: '0'.repeat(64),
  }
  expect(() => assertLocalSetupFixtureEnvironment(env)).not.toThrow()
  for (const key of Object.keys(env)) {
    expect(() => assertLocalSetupFixtureEnvironment({ ...env, [key]: undefined })).toThrow()
  }
  for (const DATABASE_URL of ['postgres://localhost/tau', 'postgres://production:5433/tau_local_setup']) {
    expect(() => assertLocalSetupFixtureEnvironment({ ...env, DATABASE_URL })).toThrow()
  }
})
