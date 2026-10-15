import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from '../../db'

// Apply the generated migration's own SQL to isolated copies of the ledger tables, never to the shared ones.
const migration = await Bun.file(
  new URL('../../../drizzle/0217_backfilled_agent_turns_unbilled.sql', import.meta.url)
).text()
const statements = migration.split('--> statement-breakpoint').filter((statement) => statement.trim())

test('backfilled agent turns stop billing (list cost kept); decisions, live rows and other rollups are unchanged; re-runnable', async () => {
  const namespace = `ledger_unbilled_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${namespace}"`))
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${namespace}", public`))
      await tx.execute(sql.raw(`CREATE TABLE "inference_usage" (LIKE public.inference_usage INCLUDING DEFAULTS)`))
      await tx.execute(
        sql.raw(`CREATE TABLE "inference_usage_daily" (LIKE public.inference_usage_daily INCLUDING DEFAULTS)`)
      )
      // dedupe_key, feature, provider, billing, cost, list cost
      await tx.execute(
        sql.raw(`
          INSERT INTO "inference_usage"
            ("dedupe_key", "feature", "provider", "billing", "cost_nanodollars", "list_cost_nanodollars")
          VALUES
            ('exec:e1', 'agent-turn', NULL, 'unknown', 900, 900),
            ('agent-gap:a1', 'agent-turn', NULL, 'unknown', 300, 300),
            ('decision_log:d1', 'decision:triage', NULL, 'api', 42, 42),
            ('decision_log:d2', 'decision:triage', NULL, 'unknown', 0, NULL),
            (NULL, 'agent-turn', 'anthropic', 'api', 500, 500),
            (NULL, 'agent-turn', 'openai-codex', 'subscription', 0, 700)
        `)
      )
      await tx.execute(
        sql.raw(`
          INSERT INTO "inference_usage_daily"
            ("day", "feature", "provider", "billing", "calls", "cost_nanodollars", "list_cost_nanodollars")
          VALUES
            ('2026-08-01', 'agent-turn', NULL, 'unknown', 3, 1200, 1200),
            ('2026-08-01', 'decision:triage', NULL, 'api', 1, 42, 42),
            ('2026-08-01', 'agent-turn', 'anthropic', 'api', 2, 500, 500),
            ('2026-08-01', 'agent-turn', 'openai-codex', 'subscription', 4, 0, 700)
        `)
      )
      const perCall = async () =>
        Object.fromEntries(
          (
            await tx.execute(
              sql.raw(
                `SELECT coalesce("dedupe_key", "provider") AS key, "cost_nanodollars" AS cost, "list_cost_nanodollars" AS list
                 FROM "${namespace}"."inference_usage"`
              )
            )
          ).map((row) => [row.key as string, [Number(row.cost), row.list === null ? null : Number(row.list)]])
        )
      const rollups = async () =>
        Object.fromEntries(
          (
            await tx.execute(
              sql.raw(
                `SELECT "feature" || '/' || coalesce("provider", '-') AS key, "cost_nanodollars" AS cost,
                   "list_cost_nanodollars" AS list
                 FROM "${namespace}"."inference_usage_daily"`
              )
            )
          ).map((row) => [row.key as string, [Number(row.cost), Number(row.list)]])
        )
      const expected = {
        perCall: {
          'exec:e1': [0, 900],
          'agent-gap:a1': [0, 300],
          'decision_log:d1': [42, 42],
          'decision_log:d2': [0, null],
          anthropic: [500, 500],
          'openai-codex': [0, 700],
        },
        rollups: {
          'agent-turn/-': [0, 1200],
          'decision:triage/-': [42, 42],
          'agent-turn/anthropic': [500, 500],
          'agent-turn/openai-codex': [0, 700],
        },
      }

      for (const statement of statements) await tx.execute(sql.raw(statement))
      expect(await perCall()).toEqual(expected.perCall)
      expect(await rollups()).toEqual(expected.rollups)

      // Applying it again is a no-op.
      for (const statement of statements) await tx.execute(sql.raw(statement))
      expect(await perCall()).toEqual(expected.perCall)
      expect(await rollups()).toEqual(expected.rollups)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
