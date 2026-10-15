import {
  activeWorkflowAttempts,
  type WorkflowRun,
  type InboxMessageSenderType,
  LIVE_AGENT_STATUSES,
} from '@ficus/shared'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { isInboxMessageWakeEligible } from '../../entities/InboxMessage'
import { awaitsCodeHostDelivery } from '../workflows/delivery-state'

export interface SquadDemandSnapshot {
  count: number
  firstDemandAt: Date | null
  /** Present only when every demand item has a known executable agent route. */
  agentIds?: string[]
}

const liveAgentStatusSql = sql.join(
  [...LIVE_AGENT_STATUSES].map((status) => sql`${status}`),
  sql`, `
)

/**
 * How long a stream agent's supervised background work counts as progress
 * without a fresh signal. An agent that waits on a long job through an
 * event-only monitor (or a managed local app plus periodic check-ins) is idle
 * between events, often for 30-45 minutes at a time, while the job advances.
 * Two hours is four times the 30-minute dead-fleet alert window, so such gaps
 * do not raise false stalls, while a monitor that has gone silent (or an app
 * whose owner stopped checking it) still raises a stall alert at most two hours
 * after its last sign of life rather than masking a real stall indefinitely.
 */
export const SUPERVISED_ACTIVITY_WINDOW_MS = 2 * 60 * 60_000

interface StreamDemand {
  createdAt: string
  metadata: unknown
  participants: string[]
  busy: boolean
  waits: Array<{ flowAttemptId: number | null }>
  state: WorkflowRun | null
  attemptAgents: Record<string, string>
  /**
   * Stream agents (assignee, participants, flow attempt agents) whose supervised
   * background work proves progress within {@link SUPERVISED_ACTIVITY_WINDOW_MS}:
   * a running monitor with recent output or (re)launch, or a running managed
   * local app the agent created in the stream's squad while the agent ran recently.
   */
  supervisingAgents?: string[]
}

/** Match workflow dispatch: a blocked branch must not hide a runnable sibling. */
export function hasRunnableStreamDemand(stream: StreamDemand): boolean {
  if (stream.waits.some((wait) => wait.flowAttemptId == null)) return false
  const supervising = new Set(stream.supervisingAgents ?? [])
  // Without a per-attempt owner, any stream agent's live background work is the stream's progress.
  if (!stream.state)
    return !stream.busy && stream.waits.length === 0 && stream.participants.length > 0 && supervising.size === 0
  if (stream.state.status === 'paused' || awaitsCodeHostDelivery(stream.state, stream.metadata)) return false
  if (stream.state.status === 'completion-ready') {
    // Human delivery approval is external; missing PR/delivery setup still needs an agent.
    return (
      !stream.busy &&
      stream.state.definition.completion.mode !== 'review-approval' &&
      stream.participants.length > 0 &&
      supervising.size === 0
    )
  }
  if (stream.state.status !== 'running') return false
  return activeWorkflowAttempts(stream.state).some((attempt) => {
    const step = attempt.step ?? stream.state!.definition.steps.find((step) => step.id === attempt.stepId)
    const attemptAgent = stream.attemptAgents[String(attempt.id)]
    return (
      step?.kind === 'agent' &&
      !stream.waits.some((wait) => wait.flowAttemptId === attempt.id) &&
      // A live agent idle between events of work it supervises is progressing, not stalled.
      (!attemptAgent || (stream.participants.includes(attemptAgent) && !supervising.has(attemptAgent)))
    )
  })
}

interface InboxDemand {
  id: string
  recipientId: string
  senderType: InboxMessageSenderType
  metadata: Record<string, unknown>
  createdAt: string
  agentStatus: string
}

interface DemandRow extends Record<string, unknown> {
  squadId: string
  count: number | string
  firstDemandAt: Date | string | null
  streams: StreamDemand[] | null
  agentIds: string[] | null
  unknownRoutes: boolean
  messages: InboxDemand[] | null
}

/**
 * Returns a base database snapshot plus shared delivery-policy rechecks for
 * every active squad, including explicit zero-demand entries. Demand is executable backlog, not merely a
 * row that exists in an operational table.
 */
export async function getSquadDemandSnapshots(input: { now: Date }): Promise<Map<string, SquadDemandSnapshot>> {
  const now = input.now.toISOString()
  const activityCutoff = new Date(input.now.getTime() - SUPERVISED_ACTIVITY_WINDOW_MS).toISOString()
  const rows = await db.execute<DemandRow>(sql`
    WITH active_squads AS (
      SELECT id, manager_agent_id
      FROM squads
      WHERE status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM instance_maintenance_state AS maintenance
          WHERE maintenance.id = 'global'
            AND (
              maintenance.admin_hold = true
              OR maintenance.platform_lease_expires_at > ${now}::timestamptz
            )
        )
    ), paused_agents AS (
      SELECT agent.id FROM agents AS agent
      WHERE EXISTS (
        SELECT 1 FROM work_streams AS stream
        WHERE stream.status IN ('active', 'queued') AND stream.pause IS NOT NULL
          AND (stream.assignee_agent_id = agent.id OR stream.agent_ids @> ARRAY[agent.id])
      )
    ), eligible_inbox AS (
      SELECT message.*, agent.squad_id, agent.status AS agent_status
      FROM inbox AS message
      -- Cast the text side, not agents.id: a cast on the indexed side makes
      -- this unsargable and forces a sequential scan of the agents table.
      -- The regex guard cannot be dropped in favour of the recipient_type
      -- filter below: a hash join may evaluate this join condition on rows
      -- that filter would later reject, and recipient_id is the literal
      -- 'system' on those, which a bare cast would raise on.
      JOIN agents AS agent
        ON agent.id = (CASE WHEN message.recipient_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                            THEN message.recipient_id::uuid END)
      JOIN active_squads AS squad ON squad.id = agent.squad_id
      WHERE message.recipient_type = 'agent'
        AND message.read_at IS NULL
        AND message.delivered_at IS NULL
        -- Delivery leaves terminated recipients' inbox history untouched.
        -- Those messages cannot run, just like their queued executions above.
        AND agent.status <> 'terminated'
        AND NOT EXISTS (SELECT 1 FROM paused_agents WHERE id = agent.id)
        AND agent.pending_dormancy_at IS NULL
        -- Observer delivery is informational and never starts an execution.
        AND message.metadata->>'source' IS DISTINCT FROM 'work-stream-observer'
    ), demand AS (
      SELECT agent.squad_id, execution.started_at AS demanded_at, agent.id AS agent_id
      FROM executions AS execution
      JOIN agents AS agent ON agent.id = execution.agent_id
      JOIN active_squads AS squad ON squad.id = agent.squad_id
      WHERE execution.status = 'queued'
        AND (execution.startup_retry_at IS NULL OR execution.startup_retry_at <= ${now}::timestamptz)
        -- Match pickup's lifecycle gates, not merely the existence of a row.
        AND agent.status <> 'terminated'
        AND agent.pending_dormancy_at IS NULL
        AND (agent.status <> 'dormant' OR execution.wake_eligible)
        AND NOT EXISTS (SELECT 1 FROM paused_agents WHERE id = agent.id)

      UNION ALL

      SELECT CASE
          WHEN schedule.scope_type = 'agent' THEN scoped_agent.squad_id
          ELSE schedule.scope_id
        END AS squad_id,
        schedule.next_trigger_at AS demanded_at, NULL::uuid AS agent_id
      FROM schedules AS schedule
      LEFT JOIN agents AS scoped_agent
        ON schedule.scope_type = 'agent'
       AND scoped_agent.id = schedule.scope_id
      JOIN active_squads AS squad
        ON squad.id = CASE
          WHEN schedule.scope_type = 'agent' THEN scoped_agent.squad_id
          ELSE schedule.scope_id
        END
      WHERE schedule.enabled = true
        AND schedule.next_trigger_at IS NOT NULL
        AND schedule.next_trigger_at <= ${now}::timestamptz
        AND (schedule.scope_type <> 'agent' OR scoped_agent.status::text IN (${liveAgentStatusSql}))
        -- Match schedule lifecycle/reference gates: unavailable inbox targets
        -- cannot create executable work even before lifecycle reconciliation.
        AND (schedule.action->>'type' <> 'inbox_message' OR EXISTS (
          SELECT 1 FROM agents AS target
          WHERE target.status::text IN (${liveAgentStatusSql})
            AND target.pending_dormancy_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM paused_agents WHERE id = target.id)
            AND target.id::text = CASE
              WHEN schedule.action->'target'->>'type' = 'agent' THEN schedule.action->'target'->>'agentId'
              ELSE squad.manager_agent_id::text END
        ))
        AND (
          (schedule.scope_type = 'agent' AND schedule.action->>'type' = 'inbox_message')
          OR
          (schedule.scope_type = 'squad' AND schedule.action->>'type' IN ('inbox_message', 'spawn_agent', 'create_work_stream'))
        )
        AND NOT (
          (
            schedule.action->>'type' = 'create_work_stream'
            OR (
              schedule.action->>'type' = 'spawn_agent'
              AND schedule.action->'workStream' IS NOT NULL
              AND schedule.action->'workStream' <> 'null'::jsonb
            )
          )
          AND schedule.schedule->>'skipIfUnresolved' IS DISTINCT FROM 'false'
          AND EXISTS (
            SELECT 1
            FROM work_streams AS prior
            WHERE prior.metadata->>'scheduleId' = schedule.id::text
              AND prior.status NOT IN ('done', 'canceled')
          )
        )

    ), aggregate_demand AS (
      SELECT squad_id, count(*)::integer AS count, min(demanded_at) AS first_demand_at,
        array_agg(DISTINCT agent_id) FILTER (WHERE agent_id IS NOT NULL) AS agent_ids,
        bool_or(agent_id IS NULL) AS unknown_routes
      FROM demand
      GROUP BY squad_id
    )
    , stream_candidates AS (
      SELECT stream.squad_id, jsonb_build_object(
        'createdAt', stream.created_at, 'metadata', stream.metadata,
        'busy', EXISTS (SELECT 1 FROM executions AS execution JOIN agents AS participant ON participant.id = execution.agent_id
          WHERE participant.squad_id = stream.squad_id
            AND (participant.id = stream.assignee_agent_id OR participant.id = ANY(COALESCE(stream.agent_ids, '{}'::uuid[])))
            AND execution.status IN ('queued', 'running', 'stopping', 'waiting-maintenance', 'waiting-sandbox')),
        'state', CASE WHEN flow.activated THEN flow.state ELSE NULL END,
        'attemptAgents', COALESCE(flow.attempt_agents, '{}'::jsonb),
        'waits', (SELECT COALESCE(jsonb_agg(jsonb_build_object('flowAttemptId', wait.flow_attempt_id)), '[]'::jsonb)
          FROM work_stream_waits AS wait WHERE wait.work_stream_id = stream.id AND wait.closed_at IS NULL),
        -- Idle agents whose supervised background work is still advancing
        -- (see SUPERVISED_ACTIVITY_WINDOW_MS). Liveness is the supervisors':
        -- a monitor leaves 'running' once its process is lost, and a local app
        -- leaves 'running' when its health poll fails.
        'supervisingAgents', (SELECT COALESCE(jsonb_agg(owner.id), '[]'::jsonb)
          FROM agents AS owner
          WHERE owner.squad_id = stream.squad_id
            AND (owner.id = stream.assignee_agent_id OR owner.id = ANY(COALESCE(stream.agent_ids, '{}'::uuid[]))
              OR owner.id::text IN (SELECT value FROM jsonb_each_text(COALESCE(flow.attempt_agents, '{}'::jsonb))))
            AND (
              EXISTS (SELECT 1 FROM monitors AS monitor
                WHERE monitor.agent_id = owner.id AND monitor.status = 'running'
                  -- Output or a (re)launch is the freshness signal: a monitor
                  -- that stays silent past the window no longer masks a stall.
                  AND GREATEST(monitor.last_batch_at, monitor.launched_at, monitor.started_at, monitor.created_at)
                    >= ${activityCutoff}::timestamptz)
              OR EXISTS (SELECT 1 FROM local_deployments AS app
                WHERE app.created_by_agent_id = owner.id AND app.squad_id = stream.squad_id
                  AND app.archived_at IS NULL AND app.mode = 'managed' AND app.status = 'running'
                  -- An app has no output signal here, so it counts only while it
                  -- recently (re)started or its owner recently checked in.
                  AND (app.updated_at >= ${activityCutoff}::timestamptz OR EXISTS (
                    SELECT 1 FROM executions AS execution
                    WHERE execution.agent_id = owner.id
                      AND execution.run_started_at >= ${activityCutoff}::timestamptz
                      AND execution.run_started_at <= ${now}::timestamptz)))
            )),
        'participants', (SELECT COALESCE(jsonb_agg(participant.id), '[]'::jsonb)
          FROM agents AS participant
          WHERE participant.squad_id = stream.squad_id
            AND participant.pending_dormancy_at IS NULL
            AND participant.status::text IN (${liveAgentStatusSql})
            AND (participant.id = stream.assignee_agent_id OR participant.id = ANY(COALESCE(stream.agent_ids, '{}'::uuid[])))
            AND NOT EXISTS (SELECT 1 FROM paused_agents WHERE id = participant.id)
            AND NOT EXISTS (SELECT 1 FROM executions AS execution
              WHERE execution.agent_id = participant.id AND execution.status IN
                ('queued', 'running', 'stopping', 'waiting-maintenance', 'waiting-sandbox')))
      ) AS candidate
      FROM work_streams AS stream
      JOIN active_squads AS squad ON squad.id = stream.squad_id
      LEFT JOIN work_stream_flow_runs AS flow ON flow.work_stream_id = stream.id
      WHERE stream.status = 'active' AND stream.pause IS NULL
    )
    SELECT squad.id AS "squadId",
      COALESCE(aggregate.count, 0)::integer AS count,
      aggregate.first_demand_at AS "firstDemandAt",
      aggregate.agent_ids AS "agentIds", COALESCE(aggregate.unknown_routes, false) AS "unknownRoutes",
      (SELECT jsonb_agg(jsonb_build_object('id', message.id, 'recipientId', message.recipient_id,
        'senderType', message.sender_type, 'metadata', jsonb_build_object(
          'source', message.metadata->'source', 'wakeEligible', message.metadata->'wakeEligible',
          'workStreamId', message.metadata->'workStreamId', 'attemptId', message.metadata->'attemptId',
          'integrationDeliveryId', message.metadata->'integrationDeliveryId', 'questionId', message.metadata->'questionId'),
        'createdAt', message.created_at,
        'agentStatus', message.agent_status)) FROM eligible_inbox AS message WHERE message.squad_id = squad.id) AS messages,
      (SELECT jsonb_agg(candidate) FROM stream_candidates WHERE squad_id = squad.id) AS streams
    FROM active_squads AS squad
    LEFT JOIN aggregate_demand AS aggregate ON aggregate.squad_id = squad.id
  `)

  // Use delivery's authoritative policy for integration subscriptions, question
  // origins, and attempt gates. Never inspect payloads or mutate inbox history.
  const { isCurrentFlowMessage } = await import('../workflows/execution')
  const snapshots = new Map<string, SquadDemandSnapshot>()
  for (const row of rows) {
    const eligible: InboxDemand[] = []
    for (const message of row.messages ?? []) {
      if (await isCurrentFlowMessage(message)) eligible.push(message)
    }
    const wakingAgents = new Set(eligible.filter(isInboxMessageWakeEligible).map((message) => message.recipientId))
    const messages = eligible.filter(
      (message) => message.agentStatus !== 'dormant' || wakingAgents.has(message.recipientId)
    )
    const streams = (row.streams ?? []).filter(hasRunnableStreamDemand)
    const dates = [
      ...streams.map((stream) => new Date(stream.createdAt).getTime()),
      ...messages.map((message) => new Date(message.createdAt).getTime()),
    ]
    if (row.firstDemandAt) dates.push(new Date(row.firstDemandAt).getTime())
    // An undispatched stream or a schedule may still need routing/spawning.
    // Keep its demand, but do not invent a provider explanation for it.
    snapshots.set(row.squadId, {
      count: Number(row.count) + messages.length + streams.length,
      firstDemandAt: dates.length ? new Date(Math.min(...dates)) : null,
      ...(!row.unknownRoutes && streams.length === 0 && dates.length > 0
        ? { agentIds: [...new Set([...(row.agentIds ?? []), ...messages.map((message) => message.recipientId)])] }
        : {}),
    })
  }
  return snapshots
}
