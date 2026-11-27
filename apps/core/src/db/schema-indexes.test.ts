import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'path'
import { createPostgresConnection } from './connection'
import { applyMigrations, classifyMigration } from './migrator'
import { MONOREPO_ROOT } from '../lib/paths'
import * as schema from './schema'
import { db } from './index'
import { scheduleDueCondition } from '../entities/Schedule'
import {
  inbox,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
  messages,
  operationsExecutionAnalyses,
  operationsRecommendationEvidence,
  operationsRecommendations,
  schedules,
  systemInboxReads,
} from './schema'

type IndexColumn = {
  name: string
  order: string
}

function indexColumnsByName(table: Parameters<typeof getTableConfig>[0]): Map<string, IndexColumn[]> {
  const indexes = new Map<string, IndexColumn[]>()

  for (const idx of getTableConfig(table).indexes) {
    if (!idx.config.name) continue

    indexes.set(
      idx.config.name,
      idx.config.columns.map((column) => {
        const indexedColumn = column as { name: string; indexConfig?: { order?: string } }
        return {
          name: indexedColumn.name,
          order: indexedColumn.indexConfig?.order ?? 'asc',
        }
      })
    )
  }

  return indexes
}

describe('sandbox recovery notification schema', () => {
  test('splits transactional ledger work from the single concurrent hot-table index', () => {
    const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
    const recoveryMigrations = migrations.filter((migration) =>
      migration.sql.some(
        (statement) =>
          statement.includes('sandbox_recovery_episodes') ||
          statement.includes('idx_messages_agent_sandbox_recovery_unique')
      )
    )

    expect(recoveryMigrations).toHaveLength(2)
    expect(recoveryMigrations.map(classifyMigration)).toEqual([
      { kind: 'transactional' },
      {
        kind: 'concurrent-index',
        indexName: 'idx_messages_agent_sandbox_recovery_unique',
        tableSchema: 'public',
        tableName: 'messages',
      },
    ])
    expect(recoveryMigrations[1]?.sql).toHaveLength(1)
    expect(recoveryMigrations[1]?.sql[0]).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "idx_messages_agent_sandbox_recovery_unique"'
    )
  })

  test('defines durable episode, subscription, and message identity indexes', () => {
    expect(schema.sandboxRecoveryEpisodes).toBeDefined()
    expect(schema.sandboxRecoverySubscriptions).toBeDefined()
    if (!schema.sandboxRecoveryEpisodes || !schema.sandboxRecoverySubscriptions) return

    expect(
      indexColumnsByName(schema.sandboxRecoveryEpisodes).has('idx_sandbox_recovery_episode_generation_unique')
    ).toBe(true)
    expect(indexColumnsByName(schema.sandboxRecoveryEpisodes).has('idx_sandbox_recovery_episode_open_unique')).toBe(
      true
    )
    expect(
      indexColumnsByName(schema.sandboxRecoverySubscriptions).has('idx_sandbox_recovery_subscriptions_agent_state')
    ).toBe(true)
    expect(
      indexColumnsByName(schema.sandboxRecoverySubscriptions).has(
        'idx_sandbox_recovery_subscriptions_notification_unique'
      )
    ).toBe(true)
    expect(indexColumnsByName(messages).has('idx_messages_agent_sandbox_recovery_unique')).toBe(true)
  })
})

describe('message enqueue order migration shape', () => {
  test('journal-resolved migrations keep the nullable/backfill/default/index rollout order', () => {
    const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
    const enqueueMigrations = migrations.filter((migration) =>
      migration.sql.some((sql) => sql.includes('enqueue_order') && sql.includes('messages'))
    )

    expect(enqueueMigrations).toHaveLength(4)
    const migrationSql = enqueueMigrations.map((migration) => migration.sql.join('\n'))
    expect(migrationSql[0]).toContain('ADD COLUMN "enqueue_order" bigint')
    expect(migrationSql[0]).not.toContain('DEFAULT')
    expect(migrationSql[1]).toContain('ALTER COLUMN "enqueue_order" SET DEFAULT')
    expect(migrationSql.every((statement) => !/UPDATE\s+"?messages"?/i.test(statement))).toBe(true)
    expect(enqueueMigrations[2]!.sql).toHaveLength(1)
    expect(enqueueMigrations[3]!.sql).toHaveLength(1)
    expect(enqueueMigrations.map(classifyMigration)).toEqual([
      { kind: 'transactional' },
      { kind: 'transactional' },
      {
        kind: 'concurrent-index',
        indexName: 'idx_messages_enqueue_order_unique',
        tableSchema: 'public',
        tableName: 'messages',
      },
      {
        kind: 'concurrent-index',
        indexName: 'idx_messages_pending_uninjected_fifo',
        tableSchema: 'public',
        tableName: 'messages',
      },
    ])
  })
})

describe('instance maintenance schema', () => {
  test('defines the singleton state and chronological audit index', () => {
    expect(getTableConfig(instanceMaintenanceState).name).toBe('instance_maintenance_state')
    expect(instanceMaintenanceAudit.metadata).toBeDefined()
    expect(indexColumnsByName(instanceMaintenanceAudit).get('idx_instance_maintenance_audit_created_at')).toEqual([
      { name: 'created_at', order: 'asc' },
    ])
  })
})

describe('inbox pagination database indexes', () => {
  test('defines indexes that match inbox pagination query patterns', () => {
    expect(indexColumnsByName(inbox).get('idx_inbox_recipient_pagination')).toEqual([
      { name: 'recipient_type', order: 'asc' },
      { name: 'recipient_id', order: 'asc' },
      { name: 'created_at', order: 'asc' },
      { name: 'id', order: 'asc' },
    ])
    expect(indexColumnsByName(inbox).get('idx_inbox_system_pagination')).toEqual([
      { name: 'recipient_type', order: 'asc' },
      { name: 'created_at', order: 'asc' },
      { name: 'id', order: 'asc' },
    ])
    expect(indexColumnsByName(systemInboxReads).get('idx_system_inbox_reads_user_message')).toEqual([
      { name: 'user_id', order: 'asc' },
      { name: 'message_id', order: 'asc' },
    ])
  })
})

describe('operations analyst database indexes', () => {
  test('stream-group prefix index uses the pattern operator class', async () => {
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
    const connection = await client.reserve()
    const ledgerSchema = `schema_index_test_${crypto.randomUUID().replaceAll('-', '')}`
    let lockHeld = false
    try {
      await connection`SELECT pg_advisory_lock(8675309)`
      lockHeld = true
      await connection.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_messages_agent_stream_group_pattern"')
      const generatedMigration = readMigrationFiles({
        migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle'),
      }).find((migration) => {
        const classification = classifyMigration(migration)
        return (
          classification.kind === 'concurrent-index' &&
          classification.indexName === 'idx_messages_agent_stream_group_pattern'
        )
      })
      expect(generatedMigration).toBeDefined()
      await applyMigrations(connection, generatedMigration!, { migrationsSchema: ledgerSchema })

      const rows = await connection<
        { indisvalid: boolean; indisready: boolean; predicate: string; opclasses: string[] }[]
      >`SELECT i.indisvalid,
               i.indisready,
               pg_get_expr(i.indpred, i.indrelid) AS predicate,
               array_agg(opc.opcname ORDER BY classes.ordinality) AS opclasses
        FROM pg_class index_class
        JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
        JOIN pg_index i ON i.indexrelid = index_class.oid
        JOIN LATERAL unnest(i.indclass) WITH ORDINALITY AS classes(opclass_oid, ordinality) ON true
        JOIN pg_opclass opc ON opc.oid = classes.opclass_oid
        WHERE namespace.nspname = 'public'
          AND index_class.relname = 'idx_messages_agent_stream_group_pattern'
        GROUP BY i.indisvalid, i.indisready, i.indpred, i.indrelid`
      expect(rows).toHaveLength(1)
      expect(rows[0]?.opclasses).toEqual(['uuid_ops', 'text_pattern_ops'])
      expect(rows[0]?.indisvalid).toBe(true)
      expect(rows[0]?.indisready).toBe(true)
      expect(rows[0]?.predicate).toContain("role = 'assistant'")
      expect(rows[0]?.predicate).toContain('streamGroupId')
    } finally {
      try {
        await connection.unsafe(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`)
      } finally {
        if (lockHeld) await connection`SELECT pg_advisory_unlock(8675309)`
        connection.release()
        await client.end()
      }
    }
  })

  test('defines recommendation aggregation and source lookup indexes', () => {
    expect(
      indexColumnsByName(operationsRecommendations).get('idx_operations_recommendations_squad_status_last_seen')
    ).toEqual([
      { name: 'squad_id', order: 'asc' },
      { name: 'status', order: 'asc' },
      { name: 'last_seen_at', order: 'asc' },
    ])
    expect(
      indexColumnsByName(operationsRecommendationEvidence).get('idx_operations_recommendation_evidence_observed')
    ).toEqual([
      { name: 'recommendation_id', order: 'asc' },
      { name: 'observed_at', order: 'asc' },
    ])
    expect(
      getTableConfig(operationsExecutionAnalyses).columns.find((column) => column.name === 'execution_id')?.primary
    ).toBe(true)
    expect(
      getTableConfig(operationsRecommendations).uniqueConstraints[0]?.columns.map((column) => column.name)
    ).toEqual(['squad_id', 'fingerprint'])
    expect(
      getTableConfig(operationsRecommendationEvidence).uniqueConstraints[0]?.columns.map((column) => column.name)
    ).toEqual(['recommendation_id', 'execution_id'])
    expect(indexColumnsByName(messages).get('idx_messages_agent_stream_group')).toBeDefined()
    expect(indexColumnsByName(messages).get('idx_messages_agent_inbox_consumed')).toBeDefined()
  })
})

describe('schedule due-scan database indexes', () => {
  // `Schedule.listDue()` runs every 30s and had no index at all: an unbounded
  // OR scan of `schedules` whose second arm casts a jsonb text field to
  // timestamptz. The migration adds the pair the planner needs.
  const scheduleIndexMigration = () =>
    readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') }).find((migration) =>
      migration.sql.some((statement) => statement.includes('idx_schedules_schedule_expires_at'))
    )

  test('generates both listDue index arms as one transactional migration', () => {
    const migration = scheduleIndexMigration()
    expect(migration).toBeDefined()
    const statements = migration!.sql.join('\n')
    expect(statements).toContain(
      'CREATE INDEX "idx_schedules_next_trigger_due" ON "schedules" USING btree ("next_trigger_at") WHERE "schedules"."enabled" = true AND "schedules"."next_trigger_at" IS NOT NULL'
    )
    // Not a partial index and not on the timestamptz value: `(text)::timestamptz`
    // is STABLE, so Postgres rejects it in an index expression or predicate, and
    // a partial index's expression stats would make the planner ignore it.
    expect(statements).toContain(
      `CREATE INDEX "idx_schedules_schedule_expires_at" ON "schedules" USING btree (("schedule"->>'expiresAt'))`
    )
    expect(statements).not.toContain('idx_schedules_schedule_expires_at" ON "schedules" USING btree ((("schedule')
    expect(classifyMigration(migration!)).toEqual({ kind: 'transactional' })
  })

  test('Postgres accepts both indexes and reaches the real listDue predicate through them', async () => {
    const migration = scheduleIndexMigration()
    expect(migration).toBeDefined()
    const client = createPostgresConnection(process.env.DATABASE_URL!, { max: 1 })
    const connection = await client.reserve()
    const ledgerSchema = `schedule_index_test_${crypto.randomUUID().replaceAll('-', '')}`
    const fixtureSchema = `schedule_fixture_${crypto.randomUUID().replaceAll('-', '')}`
    try {
      // Run the real migration against an owned table, whether the shared test
      // database already has these indexes or drizzle push omitted them.
      await connection.unsafe(`CREATE SCHEMA "${fixtureSchema}"`)
      await connection.unsafe(`CREATE TABLE "${fixtureSchema}".schedules (LIKE public.schedules INCLUDING DEFAULTS)`)
      await connection.unsafe(`SET search_path TO "${fixtureSchema}", public`)
      await applyMigrations(connection, migration!, { migrationsSchema: ledgerSchema })

      const created = await connection<{ relname: string; indisvalid: boolean }[]>`
        SELECT index_class.relname, i.indisvalid
        FROM pg_class index_class
        JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
        JOIN pg_index i ON i.indexrelid = index_class.oid
        WHERE namespace.nspname = ${fixtureSchema}
          AND index_class.relname IN ('idx_schedules_next_trigger_due', 'idx_schedules_schedule_expires_at')
        ORDER BY index_class.relname`
      expect(created.map((row) => row.relname)).toEqual([
        'idx_schedules_next_trigger_due',
        'idx_schedules_schedule_expires_at',
      ])
      expect(created.every((row) => row.indisvalid)).toBe(true)

      // EXPLAIN the exact query the scheduler runs. Sequential scans are
      // disabled so the assertion is about reachability — whether the planner
      // CAN satisfy both OR arms from indexes — not about a cost estimate that
      // would swing with whatever rows the suite happens to have left behind.
      const listDue = db.select().from(schedules).where(scheduleDueCondition(new Date()))
      const { sql: text, params } = listDue.toSQL()
      await connection.unsafe('SET enable_seqscan = off')
      const explained = await connection.unsafe(`EXPLAIN (FORMAT TEXT) ${text}`, params as never[])
      const plan = explained.map((row) => Object.values(row)[0]).join('\n')
      expect(plan).toContain('BitmapOr')
      expect(plan).toContain('idx_schedules_next_trigger_due')
      expect(plan).toContain('idx_schedules_schedule_expires_at')
    } finally {
      try {
        await connection.unsafe('RESET enable_seqscan')
        await connection.unsafe('RESET search_path')
        await connection.unsafe(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`)
        await connection.unsafe(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`)
      } finally {
        connection.release()
        await client.end()
      }
    }
  })
})

describe('chat execution lookup index migration', () => {
  test('builds the execution lookup index concurrently in an isolated migration', () => {
    const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
    const matching = migrations.filter((migration) =>
      migration.sql.some((statement) => statement.includes('idx_messages_agent_execution'))
    )
    expect(matching).toHaveLength(1)
    expect(classifyMigration(matching[0])).toEqual({
      kind: 'concurrent-index',
      indexName: 'idx_messages_agent_execution',
      tableSchema: 'public',
      tableName: 'messages',
    })
  })
})

describe('query audit follow-up migrations', () => {
  const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
  for (const indexName of [
    'idx_agents_top_level_squad_status_created',
    'idx_inbox_work_stream_id',
    'idx_executions_agent_run_runtime',
    'idx_messages_chat_source_page',
  ]) {
    test(`${indexName} has an isolated concurrent migration`, () => {
      const matching = migrations.filter((migration) =>
        migration.sql.some((statement) => statement.includes(`"${indexName}"`))
      )
      expect(matching).toHaveLength(1)
      expect(classifyMigration(matching[0]).kind).toBe('concurrent-index')
    })
  }
  test('builds the runtime covering index before dropping its redundant prefix', () => {
    const created = migrations.findIndex((migration) =>
      migration.sql.some((statement) => statement.includes('CREATE INDEX CONCURRENTLY "idx_executions_agent_runtime"'))
    )
    const dropped = migrations.findIndex((migration) =>
      migration.sql.some((statement) => statement.includes('DROP INDEX "idx_executions_agent_status_started_at"'))
    )
    expect(created).toBeGreaterThanOrEqual(0)
    expect(dropped).toBeGreaterThan(created)
  })
  test('builds the run-start runtime index before dropping the index it replaces', () => {
    const at = (needle: string) =>
      migrations.findIndex((migration) => migration.sql.some((statement) => statement.includes(needle)))
    const created = at('CREATE INDEX CONCURRENTLY "idx_executions_agent_run_runtime"')
    const dropped = at('DROP INDEX "idx_executions_agent_runtime"')
    expect(created).toBeGreaterThanOrEqual(0)
    expect(dropped).toBeGreaterThan(created)
    expect(classifyMigration(migrations[dropped]).kind).toBe('transactional')
  })
  test('generated execution IDs backfill old rows and follow metadata changes', async () => {
    const migration = migrations.find((item) =>
      item.sql.some((statement) => statement.includes('ADD COLUMN "activity_execution_id"'))
    )
    expect(migration).toBeDefined()
    const { sql } = await import('drizzle-orm')
    await db.transaction(async (tx) => {
      // Shadow only this connection's table; run the actual generated migration
      // against legacy rows without altering the shared test schema.
      await tx.execute(sql`CREATE TEMP TABLE messages (id int, metadata jsonb) ON COMMIT DROP`)
      await tx.execute(
        sql`INSERT INTO messages VALUES (1,'{"executionId":"old"}'), (2,'{}'), (3,'{"executionId":null}'), (4,NULL)`
      )
      for (const statement of migration!.sql) await tx.execute(sql.raw(statement))
      const rows = await tx.execute(sql`SELECT activity_execution_id FROM messages ORDER BY id`)
      expect(rows.map((row) => row.activity_execution_id)).toEqual(['old', null, null, null])
      await tx.execute(sql`UPDATE messages SET metadata='{"executionId":"new"}' WHERE id=1`)
      expect(
        (await tx.execute(sql`SELECT activity_execution_id FROM messages WHERE id=1`))[0].activity_execution_id
      ).toBe('new')
      await tx.execute(sql`UPDATE messages SET metadata=metadata-'executionId' WHERE id=1`)
      expect(
        (await tx.execute(sql`SELECT activity_execution_id FROM messages WHERE id=1`))[0].activity_execution_id
      ).toBeNull()
    })
  })
})
