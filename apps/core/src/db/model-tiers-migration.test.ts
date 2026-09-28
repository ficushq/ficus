import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { applyMigrations } from './migrator'
import { createPostgresConnection, getConnectionString } from './connection'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('CREATE TABLE "model_tiers"'))
const pre = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const post = target ? migrations.filter((migration) => migration.folderMillis > target.folderMillis) : []
const dbName = `model_tiers_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}
const historicalAssignment = {
  subagent: 'fast',
  'artifact-builder-default': 'fast',
  general: 'fast',
  engineer: 'standard',
  concierge: 'standard',
  consultant: 'standard',
  reviewer: 'deep',
  architect: 'deep',
  manager: 'deep',
  'system-manager': 'deep',
  sysops: 'deep',
  'security-auditor': 'exhaustive',
} as const
const shippedAssignment = {
  assistant: 'fast',
  'assistant-worker': 'standard',
  engineer: 'standard',
  reviewer: 'deep',
  'security-auditor': 'exhaustive',
  'system-manager': 'standard',
  manager: 'standard',
  sysops: 'standard',
  subagent: 'standard',
  'artifact-builder-default': 'standard',
  general: 'standard',
  consultant: 'deep',
  architect: 'exhaustive',
} as const
// This suite spins up a real scratch database and shells out to a real
// migration test-runner process — too jitter-prone for the shared CI runner.
// It runs only in the dedicated `subprocess-tests` CI job (see ci.yml); the
// main sweep sets FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('model tiers migration (real runner, fresh DB)', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })
  afterAll(async () => {
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })
  test('migrates distinct historical chains through the real YAML ConfigSync target', async () => {
    expect(target).toBeDefined()
    await applyMigrations(connection, pre)
    const historical = {
      fast: 'openai-codex:gpt-5.6-sol:low,zai:glm-5.3:high',
      deep: 'openai-codex:gpt-5.6-sol:high,anthropic:claude-opus-4-8:high,zai:glm-5.3:high',
      exhaustive: 'openai-codex:gpt-5.6-sol:xhigh,zai:glm-5.3:high,google:gemini-3.1-pro-preview:xhigh',
    }
    for (const [id, tier] of Object.entries(historicalAssignment)) {
      const oldModel =
        id === 'engineer' ? '' : historical[tier === 'exhaustive' ? 'exhaustive' : tier === 'deep' ? 'deep' : 'fast']
      await connection.unsafe(
        `INSERT INTO agent_types (id,name,model,system_prompt,yaml_field_overrides) VALUES ($1,$2,$3,'prompt',$4::jsonb)`,
        [id, id, oldModel, id === 'architect' ? ['model'] : []]
      )
    }
    expect(
      (
        await connection.unsafe<{ model: string; overrides: string[] }[]>(
          `SELECT model, yaml_field_overrides AS overrides FROM agent_types WHERE id='architect'`
        )
      )[0]
    ).toMatchObject({ model: historical.deep, overrides: ['model'] })
    await applyMigrations(connection, target!)
    expect(
      (await connection.unsafe<{ model: string }[]>(`SELECT model FROM agent_types WHERE id='architect'`))[0].model
    ).toBe(historical.deep)
    await applyMigrations(connection, post)
    const runner = Bun.spawn(
      [process.execPath, join(MONOREPO_ROOT, 'apps/core/src/services/config-sync/model-tier-sync.test-runner.ts')],
      {
        cwd: MONOREPO_ROOT,
        env: { ...process.env, FICUS_TEST_MODE: '0', DATABASE_URL: urlFor(dbName) },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const stderr = await new Response(runner.stderr).text()
    expect(await runner.exited, stderr).toBe(0)
    const expectedChains = new Map(
      Object.keys(historical)
        .concat('standard')
        .map((slug) => {
          const tier = yaml.load(readFileSync(join(MONOREPO_ROOT, 'config/model-tiers', `${slug}.yaml`), 'utf8')) as {
            chain: string
          }
          return [slug, tier.chain]
        })
    )
    const rows = await connection.unsafe<{ id: string; model: string; tier: string; chain: string }[]>(
      `SELECT a.id,a.model,a.tier,t.chain FROM agent_types a JOIN model_tiers t ON t.slug=a.tier ORDER BY a.id`
    )
    expect(rows).toHaveLength(Object.keys(shippedAssignment).length)
    expect(rows.some((row) => row.id === 'concierge')).toBe(false)
    for (const row of rows) {
      expect(row.tier).toBe(shippedAssignment[row.id as keyof typeof shippedAssignment])
      expect(row.chain).toBe(expectedChains.get(row.tier)!)
    }
    // Dedicated exactly-one-place assertion: removing the migration's clear-model step must fail here only.
    expect(rows.find((row) => row.id === 'architect')?.model).toBe(historical.deep)
    expect(rows.filter((row) => row.id !== 'architect').every((row) => row.model === '')).toBe(true)
  }, 240_000)
})
