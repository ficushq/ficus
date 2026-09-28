import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { squadActivity } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { ActivityMaintenanceLeaseLostError, type ActivityMaintenanceLeaseFence } from './lease'
import { materializedItem } from './types'
import { activityFamily, loadActivitySource } from './families'
import { listReceiptAssociationPage, loadWebhookActivityBaseSource, type ActivitySourceKey } from './source-loaders'
import { activityPayloadHash, activityPersistencePayload, type ExtractedSquadActivity } from './types'
import { coerceSquadActivityRef } from '@ficus/shared'

export interface MaterializeResult {
  upserted: ExtractedSquadActivity[]
  inserted: ExtractedSquadActivity[]
  updated: ExtractedSquadActivity[]
  deleted: ExtractedSquadActivity[]
}

function databaseValues(item: ExtractedSquadActivity) {
  const value = activityPersistencePayload(item)
  return { ...value, at: new Date(value.at), payloadHash: activityPayloadHash(item) }
}

function storedToExtracted(row: typeof squadActivity.$inferSelect): ExtractedSquadActivity {
  return {
    id: `${row.lane}:${row.rowId}`,
    lane: row.lane as ExtractedSquadActivity['lane'],
    rowId: row.rowId,
    squadId: row.squadId,
    at: row.at.toISOString(),
    agentId: row.agentId,
    agentTypeId: row.agentTypeId,
    kind: row.kind,
    summary: row.summary,
    preview: row.preview,
    ref: coerceSquadActivityRef(row.ref),
    sourceFamily: row.sourceFamily as ExtractedSquadActivity['sourceFamily'],
    sourceGroupId: row.sourceGroupId,
    workStreamId: row.workStreamId,
    quietEligible: row.quietEligible,
    accessScope: row.accessScope,
    inboxRecipientId: row.inboxRecipientId,
    agentTypeRequiresAgentsRead: row.agentTypeRequiresAgentsRead,
  }
}

export async function materializeSourceGroup(
  key: ActivitySourceKey,
  options: {
    writeWindow?: { from: Date; to: Date }
    publish?: boolean
    publishAfter?: Date
    leaseFence?: ActivityMaintenanceLeaseFence
  } = {}
): Promise<MaterializeResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${key.family}:${key.groupId}`},0))`)
    if (options.leaseFence) {
      const fenced = await tx.execute<any>(sql`SELECT lease_token FROM squad_activity_maintenance_leases
        WHERE task=${options.leaseFence.task} AND lease_token=${options.leaseFence.token}::uuid
          AND lease_until>clock_timestamp() FOR SHARE`)
      if (!fenced[0]) throw new ActivityMaintenanceLeaseLostError('Activity maintenance lease lost')
    }
    const family = activityFamily(key.family)
    const snapshot = await loadActivitySource(tx, key)
    let extracted = snapshot ? family.extract(snapshot) : []
    const existing = await tx
      .select()
      .from(squadActivity)
      .where(sql`${squadActivity.sourceFamily}=${key.family} AND ${squadActivity.sourceGroupId}=${key.groupId}`)
    const within = (item: { at: string | Date }) =>
      !options.writeWindow ||
      (new Date(item.at) >= options.writeWindow.from && new Date(item.at) < options.writeWindow.to)
    extracted = extracted.filter(within)
    const upserted: ExtractedSquadActivity[] = []
    const inserted: ExtractedSquadActivity[] = []
    const updated: ExtractedSquadActivity[] = []
    const visibilityTombstones: ExtractedSquadActivity[] = []
    const existingByIdentity = new Map(existing.map((row) => [`${row.squadId}:${row.lane}:${row.rowId}`, row]))
    for (const item of extracted) {
      const insert = tx.insert(squadActivity).values(databaseValues(item))
      const [changed] = family.appendOnly
        ? await insert
            .onConflictDoUpdate({
              target: [squadActivity.squadId, squadActivity.lane, squadActivity.rowId],
              // Immutable event identity/authority stays append-only. Only the
              // presentation is regenerated, and only by its original source.
              set: {
                preview: item.preview,
                summary: item.summary,
                payloadHash: activityPayloadHash(item),
                updatedAt: sql`clock_timestamp()`,
              },
              setWhere: sql`${squadActivity.sourceGroupId}=${item.sourceGroupId} AND ${squadActivity.preview} IS DISTINCT FROM ${JSON.stringify(item.preview)}::jsonb`,
            })
            .returning()
        : await insert
            .onConflictDoUpdate({
              target: [squadActivity.squadId, squadActivity.lane, squadActivity.rowId],
              set: { ...databaseValues(item), updatedAt: sql`clock_timestamp()` },
              setWhere: sql`${squadActivity.payloadHash} IS DISTINCT FROM ${activityPayloadHash(item)}`,
            })
            .returning()
      if (changed) {
        const prior = existingByIdentity.get(`${item.squadId}:${item.lane}:${item.rowId}`)
        const extractedChanged = storedToExtracted(changed)
        if (
          prior &&
          (prior.accessScope !== changed.accessScope ||
            prior.inboxRecipientId !== changed.inboxRecipientId ||
            prior.agentTypeRequiresAgentsRead !== changed.agentTypeRequiresAgentsRead)
        )
          visibilityTombstones.push(storedToExtracted(prior))
        if (prior) updated.push(extractedChanged)
        else inserted.push(extractedChanged)
        upserted.push(extractedChanged)
      }
    }
    const keep = new Set(extracted.map((item) => `${item.squadId}:${item.lane}:${item.rowId}`))
    const obsolete = family.appendOnly
      ? []
      : existing.filter((row) => within(row) && !keep.has(`${row.squadId}:${row.lane}:${row.rowId}`))
    for (const row of obsolete)
      await tx
        .delete(squadActivity)
        .where(
          sql`${squadActivity.squadId}=${row.squadId}::uuid AND ${squadActivity.lane}=${row.lane} AND ${squadActivity.rowId}=${row.rowId}::uuid`
        )
    return { upserted, inserted, updated, deleted: [...visibilityTombstones, ...obsolete.map(storedToExtracted)] }
  })
  if (options.publish === false) return result
  const publishable = (item: ExtractedSquadActivity) =>
    !options.publishAfter || new Date(item.at) >= options.publishAfter
  for (const item of result.deleted.filter(publishable))
    eventEmitter.emit('squadActivity.projected', {
      squadId: item.squadId,
      operation: 'delete',
      item: materializedItem(item),
      quietEligible: item.quietEligible,
      accessScope: item.accessScope,
      inboxRecipientId: item.inboxRecipientId,
      agentTypeRequiresAgentsRead: item.agentTypeRequiresAgentsRead,
    })
  for (const item of result.upserted.filter(publishable))
    eventEmitter.emit('squadActivity.projected', {
      squadId: item.squadId,
      operation: 'upsert',
      item: materializedItem(item),
      quietEligible: item.quietEligible,
      accessScope: item.accessScope,
      inboxRecipientId: item.inboxRecipientId,
      agentTypeRequiresAgentsRead: item.agentTypeRequiresAgentsRead,
    })
  return result
}

const EMPTY_MATERIALIZATION: MaterializeResult = { upserted: [], inserted: [], updated: [], deleted: [] }

export async function materializeGitHubDispatch(activityId: string, squadId: string): Promise<MaterializeResult> {
  const sourceId = `poll:${activityId}`
  // The dispatch's own stored fact decides the family; an append-only family
  // never deletes, so a dispatch that yields no fact has nothing to settle.
  const base = await loadWebhookActivityBaseSource(sourceId)
  if (!base) return EMPTY_MATERIALIZATION
  return materializeSourceGroup({ family: base.family, groupId: `${sourceId}:${squadId}` })
}

/**
 * Project one verified webhook receipt onto every squad that owns it. The
 * receipt's own stored payload decides its family, so the provider argument
 * only says which webhook stream the id belongs to.
 */
export async function materializeWebhookActivity(
  provider: 'github' | 'linear',
  eventId: string,
  options: {
    pageSize?: number
    concurrency?: number
    materialize?: typeof materializeSourceGroup
  } = {}
): Promise<number> {
  const pageSize = options.pageSize ?? 250
  const concurrency = options.concurrency ?? 4
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 500 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 4 ||
    concurrency > 8
  )
    throw new TypeError('Invalid Activity materialization bounds')
  const materialize = options.materialize ?? materializeSourceGroup
  const sourceId = `hook:${eventId}`
  const base = await loadWebhookActivityBaseSource(sourceId)
  if (!base) return 0
  let after: string | null = null
  let materialized = 0
  let failureCount = 0
  let firstFailure: unknown
  do {
    const page = await listReceiptAssociationPage(base, after, pageSize)
    for (let offset = 0; offset < page.groupIds.length; offset += concurrency) {
      const groupIds = page.groupIds.slice(offset, offset + concurrency)
      const results = await Promise.allSettled(groupIds.map((groupId) => materialize({ family: base.family, groupId })))
      for (const result of results) {
        if (result.status === 'fulfilled') materialized++
        else {
          failureCount++
          firstFailure ??= result.reason
        }
      }
    }
    after = page.next
  } while (after)
  if (failureCount)
    throw new AggregateError(
      firstFailure === undefined ? [] : [firstFailure],
      `${failureCount} ${provider} Activity association(s) failed`
    )
  return materialized
}

/** The GitHub webhook entry point; projection itself is provider-agnostic. */
export async function materializeGitHubWebhook(
  eventId: string,
  options: Parameters<typeof materializeWebhookActivity>[2] = {}
): Promise<number> {
  return materializeWebhookActivity('github', eventId, options)
}
