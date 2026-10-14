import { and, eq, inArray, sql } from 'drizzle-orm'
import type { StoredFilesSummary } from '@ficus/shared'
import { db } from '../../db'
import { agentFileAttachments, agents, images, inbox, inboxAttachments, squads } from '../../db/schema'
import { getSettingsStore } from '../settings'

type SquadBytes = { squadId: string | null; bytes: number | string | null }

/**
 * One kind of file Ficus keeps on the core host, totalled per owning squad from
 * its database rows (cheap aggregates, never a disk scan). A new blob kind
 * (e.g. workflow attachments, via work_stream → squad) is one more entry here.
 */
interface StoredFileSourceDefinition {
  key: string
  label: string
  countsTowardQuota: boolean
  bySquad: () => Promise<SquadBytes[]>
}

export const STORED_FILE_SOURCES: StoredFileSourceDefinition[] = [
  {
    key: 'agentFiles',
    label: 'Agent file attachments',
    countsTowardQuota: true,
    bySquad: () =>
      db
        .select({ squadId: agents.squadId, bytes: sql<string>`sum(${agentFileAttachments.byteSize})` })
        .from(agentFileAttachments)
        .leftJoin(agents, eq(agents.id, agentFileAttachments.agentId))
        .groupBy(agents.squadId),
  },
  {
    key: 'inboxAttachments',
    label: 'Inbox attachments',
    countsTowardQuota: true,
    // Attributable only through an agent recipient; people's and the system inbox are unattributed.
    bySquad: () =>
      db
        .select({ squadId: agents.squadId, bytes: sql<string>`sum(${inboxAttachments.byteSize})` })
        .from(inboxAttachments)
        .innerJoin(inbox, eq(inbox.id, inboxAttachments.messageId))
        .leftJoin(agents, and(eq(inbox.recipientType, 'agent'), sql`${agents.id}::text = ${inbox.recipientId}`))
        .groupBy(agents.squadId),
  },
  {
    key: 'images',
    label: 'Images',
    countsTowardQuota: false,
    bySquad: async () => {
      const squadId = sql<string | null>`coalesce(${images.squadId}, ${agents.squadId})`
      return db
        .select({ squadId, bytes: sql<string>`sum(${images.size})` })
        .from(images)
        .leftJoin(agents, eq(agents.id, images.agentId))
        .groupBy(squadId)
    },
  },
]

/** Per-squad totals of files stored by Ficus, with the attachment quota they count against. */
export async function summarizeStoredFiles(): Promise<StoredFilesSummary> {
  const results = await Promise.all(STORED_FILE_SOURCES.map((source) => source.bySquad()))
  const squadIds = [...new Set(results.flat().flatMap((row) => (row.squadId ? [row.squadId] : [])))]
  const names = new Map(
    squadIds.length
      ? (await db.select({ id: squads.id, name: squads.name }).from(squads).where(inArray(squads.id, squadIds))).map(
          (row) => [row.id, row.name]
        )
      : []
  )
  const bySquad = new Map<string, StoredFilesSummary['squads'][number]>()
  const unattributed: StoredFilesSummary['unattributed'] = { bytes: 0, sources: {} }
  const sources = STORED_FILE_SOURCES.map(({ key, label, countsTowardQuota }, index) => {
    let total = 0
    unattributed.sources[key] = 0
    for (const row of results[index]) {
      const bytes = Number(row.bytes ?? 0)
      total += bytes
      const name = row.squadId ? names.get(row.squadId) : undefined
      if (!row.squadId || name === undefined) {
        unattributed.bytes += bytes
        unattributed.sources[key] += bytes
        continue
      }
      const squad = bySquad.get(row.squadId) ?? { id: row.squadId, name, bytes: 0, sources: {} }
      squad.bytes += bytes
      squad.sources[key] = (squad.sources[key] ?? 0) + bytes
      bySquad.set(row.squadId, squad)
    }
    return { key, label, countsTowardQuota, bytes: total }
  })
  return {
    sources,
    squads: [...bySquad.values()].sort((a, b) => b.bytes - a.bytes),
    unattributed,
    totalBytes: sources.reduce((sum, source) => sum + source.bytes, 0),
    quotaUsedBytes: sources.reduce((sum, source) => sum + (source.countsTowardQuota ? source.bytes : 0), 0),
    quotaBytes: Number(getSettingsStore().getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES')),
  }
}
