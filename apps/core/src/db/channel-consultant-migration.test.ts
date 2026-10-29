import '../test-utils/require-test-db'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('DROP COLUMN "concierge_agent_id"'))!
const predecessors = migrations.filter((migration) => migration.folderMillis < target.folderMillis)
const urlFor = (name: string) => {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe.each(['standalone', 'Drizzle startup'] as const)('channel consultant upgrade (%s)', (mode) => {
  const databaseName = `channel_upgrade_${crypto.randomUUID().replaceAll('-', '')}`
  const squadId = crypto.randomUUID()
  const roleId = crypto.randomUUID()
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const context = {
    scope: { type: 'concierge' },
    channelInstance: { id: 'test-bot', provider: 'telegram' },
    thread: { id: 'thread', channelId: 'channel' },
  }
  const metadata = {
    name: 'Existing conversation',
    purpose: 'Research',
    custom: true,
    resourceGeneration: crypto.randomUUID(),
  }
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  beforeAll(async () => {
    admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    client = createPostgresConnection(urlFor(databaseName), { max: 1, onnotice: () => {} })
    if (mode === 'Drizzle startup') drizzle(client)
    connection = await client.reserve()
    await applyMigrations(connection, predecessors)
    await connection`INSERT INTO squads (id,name,purpose,type_context) VALUES (${squadId},'Squad','test','{"consultant":"Current instructions","concierge":"Channel instructions","engineer":"Keep"}'::jsonb)`
    await connection`INSERT INTO agent_types (id,name,model,system_prompt) VALUES ('concierge','Concierge','model','Old prompt')`
    for (const [i, status] of ['idle', 'dormant', 'terminated'].entries()) {
      await connection`INSERT INTO agents (id,agent_type_id,squad_id,status,context,metadata,persist)
        VALUES (${ids[i]!},'concierge',${squadId},${status},${JSON.stringify(context)}::text::jsonb,${JSON.stringify(metadata)}::text::jsonb,true)`
    }
    await connection`INSERT INTO channel_instances (id,name,provider,default_squad_id,concierge_agent_id)
      VALUES ('test-bot','Bot','telegram',${squadId},${ids[0]!})`
    await connection`INSERT INTO roles (id,name,slug,permissions,applies_to,is_system,read_only)
      VALUES (${roleId},'Default Concierge','default-concierge','["chat:send"]','agent',true,true)`
    if (mode === 'Drizzle startup') {
      await connection`INSERT INTO role_assignments (subject_type,subject_id,role_id,scope,squad_id)
        VALUES ('user',${ids[0]!},${roleId},'squad',${squadId})`
    }
    // An independent FK models retained correspondence, with the actual agent IDs.
    await connection`CREATE TABLE retained_messages (agent_id uuid REFERENCES agents(id), content text)`
    await connection`INSERT INTO retained_messages VALUES (${ids[0]!},'Existing transcript')`
  }, 30_000)
  afterAll(async () => {
    connection?.release()
    await client?.end()
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await admin.end()
    }
  })
  test('rolls back atomically, then preserves conversations and grants while retiring the old type', async () => {
    const before = await connection`SELECT * FROM agents ORDER BY id`
    await expect(
      applyMigrations(connection, { ...target, sql: [...target.sql, 'SELECT * FROM missing_rollout_fixture'] }).catch(
        (e) => {
          throw new Error(String(e))
        }
      )
    ).rejects.toThrow()
    expect([...(await connection`SELECT * FROM agents ORDER BY id`)]).toEqual([...before])
    expect((await connection`SELECT concierge_agent_id FROM channel_instances`)[0]!.concierge_agent_id).toBe(ids[0])

    await applyMigrations(connection, target)
    const after = await connection`SELECT * FROM agents ORDER BY id`
    expect(after).toHaveLength(3)
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).toEqual({
        ...before[i],
        agent_type_id: 'consultant',
        context: { ...context, scope: { type: 'consultant' } },
        updated_at: after[i]!.updated_at,
      })
      expect(Number.isFinite(new Date(after[i]!.updated_at).getTime())).toBe(true)
      expect(new Date(after[i]!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before[i]!.updated_at).getTime())
    }
    expect([...(await connection`SELECT * FROM retained_messages`)]).toEqual([
      { agent_id: ids[0], content: 'Existing transcript' },
    ])
    expect((await connection`SELECT type_context FROM squads WHERE id=${squadId}`)[0]!.type_context).toEqual({
      consultant: 'Current instructions\n\nChannel instructions',
      engineer: 'Keep',
    })
    expect(await connection`SELECT id FROM agent_types WHERE id='concierge'`).toHaveLength(0)
    expect(await connection`SELECT id FROM roles WHERE slug='default-concierge'`).toHaveLength(0)
    const remainingRoles = await connection`SELECT * FROM roles WHERE id=${roleId}`
    if (mode === 'Drizzle startup') {
      expect(remainingRoles[0]).toMatchObject({
        permissions: ['chat:send'],
        slug: `migrated-channel-access-${roleId}`,
        is_system: false,
        read_only: false,
      })
      expect(await connection`SELECT * FROM role_assignments WHERE role_id=${roleId}`).toHaveLength(1)
    } else expect(remainingRoles).toHaveLength(0)
    const [bot] = await connection`SELECT * FROM channel_instances`
    expect(bot).not.toHaveProperty('concierge_agent_id')
    expect(bot).toMatchObject({ allowed_channel_ids: [], denied_channel_ids: [], default_squad_id: squadId })
    await applyMigrations(connection, target)
    expect([...(await connection`SELECT * FROM agents ORDER BY id`)]).toEqual([...after])
  })
})
