import { sql } from 'drizzle-orm'
import {
  parseSquadActivityId,
  type ActivityRowContext,
  type ActivityWorkStreamContext,
  type SquadActivityItem,
  type WorkStreamStatus,
} from '@ficus/shared'
import { db } from '../../db'
import type { SquadActivityAccess } from '../squad/activity'
import { uuidJoinKey } from './source-loaders'

/**
 * Read-time row context for the Activity feed (see docs/wiki/activity-previews.md,
 * "Row context, Active work and cleanup"). Nothing here is materialized: a stream's
 * title and step change constantly, so they are joined on the already-authorized page
 * (and on each live event) in a few batched queries, never one per row.
 */

/** Everything a row could carry before per-viewer redaction. */
export interface ActivityRowFacts {
  workStream?: ActivityWorkStreamContext
  purpose?: string
  senderActivityId?: string
}

type Executor = Pick<typeof db, 'execute'>
const rows = <T>(result: unknown) => result as T[]

/** A step id as a label when its definition has no display name: `code-review` → "Code review". */
function humanizeStepId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : id
}

export interface WorkStreamStepFacts {
  status: WorkStreamStatus
  /** No flow run, or one not activated yet. */
  runStatus: string | null
  runningStepIds: string[]
  stepNames: Record<string, string>
}

/** The stream's current step as a person reads it. Exported for unit tests. */
export function workStreamStepLabel(facts: WorkStreamStepFacts): string | null {
  if (facts.status === 'done') return 'Done'
  if (facts.status === 'canceled') return 'Canceled'
  if (!facts.runStatus) return null
  if (facts.runStatus === 'paused') return 'Paused'
  const names = [...new Set(facts.runningStepIds.map((id) => facts.stepNames[id]?.trim() || humanizeStepId(id)))]
  if (names.length) return names.join(' + ')
  if (facts.runStatus === 'completion-ready') return 'Completion-ready'
  return null
}

/**
 * Current step label per stream, read from the flow run without loading its (large)
 * attempt evidence: only running step ids and definition step names leave the database.
 */
export async function loadWorkStreamSteps(
  streams: Array<{ id: string; status: WorkStreamStatus }>,
  executor: Executor = db
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  if (!streams.length) return result
  const runRows = rows<{
    work_stream_id: string
    run_status: string | null
    running_steps: string[] | null
    step_names: Record<string, string> | null
  }>(
    await executor.execute(sql`
      SELECT r.work_stream_id,
        CASE WHEN r.activated THEN r.state->>'status' END run_status,
        (SELECT jsonb_agg(a->>'stepId') FROM jsonb_array_elements(COALESCE(r.state->'attempts','[]'::jsonb)) a
          WHERE a->>'status'='running') running_steps,
        (SELECT jsonb_object_agg(s->>'id',s->>'name') FROM jsonb_array_elements(COALESCE(r.state->'definition'->'steps','[]'::jsonb)) s
          WHERE jsonb_typeof(s->'name')='string' AND jsonb_typeof(s->'id')='string') step_names
      FROM work_stream_flow_runs r
      WHERE r.work_stream_id IN (${sql.join(
        streams.map((stream) => sql`${stream.id}::uuid`),
        sql`,`
      )})
    `)
  )
  const runs = new Map(runRows.map((row) => [row.work_stream_id, row]))
  for (const stream of streams) {
    const run = runs.get(stream.id)
    result.set(
      stream.id,
      workStreamStepLabel({
        status: stream.status,
        runStatus: run?.run_status ?? null,
        runningStepIds: (run?.running_steps ?? []).filter((id): id is string => typeof id === 'string'),
        stepNames: run?.step_names ?? {},
      })
    )
  }
  return result
}

export interface ActivityRowRef {
  squadId: string
  item: Pick<SquadActivityItem, 'id' | 'ref'>
}

const rowKey = (squadId: string, id: string) => `${squadId}|${id}`

/**
 * Load context for agent rows and sender links for received-message rows, keyed by
 * `squadId|itemId`. Only same-squad facts are attached: a binding to another squad's
 * stream, or a sender from another squad, contributes nothing.
 */
export async function loadActivityRowFacts(
  entries: ActivityRowRef[],
  executor: Executor = db
): Promise<Map<string, ActivityRowFacts>> {
  const facts = new Map<string, ActivityRowFacts>()
  const agentIds = [
    ...new Set(entries.flatMap(({ item }) => (item.ref && item.ref.type === 'agent' ? [item.ref.agentId] : []))),
  ]
  const received = entries.flatMap(({ squadId, item }) => {
    const identity = parseSquadActivityId(item.id)
    return identity && (identity.lane === 20 || identity.lane === 22)
      ? [{ squadId, item, inboxId: identity.rowId }]
      : []
  })

  const [agentRows, senderRows] = await Promise.all([
    agentIds.length
      ? executor.execute(sql`
          SELECT a.id agent_id,a.squad_id,
            CASE WHEN jsonb_typeof(a.metadata->'purpose')='string' THEN a.metadata->>'purpose' END purpose,
            ws.id ws_id,ws.number ws_number,ws.title ws_title,ws.status ws_status,ws.squad_id ws_squad_id
          FROM agents a
          LEFT JOIN workflow_bindings b ON b.agent_id=a.id
          LEFT JOIN work_streams ws ON ws.id=b.work_stream_id AND ws.squad_id=a.squad_id
          WHERE a.id IN (${sql.join(
            agentIds.map((id) => sql`${id}::uuid`),
            sql`,`
          )})
        `)
      : [],
    received.length
      ? executor.execute(sql`
          SELECT i.id inbox_id,recipient.squad_id,e.id execution_id
          FROM inbox i
          JOIN agents sender ON i.sender_type='agent' AND sender.id=${uuidJoinKey(sql`i.sender_id`)}
          JOIN agents recipient ON recipient.id=${uuidJoinKey(sql`i.recipient_id`)} AND recipient.squad_id=sender.squad_id
          JOIN LATERAL (
            SELECT e.id FROM executions e
            WHERE e.agent_id=sender.id AND e.run_started_at IS NOT NULL AND e.run_started_at<=i.created_at
              AND (e.ended_at IS NULL OR e.ended_at>=i.created_at)
            ORDER BY e.run_started_at DESC,e.id DESC LIMIT 1
          ) e ON true
          WHERE i.id IN (${sql.join(
            [...new Set(received.map((entry) => entry.inboxId))].map((id) => sql`${id}::uuid`),
            sql`,`
          )})
        `)
      : [],
  ])

  const agentById = new Map(
    rows<{
      agent_id: string
      squad_id: string | null
      purpose: string | null
      ws_id: string | null
      ws_number: number | null
      ws_title: string | null
      ws_status: WorkStreamStatus | null
      ws_squad_id: string | null
    }>(agentRows).map((row) => [row.agent_id, row])
  )
  const streamIds = [...agentById.values()].flatMap((row) =>
    row.ws_id && row.ws_status ? [{ id: row.ws_id, status: row.ws_status }] : []
  )
  const steps = await loadWorkStreamSteps(
    [...new Map(streamIds.map((stream) => [stream.id, stream])).values()],
    executor
  )

  for (const { squadId, item } of entries) {
    if (!item.ref || item.ref.type !== 'agent') continue
    const agent = agentById.get(item.ref.agentId)
    if (!agent || agent.squad_id !== squadId) continue
    const entry: ActivityRowFacts = {}
    if (agent.ws_id && agent.ws_number !== null && agent.ws_status && agent.ws_squad_id === squadId)
      entry.workStream = {
        id: agent.ws_id,
        number: agent.ws_number,
        title: agent.ws_title ?? '',
        squadId: agent.ws_squad_id,
        status: agent.ws_status,
        step: steps.get(agent.ws_id) ?? null,
      }
    const purpose = agent.purpose?.trim()
    if (purpose) entry.purpose = purpose.slice(0, 200)
    if (entry.workStream || entry.purpose) facts.set(rowKey(squadId, item.id), entry)
  }

  const senderByInbox = new Map(
    rows<{ inbox_id: string; squad_id: string; execution_id: string }>(senderRows).map((row) => [row.inbox_id, row])
  )
  for (const { squadId, item, inboxId } of received) {
    const sender = senderByInbox.get(inboxId)
    if (!sender || sender.squad_id !== squadId) continue
    const key = rowKey(squadId, item.id)
    facts.set(key, { ...facts.get(key), senderActivityId: `10:${sender.execution_id}` })
  }
  return facts
}

/** Apply one viewer's access to a row's facts: stream context needs workstreams:read, the rest agents:read. */
export function redactActivityRowFacts(
  facts: ActivityRowFacts | undefined,
  access: Pick<SquadActivityAccess, 'agentsRead' | 'workstreamsRead'>
): { context?: ActivityRowContext; senderActivityId?: string } {
  if (!facts) return {}
  const context: ActivityRowContext = {}
  if (facts.workStream && access.workstreamsRead) context.workStream = facts.workStream
  if (facts.purpose && access.agentsRead) context.purpose = facts.purpose
  return {
    ...(context.workStream || context.purpose ? { context } : {}),
    ...(facts.senderActivityId && access.agentsRead ? { senderActivityId: facts.senderActivityId } : {}),
  }
}

/** Enrich an already-authorized page. Items keep their order; untouched items are returned as-is. */
export async function addActivityRowContext<T extends SquadActivityItem>(
  items: T[],
  squadIdOf: (item: T) => string,
  accessFor: (squadId: string) => Pick<SquadActivityAccess, 'agentsRead' | 'workstreamsRead'> | undefined
): Promise<T[]> {
  if (!items.length) return items
  const facts = await loadActivityRowFacts(items.map((item) => ({ squadId: squadIdOf(item), item })))
  if (!facts.size) return items
  return items.map((item) => {
    const squadId = squadIdOf(item)
    const access = accessFor(squadId)
    if (!access) return item
    const extra = redactActivityRowFacts(facts.get(rowKey(squadId, item.id)), access)
    return extra.context || extra.senderActivityId ? { ...item, ...extra } : item
  })
}
