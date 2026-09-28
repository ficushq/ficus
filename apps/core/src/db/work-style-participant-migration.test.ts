import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { createBlankWorkflow, workflowDefinitionSchema, workflowCommandSchema } from '@ficus/shared'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'
import { upgradeWorkStyleParticipants } from './work-style-participant-backfill'
import { profileFingerprint as legacyFingerprint } from './agent-expertise-backfill'
import { workflowFingerprint } from '../services/workflows/catalog'

const rollout = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find((m) =>
  m.sql.join('\n').includes('RENAME COLUMN "profiles" TO "participant_snapshots"')
)!
const start = rollout.sql.findIndex((sql) => sql.includes('RENAME COLUMN "profiles" TO "participant_snapshots"'))
const end = rollout.sql.findIndex((sql) =>
  sql.includes('ALTER TABLE "work_style_bindings" RENAME TO "workflow_bindings"')
)
const target = { ...rollout, sql: rollout.sql.slice(start, end) }
const current = createBlankWorkflow()
const legacy = { ...current, participants: { worker: { profile: 'general', session: 'reuse-within-stream' } } }
const customization = {
  op: 'put-participant',
  id: 'reviewer',
  participant: { profile: 'general', session: 'fresh-per-attempt' },
}
const command = {
  action: 'delegate',
  expectedVersion: 0,
  attemptId: 1,
  participant: { profile: 'general', session: 'reuse-within-stream' },
  task: 'Review and return evidence.',
}
const snapshot = { id: 'general', systemPrompt: 'Pinned expertise.', model: 'openai:gpt-4.1' }

test('participant rename preserves revision/request hashes and unrelated profile data', () => {
  expect(workflowFingerprint(current)).toBe(legacyFingerprint(legacy))
  const upgradedCommand = upgradeWorkStyleParticipants(command)
  expect(workflowCommandSchema.safeParse(upgradedCommand).success).toBe(true)
  expect(workflowFingerprint({ command: upgradedCommand, actorKey: 'owner' })).toBe(
    legacyFingerprint({ command, actorKey: 'owner' })
  )
  expect(workflowFingerprint(upgradeWorkStyleParticipants(customization))).toBe(legacyFingerprint(customization))
  const unrelated = {
    profile: { name: 'Account' },
    participants: { worker: { profile: 'User data' } },
    note: 'profile: general',
  }
  expect(upgradeWorkStyleParticipants(unrelated)).toEqual(unrelated)
  expect(() =>
    upgradeWorkStyleParticipants({ ...customization, participant: { profile: 'general', agentTypeId: 'other' } })
  ).toThrow('Conflicting')
})

for (const mode of ['standalone', 'drizzle-startup'] as const)
  describe(`participant migration (${mode})`, () => {
    const databaseName = `participants_${crypto.randomUUID().replaceAll('-', '')}`
    const id = crypto.randomUUID()
    let admin: ReturnType<typeof createPostgresConnection>
    let client: ReturnType<typeof createPostgresConnection>
    let connection: postgres.ReservedSql
    beforeAll(async () => {
      admin = createPostgresConnection(getConnectionString(), { max: 1 })
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
      const url = new URL(getConnectionString())
      url.pathname = `/${databaseName}`
      client = createPostgresConnection(url.toString(), { max: 1 })
      if (mode === 'drizzle-startup') drizzle(client)
      connection = await client.reserve()
      await connection.unsafe(`
      CREATE TABLE work_styles(id text PRIMARY KEY,definition jsonb,yaml_template jsonb);
      CREATE TABLE squad_presets(id text PRIMARY KEY,work_styles jsonb,yaml_template jsonb,schedule_templates jsonb);
      CREATE TABLE squads(id uuid PRIMARY KEY,metadata jsonb);
      CREATE TABLE schedules(id uuid PRIMARY KEY,action jsonb);
      CREATE TABLE work_streams(id uuid PRIMARY KEY,metadata jsonb);
      CREATE TABLE work_stream_flow_runs(work_stream_id uuid PRIMARY KEY,profiles jsonb,source jsonb,state jsonb);
      CREATE TABLE work_style_bindings(agent_id uuid PRIMARY KEY,profile jsonb,binding_key text);
      CREATE TABLE work_stream_flow_transitions(work_stream_id uuid,request_id uuid,command jsonb,request_hash text,PRIMARY KEY(work_stream_id,request_id));
      CREATE TABLE assistant_conversations(id uuid PRIMARY KEY,editor jsonb);
    `)
      const source = { kind: 'inline', definition: legacy }
      await connection`INSERT INTO work_styles VALUES ('custom',${JSON.stringify(legacy)}::text::jsonb,${JSON.stringify({ definition: legacy })}::text::jsonb)`
      await connection`INSERT INTO squad_presets VALUES ('custom',${JSON.stringify({ default: source, choices: [{ source: { kind: 'preset', id: 'solo', customizations: [customization] } }] })}::text::jsonb,${JSON.stringify({ workStyles: { default: source } })}::text::jsonb,${JSON.stringify([{ action: { workStyle: source } }])}::text::jsonb)`
      await connection`INSERT INTO squads VALUES (${id},${JSON.stringify({ workStyle: source, profile: 'untouched' })}::text::jsonb)`
      await connection`INSERT INTO schedules VALUES (${id},${JSON.stringify({ type: 'create_work_stream', workStyle: source })}::text::jsonb)`
      await connection`INSERT INTO work_streams VALUES (${id},${JSON.stringify({ workStyle: source })}::text::jsonb)`
      const state = {
        definition: legacy,
        attempts: [{ id: 1, step: { kind: 'agent', participant: 'worker' }, participant: legacy.participants.worker }],
      }
      await connection`INSERT INTO work_stream_flow_runs VALUES (${id},${JSON.stringify({ worker: snapshot, 'attempt:1': snapshot })}::text::jsonb,${JSON.stringify({ source, definition: legacy })}::text::jsonb,${JSON.stringify(state)}::text::jsonb)`
      await connection`INSERT INTO work_style_bindings VALUES (${id},${JSON.stringify(snapshot)}::text::jsonb,'worker:unchanged:reuse-0')`
      const otherId = crypto.randomUUID()
      for (const [streamId, requestId] of [
        [id, id],
        [id, otherId],
        [otherId, id],
      ])
        await connection`INSERT INTO work_stream_flow_transitions VALUES (${streamId},${requestId},${JSON.stringify(command)}::text::jsonb,${legacyFingerprint({ command, actorKey: 'owner' })})`
      await connection`INSERT INTO assistant_conversations VALUES (${id},${JSON.stringify({ kind: 'work-style', document: legacy, proposal: { document: legacy } })}::text::jsonb)`
    })
    afterAll(async () => {
      connection?.release()
      await client?.end()
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        await admin.end()
      }
    })
    test('atomically upgrades catalog, defaults, commands, attempts, and drafts without replacing pinned agents', async () => {
      await expect(
        applyMigrations(connection, { ...target, sql: [...target.sql, 'SELECT * FROM intentionally_missing'] })
      ).rejects.toThrow()
      expect((await connection`SELECT definition FROM work_styles`)[0]!.definition).toEqual(legacy)
      await applyMigrations(connection, target)
      const row = (await connection`SELECT * FROM work_styles`)[0]!
      expect(workflowDefinitionSchema.parse(row.definition)).toEqual(current)
      expect(row.yaml_template.definition).toEqual(current)
      const preset = (await connection`SELECT * FROM squad_presets`)[0]!
      expect(preset.work_styles.default.definition).toEqual(current)
      expect(preset.work_styles.choices[0].source.customizations[0].participant).toHaveProperty(
        'agentTypeId',
        'general'
      )
      expect(preset.yaml_template.workStyles.default.definition).toEqual(current)
      expect(preset.schedule_templates[0].action.workStyle.definition).toEqual(current)
      for (const table of ['squads', 'work_streams'])
        expect((await connection.unsafe(`SELECT metadata FROM ${table}`))[0]!.metadata.workStyle.definition).toEqual(
          current
        )
      expect((await connection`SELECT metadata FROM squads`)[0]!.metadata.profile).toBe('untouched')
      expect((await connection`SELECT action FROM schedules`)[0]!.action.workStyle.definition).toEqual(current)
      const run = (await connection`SELECT * FROM work_stream_flow_runs`)[0]!
      expect(run.participant_snapshots).toEqual({ worker: snapshot, 'attempt:1': snapshot })
      expect(run.source.definition).toEqual(current)
      expect(run.source.source.definition).toEqual(current)
      expect(run.state.definition).toEqual(current)
      expect(run.state.attempts[0].participant).toEqual(current.participants.worker)
      const binding = (await connection`SELECT * FROM work_style_bindings`)[0]!
      expect(binding.agent_snapshot).toEqual(snapshot)
      expect(binding.binding_key).toBe('worker:unchanged:reuse-0')
      const receipts = await connection`SELECT * FROM work_stream_flow_transitions`
      expect(receipts).toHaveLength(3)
      for (const receipt of receipts) {
        expect(receipt.command.participant).toEqual(current.participants.worker)
        expect(receipt.request_hash).toBe(workflowFingerprint({ command: receipt.command, actorKey: 'owner' }))
      }
      const editor = (await connection`SELECT editor FROM assistant_conversations`)[0]!.editor
      expect(editor.document).toEqual(current)
      expect(editor.proposal.document).toEqual(current)
      await applyMigrations(connection, target)
      expect((await connection`SELECT state FROM work_stream_flow_runs`)[0]!.state).toEqual(run.state)
    })
  })
