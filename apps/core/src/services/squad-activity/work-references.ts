import { inArray } from 'drizzle-orm'
import type { SquadActivityItem } from '@ficus/shared'
import { db, workStreams } from '../../db'

/** Work-stream id a ref wants enriched with a human-facing number, if it has one. */
const workStreamIdOf = (ref: SquadActivityItem['ref']): string | null =>
  ref.type === 'workstream' ? ref.workStreamId : ref.type === 'issue' ? (ref.workStreamId ?? null) : null

/** Enrich only an already-authorized page; historical projection rows keep their storage keys. */
export async function addWorkReferences<T extends SquadActivityItem>(items: T[]): Promise<T[]> {
  const ids = [...new Set(items.flatMap((item) => workStreamIdOf(item.ref) ?? []))]
  if (!ids.length) return items
  const rows = await db
    .select({ id: workStreams.id, number: workStreams.number })
    .from(workStreams)
    .where(inArray(workStreams.id, ids))
  const numbers = new Map(rows.map((row) => [row.id, row.number]))
  return items.map((item) => {
    const workStreamId = workStreamIdOf(item.ref)
    if (!workStreamId) return item
    const number = numbers.get(workStreamId)
    if (!number) return item
    // Only a work-stream row's summary carries the storage key; an issue summary describes the issue.
    if (item.ref.type !== 'workstream') return { ...item, ref: { ...item.ref, workStreamNumber: number } }
    return {
      ...item,
      ref: { ...item.ref, workStreamNumber: number },
      preview: item.preview.map((span, index) =>
        index === 0 ? { ...span, text: span.text.replace(/^\[ws-[0-9a-f]+ /, `[#${number} `) } : span
      ),
      summary: item.summary.replace(/^\[ws-[0-9a-f]+ /, `[#${number} `),
    }
  })
}
