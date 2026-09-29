import type postgres from 'postgres'
import {
  STORED_TEXT_CANDIDATE,
  jsonStringChanges,
  rewriteEntityReferences,
  rewriteMemoryProvenance,
  type JsonPath,
} from './stored-text-rewrite'

type Change = { path: JsonPath; value: string }
/** The changed strings of one stored JSON document, each at its path. */
type JsonRewrite = (document: unknown) => Change[]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function change(path: JsonPath, value: unknown, rewrite: (text: string) => string): Change[] {
  if (typeof value !== 'string') return []
  const next = rewrite(value)
  return next === value ? [] : [{ path, value: next }]
}

/** A document that is all rendered prose (question text, preview spans, schedule prompts). */
const everyString: JsonRewrite = (document) => jsonStringChanges(document, rewriteEntityReferences)

/**
 * `messages.metadata`: only the Markdown text blocks the chat renders get entity references. Tool
 * calls are verbatim I/O (file contents, command output, edit arguments) and are never rewritten,
 * except the provenance marker memory_search appends to its own result.
 */
const messageMetadata: JsonRewrite = (document) => {
  if (!isObject(document) || !Array.isArray(document.content)) return []
  return document.content.flatMap((block, index): Change[] => {
    if (!isObject(block)) return []
    if (block.type === 'text')
      return change(['content', String(index), 'content'], block.content, rewriteEntityReferences)
    const toolCall = block.toolCall
    if (block.type === 'tool_use' && isObject(toolCall) && toolCall.toolName === 'memory_search') {
      return change(['content', String(index), 'toolCall', 'result'], toolCall.result, rewriteMemoryProvenance)
    }
    return []
  })
}

/** `assistant_entries.entry`: user and assistant text; a tool entry only for memory_search's marker. */
const assistantEntry: JsonRewrite = (document) => {
  if (!isObject(document)) return []
  if (document.role === 'user' || document.role === 'assistant') {
    return change(['text'], document.text, rewriteEntityReferences)
  }
  if (document.role === 'tool' && document.toolName === 'memory_search') {
    return change(['toolResult'], document.toolResult, rewriteMemoryProvenance)
  }
  return []
}

/** `work_streams.metadata.nextSteps`, rendered as Markdown and sent in done notifications. */
const workStreamMetadata: JsonRewrite = (document) =>
  isObject(document) ? change(['nextSteps'], document.nextSteps, rewriteEntityReferences) : []

/** `work_stream_flow_runs.state.attempts[].evidence`, rendered as Markdown on the review callout. */
const flowRunState: JsonRewrite = (document) => {
  if (!isObject(document) || !Array.isArray(document.attempts)) return []
  return document.attempts.flatMap((attempt, index) =>
    isObject(attempt) ? change(['attempts', String(index), 'evidence'], attempt.evidence, rewriteEntityReferences) : []
  )
}

/**
 * Task 36c, migration 0196: the stored rows that hold user or agent prose a reader parses for entity
 * references (chat Markdown links, farm chat chips, activity-preview hrefs), and memory_search results
 * that carry the provenance marker the web tool traces parse. Text columns are prose throughout; JSON
 * columns say which of their strings are. Not listed: plain-text labels no reader parses (titles,
 * summaries, notification bodies, agents.last_message_preview), system-generated text
 * (sandbox_recovery_subscriptions.content), derived indexes (memory chunks, rebuilt from their
 * sources), and signed or external payloads (AMTP envelopes, webhook bodies).
 */
export const STORED_TEXT_TARGETS: ReadonlyArray<{
  table: string
  key: readonly string[]
  text?: readonly string[]
  json?: Readonly<Record<string, JsonRewrite>>
}> = [
  { table: 'messages', key: ['id'], text: ['content'], json: { metadata: messageMetadata } },
  { table: 'executions', key: ['id'], text: ['message'] },
  { table: 'inbox', key: ['id'], text: ['content'] },
  {
    table: 'work_streams',
    key: ['id'],
    text: ['description', 'handoff_message'],
    json: { metadata: workStreamMetadata },
  },
  { table: 'work_stream_waits', key: ['id'], text: ['message', 'resolution_note'] },
  { table: 'work_stream_flow_runs', key: ['work_stream_id'], json: { state: flowRunState } },
  { table: 'work_stream_continuations', key: ['work_stream_id'], text: ['delivery_prompt'] },
  { table: 'agent_questions', key: ['id'], text: ['answer'], json: { question_data: everyString } },
  { table: 'farm_chat_messages', key: ['id'], text: ['body'] },
  { table: 'assistant_entries', key: ['id'], json: { entry: assistantEntry } },
  { table: 'squad_activity', key: ['squad_id', 'lane', 'row_id'], json: { preview: everyString } },
  { table: 'schedules', key: ['id'], json: { action: everyString } },
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
    const jsonColumns = Object.entries(target.json ?? {})
    const keyList = target.key.map(quote).join(', ')
    const candidate = [
      ...textColumns.map((column) => `${quote(column)} ~* $1`),
      ...jsonColumns.map(([column]) => `${quote(column)}::text ~* $1`),
    ].join(' OR ')
    const select = [
      ...target.key.map((key) => `${quote(key)}::text AS ${quote(`key_${key}`)}`),
      ...textColumns.map(quote),
      ...jsonColumns.map(([column]) => `${quote(column)}::text AS ${quote(column)}`),
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
          const next = rewriteEntityReferences(value)
          if (next !== value) sets.push(`${quote(column)} = ${param(next)}`)
        }
        for (const [column, rewrite] of jsonColumns) {
          const value = row[column]
          if (typeof value !== 'string') continue
          const changes = rewrite(JSON.parse(value))
          if (!changes.length) continue
          let expression = quote(column)
          for (const { path, value: next } of changes) {
            expression = `jsonb_set(${expression}, ${param(path)}::text[], to_jsonb(${param(next)}::text))`
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
