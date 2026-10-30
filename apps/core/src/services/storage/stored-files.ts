import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SquadStoredFiles, StoredFilesSummary } from '@ficus/shared'
import { db } from '../../db'
import {
  agentFileAttachments,
  agents,
  images,
  inbox,
  inboxAttachments,
  squads,
  workflowAttemptAttachments,
  workStreams,
} from '../../db/schema'
import { totalAttachmentStorageBytes } from '../attachments/storage-quota'
import { getSettingsStore } from '../settings'

type SquadBytes = { squadId: string | null; bytes: number | string | null }

/**
 * One kind of file Ficus keeps on the core host, totalled per owning squad from
 * its database rows (cheap aggregates, never a disk scan). A new blob kind
 * is one more entry here. With `squadId`, only that squad's rows are summed.
 */
interface StoredFileSourceDefinition {
  key: string
  label: string
  countsTowardQuota: boolean
  bySquad: (squadId?: string) => Promise<SquadBytes[]>
}

export const STORED_FILE_SOURCES: StoredFileSourceDefinition[] = [
  {
    key: 'agentFiles',
    label: 'Agent file attachments',
    countsTowardQuota: true,
    bySquad: (squadId) =>
      db
        .select({ squadId: agents.squadId, bytes: sql<string>`sum(${agentFileAttachments.byteSize})` })
        .from(agentFileAttachments)
        .leftJoin(agents, eq(agents.id, agentFileAttachments.agentId))
        .where(squadId ? eq(agents.squadId, squadId) : undefined)
        .groupBy(agents.squadId),
  },
  {
    key: 'inboxAttachments',
    label: 'Inbox attachments',
    countsTowardQuota: true,
    // Attributable only through an agent recipient; people's and the system inbox are unattributed.
    bySquad: (squadId) =>
      db
        .select({ squadId: agents.squadId, bytes: sql<string>`sum(${inboxAttachments.byteSize})` })
        .from(inboxAttachments)
        .innerJoin(inbox, eq(inbox.id, inboxAttachments.messageId))
        .leftJoin(agents, and(eq(inbox.recipientType, 'agent'), sql`${agents.id}::text = ${inbox.recipientId}`))
        .where(squadId ? eq(agents.squadId, squadId) : undefined)
        .groupBy(agents.squadId),
  },
  {
    key: 'workflowAttachments',
    label: 'Workflow handoff files',
    countsTowardQuota: true,
    bySquad: (squadId) =>
      db
        .select({ squadId: workStreams.squadId, bytes: sql<string>`sum(${workflowAttemptAttachments.byteSize})` })
        .from(workflowAttemptAttachments)
        .leftJoin(workStreams, eq(workStreams.id, workflowAttemptAttachments.workStreamId))
        .where(squadId ? eq(workStreams.squadId, squadId) : undefined)
        .groupBy(workStreams.squadId),
  },
  {
    key: 'images',
    label: 'Images',
    countsTowardQuota: false,
    bySquad: async (squadId) => {
      const owner = sql<string | null>`coalesce(${images.squadId}, ${agents.squadId})`
      return db
        .select({ squadId: owner, bytes: sql<string>`sum(${images.size})` })
        .from(images)
        .leftJoin(agents, eq(agents.id, images.agentId))
        .where(squadId ? sql`${owner} = ${squadId}` : undefined)
        .groupBy(owner)
    },
  },
]

/**
 * One squad's stored files per source, from rows attributed to that squad only. The
 * instance-wide attachment quota and its usage are deliberately left out: they total
 * every squad's files.
 */
export async function summarizeSquadStoredFiles(squadId: string): Promise<SquadStoredFiles> {
  const results = await Promise.all(STORED_FILE_SOURCES.map((source) => source.bySquad(squadId)))
  const sources = STORED_FILE_SOURCES.map(({ key, label, countsTowardQuota }, index) => ({
    key,
    label,
    countsTowardQuota,
    // The query is already filtered; the row check keeps another squad's total out regardless.
    bytes: results[index]!.reduce((sum, row) => (row.squadId === squadId ? sum + Number(row.bytes ?? 0) : sum), 0),
  }))
  return { bytes: sources.reduce((sum, source) => sum + source.bytes, 0), sources }
}

/** Per-squad totals of files stored by Ficus, with the attachment quota they count against. */
export async function summarizeStoredFiles(): Promise<StoredFilesSummary> {
  const [results, quotaUsedBytes] = await Promise.all([
    Promise.all(STORED_FILE_SOURCES.map((source) => source.bySquad())),
    // The exact sum the quota check enforces (storage-quota.ts), not a re-derivation.
    totalAttachmentStorageBytes(),
  ])
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
    quotaUsedBytes,
    quotaBytes: Number(getSettingsStore().getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES')),
  }
}
