import { sql } from 'drizzle-orm'
import { FARM_CHAT_RETENTION_DAYS } from '@ficus/shared'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'

/*
 * Farm chat keeps FARM_CHAT_RETENTION_DAYS of history: an hourly sweep deletes
 * older messages in bounded batches, by the database's clock. Rooms and read
 * markers stay (a quiet room is still a room).
 */

export const FARM_CHAT_PRUNE_INTERVAL_MS = 60 * 60_000
export const FARM_CHAT_PRUNE_BATCH_SIZE = 1_000
export const FARM_CHAT_PRUNE_MAX_BATCHES = 5

const log = createLogger('farm-chat-retention')

/** Deletes messages older than the retention window. Returns how many went. */
export async function pruneFarmChat(opts?: { now?: Date; batchSize?: number; maxBatches?: number }): Promise<number> {
  const batchSize = opts?.batchSize ?? FARM_CHAT_PRUNE_BATCH_SIZE
  const maxBatches = opts?.maxBatches ?? FARM_CHAT_PRUNE_MAX_BATCHES
  const now = opts?.now ? sql`${opts.now.toISOString()}::timestamptz` : sql`clock_timestamp()`
  let removed = 0
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await db.execute<{ id: string }>(sql`
      WITH old AS (
        SELECT id FROM farm_chat_messages
        WHERE created_at < ${now} - make_interval(days => ${FARM_CHAT_RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${batchSize}
      )
      DELETE FROM farm_chat_messages USING old WHERE farm_chat_messages.id = old.id
      RETURNING farm_chat_messages.id
    `)
    removed += deleted.length
    if (deleted.length < batchSize) break
  }
  if (removed) log.info(`Pruned ${removed} farm chat message(s) older than ${FARM_CHAT_RETENTION_DAYS} days`)
  return removed
}

let runner: PeriodicRunner | null = null

export function startFarmChatRetention(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'farm-chat-retention',
    intervalMs: FARM_CHAT_PRUNE_INTERVAL_MS,
    runImmediately: false,
    task: async () => {
      await pruneFarmChat()
    },
  })
  runner.start()
}

export async function stopFarmChatRetention(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
