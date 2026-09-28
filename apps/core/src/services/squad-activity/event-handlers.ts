import { sql, type SQL } from 'drizzle-orm'
import type { EventMap } from '@ficus/shared'
import { db } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { materializeSourceGroup } from './materialize'
import type { ActivitySourceKey } from './source-loaders'

const log = createLogger('squad-activity')
const expansionPageSize = 250
const materializeConcurrency = 4
const executionEvents = new Set([
  'execution.created',
  'execution.queued',
  'execution.started',
  'execution.updated',
  'execution.completed',
  'execution.failed',
  'execution.stopped',
])
const workStreamEvents = new Set([
  'workStream.created',
  'workStream.updated',
  'workStream.assigned',
  'workStream.agentAdded',
  'workStream.agentRemoved',
  'workStream.blocked',
  'workStream.review',
  'workStream.responded',
  'workStream.done',
  'workStream.canceled',
  'workStream.reopened',
  'workStream.deleted',
])

/**
 * Per-source-group burst coalescing. During streaming turns the live fast
 * path receives several events per second that all target the SAME source
 * group (message.updated/execution.* for one execution), and each
 * materialization is a full transaction — advisory lock, whole-snapshot
 * reload (all of the execution's assistant messages), extraction, upserts —
 * in BOTH api and worker. Coalescing runs one materialization immediately
 * (leading edge) and, if more events for the group arrive while it runs,
 * exactly one more afterwards (trailing edge) — every burst collapses to at
 * most two runs while the last event is always reflected. Correctness is
 * unchanged: this path is documented lossy best-effort with the hourly repair
 * sweep as the backstop, and the trailing rerun is strictly less lossy than
 * dropping events.
 */
const inflightGroups = new Map<string, { rerun: boolean; latestEvent: keyof EventMap }>()

async function coalescedMaterialize(
  event: keyof EventMap,
  key: ActivitySourceKey,
  materialize: typeof materializeSourceGroup
): Promise<void> {
  const id = `${key.family}:${key.groupId}`
  const inflight = inflightGroups.get(id)
  if (inflight) {
    inflight.rerun = true
    inflight.latestEvent = event
    return
  }
  const state = { rerun: false, latestEvent: event }
  inflightGroups.set(id, state)
  try {
    do {
      state.rerun = false
      try {
        await materialize(key)
      } catch (error) {
        log.error('Activity materialization failed', { event: state.latestEvent, key, error })
      }
    } while (state.rerun)
  } finally {
    inflightGroups.delete(id)
  }
}

async function materializeKeys(
  event: keyof EventMap,
  keys: ActivitySourceKey[],
  materialize: typeof materializeSourceGroup
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += materializeConcurrency) {
    const batch = keys.slice(offset, offset + materializeConcurrency)
    await Promise.all(batch.map((key) => coalescedMaterialize(event, key, materialize)))
  }
}

async function materializeRelatedWorkStream(
  event: keyof EventMap,
  workStreamId: string,
  materialize: typeof materializeSourceGroup
): Promise<void> {
  for (const source of ['wait', 'inbox'] as const) {
    let after: string | null = null
    do {
      const result: any[] =
        source === 'wait'
          ? await db.execute<any>(sql`SELECT id::text id FROM work_stream_waits
              WHERE (work_stream_id=${workStreamId}::uuid OR reference_id=${workStreamId}::uuid)
                ${after ? sql`AND id>${after}::uuid` : sql``} ORDER BY id LIMIT ${expansionPageSize}`)
          : await db.execute<any>(relatedInboxPageSql(workStreamId, after, expansionPageSize))
      await materializeKeys(
        event,
        result.map((row: any) => ({ family: source, groupId: row.id })),
        materialize
      )
      after = result.length === expansionPageSize ? (result.at(-1)?.id ?? null) : null
    } while (after)
  }
}

async function materializeProjectedWorkStream(
  event: keyof EventMap,
  workStreamId: string,
  materialize: typeof materializeSourceGroup
): Promise<void> {
  let afterFamily = ''
  let afterGroup = ''
  while (true) {
    const result = await db.execute<any>(sql`SELECT source_family,source_group_id FROM squad_activity
      WHERE work_stream_id=${workStreamId}::uuid AND source_family IN ('wait','inbox')
        AND (source_family>${afterFamily} OR (source_family=${afterFamily} AND source_group_id>${afterGroup}))
      GROUP BY source_family,source_group_id ORDER BY source_family,source_group_id LIMIT ${expansionPageSize}`)
    await materializeKeys(
      event,
      result.map((row: any) => ({ family: row.source_family, groupId: row.source_group_id })),
      materialize
    )
    if (result.length < expansionPageSize) break
    afterFamily = result.at(-1).source_family
    afterGroup = result.at(-1).source_group_id
  }
}

async function reconcileSquadAgent(
  event: keyof EventMap,
  agentId: string,
  squadId: string,
  materialize: typeof materializeSourceGroup
): Promise<void> {
  let after: { lane: number; rowId: string } | null = null
  while (true) {
    const keyset: SQL = after
      ? sql`AND (lane>${after.lane} OR (lane=${after.lane} AND row_id>${after.rowId}::uuid))`
      : sql``
    const result: any[] = await db.execute<any>(sql`SELECT lane,row_id,source_family,source_group_id FROM squad_activity
      WHERE squad_id=${squadId}::uuid AND (agent_id=${agentId}::uuid OR inbox_recipient_id=${agentId}::uuid)
        ${keyset} ORDER BY lane,row_id LIMIT ${expansionPageSize}`)
    const keys = new Map<string, ActivitySourceKey>()
    for (const row of result) {
      const key = { family: row.source_family, groupId: row.source_group_id } as ActivitySourceKey
      keys.set(`${key.family}:${key.groupId}`, key)
    }
    await materializeKeys(event, [...keys.values()], materialize)
    if (result.length < expansionPageSize) break
    after = { lane: result.at(-1).lane, rowId: result.at(-1).row_id }
  }
}

async function directKeys(event: keyof EventMap, data: any): Promise<ActivitySourceKey[]> {
  if (event === 'message.created' || event === 'message.updated') {
    const executionId =
      data.executionId ??
      (await db.execute<any>(sql`SELECT metadata->>'executionId' id FROM messages WHERE id=${data.messageId}::uuid`))[0]
        ?.id
    return executionId ? [{ family: 'chat', groupId: executionId }] : []
  }
  if (event === 'inbox.messageReceived') return [{ family: 'inbox', groupId: data.messageId }]
  if (executionEvents.has(event))
    return [
      { family: 'execution', groupId: data.executionId },
      { family: 'chat', groupId: data.executionId },
    ]
  return []
}

async function materializeEvent(
  event: keyof EventMap,
  data: any,
  materialize: typeof materializeSourceGroup
): Promise<void> {
  if (workStreamEvents.has(event)) {
    await materializeKeys(event, [{ family: 'workstream', groupId: data.workStreamId }], materialize)
    if (event === 'workStream.deleted') await materializeProjectedWorkStream(event, data.workStreamId, materialize)
    else await materializeRelatedWorkStream(event, data.workStreamId, materialize)
    return
  }
  if (event === 'agent.terminated' || event === 'agent.deleted') {
    if (typeof data.squadId !== 'string') return
    await reconcileSquadAgent(event, data.agentId, data.squadId, materialize)
    return
  }
  await materializeKeys(event, await directKeys(event, data), materialize)
}

/**
 * Lossy best-effort after-commit path; the hourly repair sweep closes misses
 * inside 48 hours. This is the LIVE fast-path wiring — the per-family
 * engine seams (snapshot loader, extractor, source pager) live in the
 * families.ts registry; wire a new family's events here (see the registry's
 * "Adding a family" checklist).
 */
export function registerSquadActivityEventHandlers(
  options: { materialize?: typeof materializeSourceGroup } = {}
): () => void {
  const materialize = options.materialize ?? materializeSourceGroup
  return eventEmitter.onAny((event, data, meta) => {
    // Both api and worker register this handler, and the distributed emitter
    // re-emits every peer event locally — so without this guard every event
    // was materialized TWICE (one full advisory-lock transaction + snapshot
    // reload per process). Each process materializes only the events it
    // originated; the other process's copy is the duplicate.
    if (meta.remote) return
    queueMicrotask(() => {
      void materializeEvent(event, data, materialize).catch((error) =>
        log.error('Activity source expansion failed', { event, error })
      )
    })
  })
}

export function relatedInboxPageSql(workStreamId: string, after: string | null, limit: number) {
  return sql`SELECT id::text id FROM inbox
    WHERE metadata->>'workStreamId'=${workStreamId}
      ${after ? sql`AND id>${after}::uuid` : sql``} ORDER BY id LIMIT ${limit}`
}
