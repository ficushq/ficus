import { backfillWorkStreamNumbers } from './work-stream-number-backfill'
import { migrateChannelConsultants, migrateAssistantAgentBindings } from './channel-consultant-backfill'
import { migrateWorkStyleParticipants } from './work-style-participant-backfill'
import { detachSquadPresets } from './squad-preset-backfill'
import { preserveAgentExpertise } from './agent-expertise-backfill'
import type { MigrationConfig, MigrationMeta } from 'drizzle-orm/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { backfillMessageEnqueueOrder } from './message-enqueue-order-backfill'
import { backfillTrackedIssues } from './tracked-issue-backfill'
import { backfillAssistantActivity } from './assistant-activity-backfill'
import { backfillAssistantConversationKinds } from './assistant-conversation-kind-backfill'
import { reportLegacySecretRowConflicts } from './legacy-secret-rows'

const CREATE_CONCURRENT_INDEX =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+"([^"]+)"\s+ON\s+(?:ONLY\s+)?(?:(?:"([^"]+)"\.)?)"([^"]+)"/i

export type MigrationClassification =
  | { kind: 'transactional' }
  | { kind: 'concurrent-index'; indexName: string; tableSchema: string; tableName: string }

function isCommentOnly(sql: string): boolean {
  for (let index = 0; index < sql.length; ) {
    if (/\s/.test(sql[index])) {
      index += 1
      continue
    }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else index += 1
      }
      if (depth) return false
      continue
    }
    return false
  }
  return true
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  let dollarTag: string | null = null
  let lineComment = false
  let blockCommentDepth = 0
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockCommentDepth) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1
        index += 1
      } else if (char === '*' && next === '/') {
        blockCommentDepth -= 1
        index += 1
      }
      continue
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1
        dollarTag = null
      }
      continue
    }
    if (quote) {
      // PostgreSQL E'...' strings always support backslash escapes. Treat them
      // the same way for ordinary strings so classification is also correct
      // when standard_conforming_strings is disabled on the server.
      if (quote === "'" && char === '\\') {
        index += 1
        continue
      }
      if (char === quote && next === quote) {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockCommentDepth = 1
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match) {
        dollarTag = match[0]
        index += dollarTag.length - 1
        continue
      }
    }
    if (char === ';') {
      const statement = sql.slice(start, index).trim()
      if (statement && !isCommentOnly(statement)) statements.push(statement)
      start = index + 1
    }
  }
  const trailing = sql.slice(start).trim()
  if (trailing && !isCommentOnly(trailing)) statements.push(trailing)
  return statements
}

export function classifyMigration(migration: MigrationMeta): MigrationClassification {
  const statements = migration.sql.flatMap(splitSqlStatements)
  const matches = statements.map((value) => value.match(CREATE_CONCURRENT_INDEX)).filter((match) => match !== null)

  if (matches.length === 0) {
    if (statements.some((statement) => /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement))) {
      throw new Error('Unsupported CREATE INDEX CONCURRENTLY statement')
    }
    return { kind: 'transactional' }
  }
  if (statements.length !== 1 || matches.length !== 1) {
    throw new Error('Concurrent index migration must contain exactly one CREATE INDEX CONCURRENTLY statement')
  }

  const [, indexName, explicitSchema, tableName] = matches[0]
  return { kind: 'concurrent-index', indexName, tableSchema: explicitSchema ?? 'public', tableName }
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

type MigrationRunnerConfig = Pick<MigrationConfig, 'migrationsSchema' | 'migrationsTable'>
type QueryConnection = postgres.ReservedSql

// postgres.js 3.4.8 declares begin() on ReservedSql but omits it from the
// reserved runtime object. Explicit control statements keep these short
// transactions on the same connection that owns the advisory lock.
async function inTransaction<T>(connection: postgres.ReservedSql, callback: () => Promise<T>): Promise<T> {
  await connection.unsafe('BEGIN')
  try {
    const result = await callback()
    await connection.unsafe('COMMIT')
    return result
  } catch (error) {
    await connection.unsafe('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function prepareLedger(connection: postgres.ReservedSql, schema: string, table: string): Promise<void> {
  const qualifiedLedger = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  const qualifiedIntents = `${quoteIdentifier(schema)}.${quoteIdentifier('__tau_online_migration_intents')}`
  await connection.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`)
  await connection.unsafe(`
    CREATE TABLE IF NOT EXISTS ${qualifiedLedger} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`)
  await connection.unsafe(`
    CREATE TABLE IF NOT EXISTS ${qualifiedIntents} (
      created_at bigint PRIMARY KEY,
      hash text NOT NULL,
      table_schema text NOT NULL,
      index_name text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now()
    )`)
}

async function insertLedger(
  connection: QueryConnection,
  qualifiedLedger: string,
  migration: MigrationMeta
): Promise<void> {
  await connection.unsafe(`INSERT INTO ${qualifiedLedger} (hash, created_at) VALUES ($1, $2)`, [
    migration.hash,
    migration.folderMillis,
  ])
}

async function findIndex(connection: QueryConnection, schema: string, indexName: string) {
  const rows = await connection<
    { indisvalid: boolean; indisready: boolean; definition: string; table_name: string; table_schema: string }[]
  >`SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition,
           table_class.relname AS table_name, table_namespace.nspname AS table_schema
    FROM pg_catalog.pg_class index_class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index i ON i.indexrelid = index_class.oid
    JOIN pg_catalog.pg_class table_class ON table_class.oid = i.indrelid
    JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = ${schema} AND index_class.relname = ${indexName}`
  return rows[0]
}

interface IndexSignature {
  indisunique: boolean
  indnullsnotdistinct: boolean
  indisexclusion: boolean
  indimmediate: boolean
  reloptions: string[] | null
  reltablespace: number
  indnkeyatts: number
  indnatts: number
  access_method: string
  keys: string[]
  indcollation: string
  indclass: string
  indoption: string
  expressions: string | null
  predicate: string | null
}

async function indexSignature(connection: QueryConnection, schema: string, indexName: string) {
  const rows = await connection<IndexSignature[]>`SELECT i.indisunique, i.indnullsnotdistinct,
      i.indisexclusion, i.indimmediate, index_class.reloptions, index_class.reltablespace,
      i.indnkeyatts, i.indnatts, access_method.amname AS access_method,
      ARRAY(SELECT CASE WHEN key.attnum = 0 THEN '<expression>' ELSE attribute.attname END
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, position)
        LEFT JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = i.indrelid AND attribute.attnum = key.attnum
        ORDER BY key.position) AS keys,
      i.indcollation::text, i.indclass::text, i.indoption::text,
      pg_get_expr(i.indexprs, i.indrelid) AS expressions,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_catalog.pg_class index_class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index i ON i.indexrelid = index_class.oid
    JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
    WHERE namespace.nspname = ${schema} AND index_class.relname = ${indexName}`
  return rows[0]
}

async function expectedIndexSignature(
  connection: postgres.ReservedSql,
  statement: string,
  classification: Extract<MigrationClassification, { kind: 'concurrent-index' }>
): Promise<IndexSignature> {
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const shadowTable = `__tau_index_definition_${suffix}`
  const shadowIndex = `__tau_index_definition_idx_${suffix}`
  const sourceTable = `${quoteIdentifier(classification.tableSchema)}.${quoteIdentifier(classification.tableName)}`
  const prefix = statement.match(CREATE_CONCURRENT_INDEX)
  if (!prefix) throw new Error('Unsupported CREATE INDEX CONCURRENTLY statement')
  const unique = /^\s*CREATE\s+UNIQUE\s+/i.test(statement) ? 'UNIQUE ' : ''
  const shadowStatement = `CREATE ${unique}INDEX ${quoteIdentifier(shadowIndex)} ON ${quoteIdentifier(shadowTable)}${statement.slice(prefix[0].length)}`
  await connection.unsafe(`CREATE TEMP TABLE ${quoteIdentifier(shadowTable)} (LIKE ${sourceTable})`)
  try {
    await connection.unsafe(shadowStatement)
    const [temporaryNamespace] = await connection<{ name: string }[]>`SELECT nspname AS name
      FROM pg_namespace WHERE oid = pg_my_temp_schema()`
    const signature = await indexSignature(connection, temporaryNamespace.name, shadowIndex)
    if (!signature) throw new Error('Failed to inspect expected concurrent index definition')
    return signature
  } finally {
    await connection.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(shadowTable)} CASCADE`)
  }
}

async function applyConcurrentMigration(
  connection: postgres.ReservedSql,
  migration: MigrationMeta,
  classification: Extract<MigrationClassification, { kind: 'concurrent-index' }>,
  qualifiedLedger: string,
  qualifiedIntents: string
): Promise<void> {
  const { tableSchema, tableName, indexName } = classification
  const statement = migration.sql.map((value) => value.trim()).find(Boolean)
  if (!statement) throw new Error('Concurrent index migration has no statement')
  const intents = await connection.unsafe<{ hash: string; table_schema: string; index_name: string }[]>(
    `SELECT hash, table_schema, index_name FROM ${qualifiedIntents} WHERE created_at = $1`,
    [migration.folderMillis]
  )
  const intent = intents[0]
  let index: Awaited<ReturnType<typeof findIndex>> | undefined = await findIndex(connection, tableSchema, indexName)

  if (intent) {
    if (intent.hash !== migration.hash || intent.table_schema !== tableSchema || intent.index_name !== indexName) {
      throw new Error(`Online migration intent does not match migration ${migration.folderMillis}`)
    }
  } else {
    if (index) {
      throw new Error(`Unexpected existing index ${tableSchema}.${indexName}`)
    }
    await inTransaction(connection, async () => {
      await connection.unsafe(
        `INSERT INTO ${qualifiedIntents} (created_at, hash, table_schema, index_name) VALUES ($1, $2, $3, $4)`,
        [migration.folderMillis, migration.hash, tableSchema, indexName]
      )
    })
  }

  if (index?.indisvalid && index.indisready) {
    const actualSignature = await indexSignature(connection, tableSchema, indexName)
    const expectedSignature = await expectedIndexSignature(connection, statement, classification)
    if (
      index.table_schema !== tableSchema ||
      index.table_name !== tableName ||
      !actualSignature ||
      JSON.stringify(actualSignature) !== JSON.stringify(expectedSignature)
    ) {
      throw new Error(`Existing index ${tableSchema}.${indexName} does not match the intended migration definition`)
    }
  }

  if (index && (!index.indisvalid || !index.indisready)) {
    await connection.unsafe(`DROP INDEX CONCURRENTLY ${quoteIdentifier(tableSchema)}.${quoteIdentifier(indexName)}`)
    index = undefined
  }
  if (!index) {
    await connection.unsafe(statement)
    index = await findIndex(connection, tableSchema, indexName)
  }
  if (!index?.indisvalid || !index.indisready) {
    throw new Error(`Concurrent index ${tableSchema}.${indexName} is not valid and ready`)
  }

  await inTransaction(connection, async () => {
    await insertLedger(connection, qualifiedLedger, migration)
    await connection.unsafe(`DELETE FROM ${qualifiedIntents} WHERE created_at = $1`, [migration.folderMillis])
  })
}

export async function applyMigrations(
  connection: postgres.ReservedSql,
  migrations: MigrationMeta | MigrationMeta[],
  config: MigrationRunnerConfig = {}
): Promise<void> {
  const schema = config.migrationsSchema ?? 'drizzle'
  const table = config.migrationsTable ?? '__drizzle_migrations'
  const qualifiedLedger = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  const qualifiedIntents = `${quoteIdentifier(schema)}.${quoteIdentifier('__tau_online_migration_intents')}`
  await prepareLedger(connection, schema, table)

  const latest = await connection.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedLedger} ORDER BY created_at DESC LIMIT 1`
  )
  const lastCreatedAt = latest[0]?.created_at
  const pending = (Array.isArray(migrations) ? migrations : [migrations]).filter(
    (migration) => lastCreatedAt == null || Number(lastCreatedAt) < migration.folderMillis
  )

  for (let index = 0; index < pending.length; ) {
    const classification = classifyMigration(pending[index])
    if (classification.kind === 'concurrent-index') {
      await applyConcurrentMigration(connection, pending[index], classification, qualifiedLedger, qualifiedIntents)
      index += 1
      continue
    }

    const ordinary: MigrationMeta[] = []
    while (index < pending.length && classifyMigration(pending[index]).kind === 'transactional') {
      ordinary.push(pending[index])
      index += 1
    }
    await inTransaction(connection, async () => {
      for (const migration of ordinary) {
        // Backfills belong immediately before their DDL, even when several
        // generated migrations are consolidated into one file. Flush preceding
        // SQL first so the historical tables/columns exist at each boundary.
        let statements: string[] = []
        const flush = async () => {
          if (statements.some((statement) => statement.trim())) {
            // The newline also terminates trailing -- comments between fragments.
            await connection.unsafe(statements.join('\n;\n'))
          }
          statements = []
        }
        for (const statement of migration.sql) {
          const backfill = /ALTER TABLE "work_streams" ALTER COLUMN "number" SET DEFAULT/.test(statement)
            ? backfillWorkStreamNumbers
            : /ALTER TABLE "agent_types" DROP COLUMN "flow_prompt"/.test(statement)
              ? preserveAgentExpertise
              : /ALTER TABLE "squad_types" RENAME TO "squad_presets"/.test(statement)
                ? detachSquadPresets
                : /ALTER TABLE "work_stream_flow_runs" RENAME COLUMN "profiles" TO "participant_snapshots"/.test(
                      statement
                    )
                  ? migrateWorkStyleParticipants
                  : /ALTER TABLE "channel_instances" DROP COLUMN "concierge_agent_id"/.test(statement)
                    ? migrateChannelConsultants
                    : /ALTER TABLE "assistant_conversations" DROP COLUMN "manager_agent_id"/.test(statement)
                      ? migrateAssistantAgentBindings
                      : // Runs after both activity tables, their constraints, and the allocator
                        // column exist; the first activity index follows them in the generated SQL.
                        /CREATE INDEX "idx_assistant_tasks_conversation_updated"/.test(statement)
                        ? backfillAssistantActivity
                        : // Names any existing FICUS_ row the Ficus-rename copy keeps instead of its TAU_ source.
                          /INSERT INTO "secrets" \("key"[\s\S]*'TAU_PASSWORD'/.test(statement)
                          ? reportLegacySecretRowConflicts
                          : undefined
          if (backfill) {
            await flush()
            await backfill(connection)
          }
          statements.push(statement)
          // Some transforms need the column they populate; they run right after their DDL.
          if (/ALTER TABLE "assistant_conversations" ADD COLUMN "kind"/.test(statement)) {
            await flush()
            await backfillAssistantConversationKinds(connection)
          }
        }
        await flush()
        await insertLedger(connection, qualifiedLedger, migration)
      }
    })
  }
}

export async function migrateDatabase(connection: postgres.ReservedSql, config: MigrationConfig): Promise<void> {
  await applyMigrations(connection, readMigrationFiles(config), config)
  await backfillMessageEnqueueOrder(connection)
  await backfillTrackedIssues(connection)
}
