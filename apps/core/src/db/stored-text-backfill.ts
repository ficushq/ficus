import type postgres from 'postgres'
import { STORED_TEXT_CANDIDATE, jsonStringChanges, rewriteStoredText } from './stored-text-rewrite'

/**
 * Task 36c, migration 0196: the stored rows that hold user or agent text a reader parses for entity
 * references (chat Markdown links, farm chat chips, activity-preview hrefs) or for the
 * memory_search provenance marker (tool results in chat history). Plain-text labels that no reader
 * parses (titles, summaries, notification bodies) and derived indexes (memory chunks, rebuilt from
 * their sources) are not listed. Signed or external payloads (AMTP envelopes, webhook bodies) are
 * never rewritten.
 */
export const STORED_TEXT_TARGETS: ReadonlyArray<{
  table: string
  key: readonly string[]
  text?: readonly string[]
  json?: readonly string[]
}> = [
  { table: 'messages', key: ['id'], text: ['content'], json: ['metadata'] },
  { table: 'executions', key: ['id'], text: ['message'] },
  { table: 'inbox', key: ['id'], text: ['content'] },
  { table: 'work_streams', key: ['id'], text: ['description', 'handoff_message'] },
  { table: 'agent_questions', key: ['id'], text: ['answer'], json: ['question_data'] },
  { table: 'farm_chat_messages', key: ['id'], text: ['body'] },
  { table: 'assistant_entries', key: ['id'], json: ['entry'] },
  { table: 'squad_activity', key: ['squad_id', 'lane', 'row_id'], json: ['preview'] },
  { table: 'schedules', key: ['id'], json: ['action'] },
]

const BATCH_SIZE = 200
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`

/**
 * Rewrites the listed columns in place, a keyset-paged batch at a time. Only the changed values are
 * written (jsonb_set per changed string), no timestamp is touched, and a second run finds nothing.
 */
export async function backfillStoredText(
  connection: postgres.ReservedSql,
  options: { batchSize?: number } = {}
): Promise<{ table: string; rows: number }[]> {
  const batchSize = options.batchSize ?? BATCH_SIZE
  const results: { table: string; rows: number }[] = []
  for (const target of STORED_TEXT_TARGETS) {
    const textColumns = target.text ?? []
    const jsonColumns = target.json ?? []
    const keyList = target.key.map(quote).join(', ')
    const candidate = [
      ...textColumns.map((column) => `${quote(column)} ~* $1`),
      ...jsonColumns.map((column) => `${quote(column)}::text ~* $1`),
    ].join(' OR ')
    const select = [
      ...target.key.map((key) => `${quote(key)}::text AS ${quote(`key_${key}`)}`),
      ...textColumns.map(quote),
      ...jsonColumns.map((column) => `${quote(column)}::text AS ${quote(column)}`),
    ].join(', ')
    let after: string[] | null = null
    let rows = 0
    while (true) {
      const keyParams = after ? target.key.map((_, index) => `$${index + 2}`).join(', ') : ''
      const afterKey = after ? `(${keyList}) > (${keyParams})` : 'true'
      const batch: Record<string, string | null>[] = await connection.unsafe(
        `SELECT ${select} FROM ${quote(target.table)}
        WHERE (${candidate}) AND ${afterKey}
        ORDER BY ${keyList} LIMIT ${batchSize}`,
        [STORED_TEXT_CANDIDATE, ...(after ?? [])]
      )
      if (!batch.length) break
      for (const row of batch) {
        const sets: string[] = []
        const params: unknown[] = []
        const param = (value: unknown) => {
          params.push(value)
          return `$${params.length}`
        }
        for (const column of textColumns) {
          const value = row[column]
          if (typeof value !== 'string') continue
          const next = rewriteStoredText(value)
          if (next !== value) sets.push(`${quote(column)} = ${param(next)}`)
        }
        for (const column of jsonColumns) {
          const value = row[column]
          if (typeof value !== 'string') continue
          const changes = jsonStringChanges(JSON.parse(value), rewriteStoredText)
          if (!changes.length) continue
          let expression = quote(column)
          for (const change of changes) {
            expression = `jsonb_set(${expression}, ${param(change.path)}::text[], to_jsonb(${param(change.value)}::text))`
          }
          sets.push(`${quote(column)} = ${expression}`)
        }
        if (!sets.length) continue
        const where = target.key.map((key) => `${quote(key)} = ${param(row[`key_${key}`])}`).join(' AND ')
        await connection.unsafe(`UPDATE ${quote(target.table)} SET ${sets.join(', ')} WHERE ${where}`, params as never)
        rows += 1
      }
      const last = batch.at(-1)!
      after = target.key.map((key) => last[`key_${key}`] as string)
      if (batch.length < batchSize) break
    }
    results.push({ table: target.table, rows })
  }
  return results
}
