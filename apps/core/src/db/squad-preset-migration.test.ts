import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'
import { profileFingerprint } from './agent-expertise-backfill'

const rollout = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find((m) =>
  m.sql.join('\n').includes('ALTER TABLE "squad_types" RENAME TO "squad_presets"')
)!
const start = rollout.sql.findIndex((sql) => sql.includes('ALTER TABLE "squad_types" RENAME TO "squad_presets"'))
const end = rollout.sql.findIndex((sql) => sql.includes('RENAME COLUMN "profiles" TO "participant_snapshots"'))
const target = { ...rollout, sql: rollout.sql.slice(start, end) }
const source = { kind: 'preset', id: 'solo-coding', customizations: [] }
const styles = { default: source, guidance: 'Pick the smallest flow.', choices: [{ when: 'Ordinary changes', source }] }
const oldProfile = { id: 'worker', extraScopes: ['squad-types:read'], systemPrompt: 'Expertise' }
const newProfile = { ...oldProfile, extraScopes: ['squad-presets:read'] }

describe.each(['standalone', 'Drizzle startup'] as const)('detach squad presets migration (%s)', (mode) => {
  const databaseName = `presets_${crypto.randomUUID().replaceAll('-', '')}`
  const id = crypto.randomUUID()
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  const urlFor = (name: string) => {
    const url = new URL(getConnectionString())
    url.pathname = `/${name}`
    return url.toString()
  }
  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    if (mode === 'Drizzle startup') drizzle(client)
    connection = await client.reserve()
    await connection.unsafe(`
      CREATE TABLE squad_types(id text PRIMARY KEY,manager_instructions text,worker_instructions jsonb,work_styles jsonb,yaml_template jsonb,yaml_field_overrides jsonb);
      CREATE TABLE squads(id text PRIMARY KEY,squad_type_id text,metadata jsonb,type_context jsonb,
        CONSTRAINT squads_squad_type_id_squad_types_id_fk FOREIGN KEY(squad_type_id) REFERENCES squad_types(id) ON DELETE SET NULL);
      CREATE TABLE roles(id text PRIMARY KEY,permissions jsonb);
      CREATE TABLE system_tokens(id text PRIMARY KEY,scopes jsonb);
      CREATE TABLE agent_extra_scopes(agent_id text,permission text,UNIQUE(agent_id,permission));
      CREATE TABLE skills(required_permission text);
      CREATE TABLE agent_types(id text,extra_scopes text[],yaml_template jsonb);
      CREATE TABLE work_stream_flow_runs(work_stream_id uuid PRIMARY KEY,profiles jsonb);
      CREATE TABLE work_style_bindings(agent_id uuid PRIMARY KEY,binding_key text,profile jsonb);
    `)
    await connection`INSERT INTO squad_types VALUES ('engineering','Coordinate incidents.','{"all":"Retired instructions"}',${JSON.stringify(styles)}::text::jsonb,'{"managerInstructions":"Coordinate incidents.","workerInstructions":{"all":"Retired"}}','["workerInstructions","managerInstructions"]')`
    await connection.unsafe(`
      INSERT INTO squads VALUES ('inherited','engineering','{}',NULL),('overridden','engineering','{"workStyle":{"kind":"preset","id":"research-brief"},"workStyleSetup":{"guidance":"Own guidance","choices":[]},"keep":true}','{"manager":"Squad context","engineer":"Local expertise"}'),('plain',NULL,'{}',NULL);
      INSERT INTO roles VALUES ('role','["squad-types:*","squads:read"]');
      INSERT INTO system_tokens VALUES ('token','["squad-types:read","squad-presets:read"]');
      INSERT INTO agent_extra_scopes VALUES ('worker','squad-types:read'),('worker','squad-presets:read');
      INSERT INTO skills VALUES ('squad-types:read');
      INSERT INTO agent_types VALUES ('worker',ARRAY['squad-types:read'],'{"extraScopes":["squad-types:read"]}');
    `)
    await connection`INSERT INTO work_stream_flow_runs VALUES (${id},${JSON.stringify({ worker: oldProfile })}::text::jsonb)`
    await connection`INSERT INTO work_style_bindings VALUES (${id},${`worker:${profileFingerprint(oldProfile)}:reuse-0`},${JSON.stringify(oldProfile)}::text::jsonb)`
  })
  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })
  test('atomically copies defaults/context, renames grants, drops worker instructions, and retains provenance', async () => {
    await expect(
      applyMigrations(connection, { ...target, sql: [...target.sql, 'SELECT * FROM intentionally_missing'] })
    ).rejects.toThrow()
    expect((await connection`SELECT metadata FROM squads WHERE id='inherited'`)[0]!.metadata).toEqual({})
    await applyMigrations(connection, target)
    const rows = await connection`SELECT * FROM squads ORDER BY id`
    expect(rows.find((r) => r.id === 'inherited')).toMatchObject({
      squad_preset_id: 'engineering',
      type_context: { manager: 'Coordinate incidents.' },
      metadata: { workStyle: source, workStyleSetup: { guidance: styles.guidance, choices: styles.choices } },
    })
    expect(rows.find((r) => r.id === 'overridden')).toMatchObject({
      metadata: { workStyle: { id: 'research-brief' }, workStyleSetup: { guidance: 'Own guidance' }, keep: true },
      type_context: { manager: 'Coordinate incidents.\n\nSquad context', engineer: 'Local expertise' },
    })
    expect(rows.find((r) => r.id === 'plain')!.metadata.workStyle.id).toBe('solo')
    const [preset] = await connection`SELECT * FROM squad_presets`
    expect(preset).not.toHaveProperty('worker_instructions')
    expect(preset!.yaml_template).not.toHaveProperty('workerInstructions')
    expect(preset!.yaml_field_overrides).toEqual(['managerInstructions'])
    expect((await connection`SELECT permissions FROM roles`)[0]!.permissions).toEqual([
      'squad-presets:*',
      'squads:read',
    ])
    expect((await connection`SELECT scopes FROM system_tokens`)[0]!.scopes).toEqual(['squad-presets:read'])
    expect([...(await connection`SELECT permission FROM agent_extra_scopes`)]).toEqual([
      { permission: 'squad-presets:read' },
    ])
    expect((await connection`SELECT required_permission FROM skills`)[0]!.required_permission).toBe(
      'squad-presets:read'
    )
    expect((await connection`SELECT * FROM agent_types`)[0]).toMatchObject({
      extra_scopes: ['squad-presets:read'],
      yaml_template: { extraScopes: ['squad-presets:read'] },
    })
    expect((await connection`SELECT profiles FROM work_stream_flow_runs`)[0]!.profiles).toEqual({ worker: newProfile })
    expect((await connection`SELECT binding_key FROM work_style_bindings`)[0]!.binding_key).toBe(
      `worker:${profileFingerprint(newProfile)}:reuse-0`
    )
    await applyMigrations(connection, target)
    await connection`DELETE FROM squad_presets`
    expect((await connection`SELECT squad_preset_id FROM squads WHERE id='inherited'`)[0]!.squad_preset_id).toBe(
      'engineering'
    )
    expect((await connection`SELECT type_context FROM squads WHERE id='overridden'`)[0]!.type_context.manager).toBe(
      'Coordinate incidents.\n\nSquad context'
    )
  })
})
