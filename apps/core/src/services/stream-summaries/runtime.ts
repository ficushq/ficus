import { sql } from 'drizzle-orm'
import {
  parseSquadActivityId,
  parseStoredWorkStreamSummary,
  WORK_STREAM_SUMMARY_METADATA_KEY,
  type StoredWorkStreamSummary,
  type WorkStreamStatus,
} from '@ficus/shared'
import { db } from '../../db'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { completeWithTier } from '../model-tiers/light-completion-runtime'
import { loadWorkStreamSteps } from '../squad-activity/row-context'
import {
  NON_PARTICIPANT_AGENT_TYPES,
  PARTICIPANT_MESSAGE_LANE,
  refreshStreamSummary,
  StreamSummaryScheduler,
  type StreamSummaryDeps,
  type SummaryActivityRow,
  type SummaryStream,
} from './service'
import { streamSummariesEnabled } from './visibility'

const log = createLogger('stream-summaries')

const rows = <T>(result: unknown) => result as T[]
/** The metadata key as a SQL literal: a bound parameter makes `jsonb -> $1` ambiguous. */
const KEY = sql.raw(`'${WORK_STREAM_SUMMARY_METADATA_KEY}'`)
const excludedTypes = () =>
  sql.join(
    [...NON_PARTICIPANT_AGENT_TYPES].map((type) => sql`${type}`),
    sql`,`
  )

export const streamSummaryRuntimeDeps: StreamSummaryDeps = {
  isEnabled: streamSummariesEnabled,
  loadStream: async (streamId) => {
    const [row] = rows<{
      id: string
      squad_id: string
      title: string
      status: WorkStreamStatus
      owner_agent_id: string | null
      summary: unknown
    }>(
      await db.execute(sql`
        SELECT id,squad_id,title,status,owner_agent_id,(${jsonbObjectRecovered(sql.raw('metadata'))})->${KEY} summary
        FROM work_streams WHERE id=${streamId}::uuid`)
    )
    if (!row) return null
    return {
      id: row.id,
      squadId: row.squad_id,
      title: row.title,
      status: row.status,
      ownerAgentId: row.owner_agent_id,
      stored: parseStoredWorkStreamSummary({ [WORK_STREAM_SUMMARY_METADATA_KEY]: row.summary }),
    }
  },
  loadStep: async (stream) => (await loadWorkStreamSteps([stream])).get(stream.id) ?? null,
  loadParticipantRows: async (stream, since, limit) => {
    // One LIMIT probe of idx_squad_activity_agent per bound participant (the ORDER BY matches the
    // index), never a scan of their history; the owner, managers and consultants are left out.
    const result = rows<{ agent_id: string; agent_type_id: string | null; lane: number; summary: string; at: Date }>(
      await db.execute(sql`
        WITH participants AS MATERIALIZED (
          SELECT b.agent_id FROM workflow_bindings b
          JOIN agents a ON a.id=b.agent_id
          WHERE b.work_stream_id=${stream.id}::uuid
            AND a.agent_type_id NOT IN (${excludedTypes()})
            ${stream.ownerAgentId ? sql`AND b.agent_id<>${stream.ownerAgentId}::uuid` : sql``}
        )
        SELECT latest.agent_id,latest.agent_type_id,latest.lane,latest.summary,latest.at
        FROM participants p
        CROSS JOIN LATERAL (
          SELECT sa.agent_id,sa.agent_type_id,sa.lane,sa.summary,sa.at FROM squad_activity sa
          WHERE sa.squad_id=${stream.squadId}::uuid AND sa.agent_id=p.agent_id AND sa.lane=${PARTICIPANT_MESSAGE_LANE}
            ${since ? sql`AND sa.at>${since.toISOString()}::timestamptz` : sql``}
          ORDER BY sa.at DESC NULLS LAST LIMIT ${limit}
        ) latest
        ORDER BY latest.at DESC LIMIT ${limit}`)
    )
    return result.map((row): SummaryActivityRow => ({
      agentId: row.agent_id,
      agentTypeId: row.agent_type_id,
      lane: Number(row.lane),
      text: row.summary,
      at: new Date(row.at),
    }))
  },
  complete: (request) => completeWithTier(request),
  save: async (stream, summary, previousGeneratedAt) => saveStreamSummary(stream, summary, previousGeneratedAt),
  onError: (error) => log.warn('Could not summarize a work stream', error),
}

/**
 * Store the summary without touching `updated_at` (a summary is not a change to the stream's work,
 * and list order and "last event" must not move for it), only while the stream is active and no other
 * save happened since it was read. Then tell clients to refetch it.
 */
export async function saveStreamSummary(
  stream: Pick<SummaryStream, 'id' | 'squadId'>,
  summary: StoredWorkStreamSummary,
  previousGeneratedAt: string | null
): Promise<boolean> {
  const saved = rows<{ id: string }>(
    await db.execute(sql`
      UPDATE work_streams
      SET metadata=${jsonbObjectRecovered(sql.raw('metadata'))} || jsonb_build_object(${KEY}::text, ${JSON.stringify(summary)}::jsonb)
      WHERE id=${stream.id}::uuid AND status='active'
        AND ((${jsonbObjectRecovered(sql.raw('metadata'))})->${KEY}->>'generatedAt') IS NOT DISTINCT FROM ${previousGeneratedAt}::text
      RETURNING id`)
  )
  if (!saved.length) return false
  eventEmitter.emit('workStream.summaryUpdated', { workStreamId: stream.id, squadId: stream.squadId })
  return true
}

/** Agent id → its active stream, for live message hints. Short-lived: bindings rarely change. */
const BINDING_CACHE_MS = 60_000
const BINDING_CACHE_LIMIT = 2_000
const bindingCache = new Map<string, { streamId: string | null; at: number }>()

async function activeStreamOfAgent(agentId: string): Promise<string | null> {
  const cached = bindingCache.get(agentId)
  if (cached && Date.now() - cached.at < BINDING_CACHE_MS) return cached.streamId
  const [row] = rows<{ work_stream_id: string }>(
    await db.execute(sql`
      SELECT b.work_stream_id FROM workflow_bindings b
      JOIN work_streams ws ON ws.id=b.work_stream_id
      WHERE b.agent_id=${agentId}::uuid AND ws.status='active'`)
  )
  if (bindingCache.size >= BINDING_CACHE_LIMIT) bindingCache.delete(bindingCache.keys().next().value!)
  bindingCache.set(agentId, { streamId: row?.work_stream_id ?? null, at: Date.now() })
  return row?.work_stream_id ?? null
}

let scheduler: StreamSummaryScheduler | null = null

/**
 * Keep active streams' summaries current. Register once, in the API process: it receives every
 * process's events and pushes `workStream.summaryUpdated` to clients directly. While the switch is
 * off, the handlers return before any database read.
 */
export function registerStreamSummaries(deps: StreamSummaryDeps = streamSummaryRuntimeDeps): () => void {
  if (scheduler) return () => {}
  const active = new StreamSummaryScheduler({
    run: async (streamId, pendingMessages) => {
      const result = await refreshStreamSummary(streamId, pendingMessages, deps)
      // Ids and outcomes only, never message text, so a missing summary can be explained.
      log.debug(`Stream summary for ${streamId}: ${result.outcome}`)
      return result
    },
  })
  scheduler = active
  const enabled = () => {
    if (deps.isEnabled()) return true
    active.clear()
    return false
  }
  const unsubscribers = [
    eventEmitter.on('squadActivity.projected', ({ operation, item }) => {
      if (operation !== 'upsert' || item.ref?.type !== 'agent') return
      if (parseSquadActivityId(item.id)?.lane !== PARTICIPANT_MESSAGE_LANE) return
      if (item.agentTypeId && NON_PARTICIPANT_AGENT_TYPES.has(item.agentTypeId)) return
      if (!enabled()) return
      const agentId = item.ref.agentId
      void activeStreamOfAgent(agentId)
        .then((streamId) => {
          if (streamId) active.noteMessage(streamId)
        })
        .catch((error) => log.warn('Could not resolve a participant stream for summaries', error))
    }),
    ...(['workStream.updated', 'workStream.assigned', 'workStream.reopened'] as const).map((event) =>
      eventEmitter.on(event, ({ workStreamId }) => {
        if (enabled()) active.noteStreamChanged(workStreamId)
      })
    ),
    ...(['workStream.done', 'workStream.canceled', 'workStream.deleted'] as const).map((event) =>
      eventEmitter.on(event, ({ workStreamId }) => active.forget(workStreamId))
    ),
  ]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
    active.clear()
    bindingCache.clear()
    scheduler = null
  }
}
