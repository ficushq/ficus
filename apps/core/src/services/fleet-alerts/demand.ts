import { activeWorkflowAttempts, type WorkflowRun, LIVE_AGENT_STATUSES } from '@ficus/shared'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { awaitsCodeHostDelivery } from '../workflows/delivery-state'

export interface SquadDemandSnapshot {
  count: number
  firstDemandAt: Date | null
}

const liveAgentStatusSql = sql.join(
  [...LIVE_AGENT_STATUSES].map((status) => sql`${status}`),
  sql`, `
)

interface StreamDemand {
  createdAt: string
  metadata: unknown
  participants: string[]
  busy: boolean
  waits: Array<{ flowAttemptId: number | null }>
  state: WorkflowRun | null
  attemptAgents: Record<string, string>
}

/** Match workflow dispatch: a blocked branch must not hide a runnable sibling. */
export function hasRunnableStreamDemand(stream: StreamDemand): boolean {
  if (stream.waits.some((wait) => wait.flowAttemptId == null)) return false
  if (!stream.state) return !stream.busy && stream.waits.length === 0 && stream.participants.length > 0
  if (stream.state.status === 'paused' || awaitsCodeHostDelivery(stream.state, stream.metadata)) return false
  if (stream.state.status === 'completion-ready') {
    // Human delivery approval is external; missing PR/delivery setup still needs an agent.
    return (
      !stream.busy && stream.state.definition.completion.mode !== 'review-approval' && stream.participants.length > 0
    )
  }
  if (stream.state.status !== 'running') return false
  return activeWorkflowAttempts(stream.state).some((attempt) => {
    const step = attempt.step ?? stream.state!.definition.steps.find((step) => step.id === attempt.stepId)
    return (
      step?.kind === 'agent' &&
      !stream.waits.some((wait) => wait.flowAttemptId === attempt.id) &&
      (!stream.attemptAgents[String(attempt.id)] ||
        stream.participants.includes(stream.attemptAgents[String(attempt.id)]!))
    )
  })
}

interface DemandRow extends Record<string, unknown> {
  squadId: string
  count: number | string
  firstDemandAt: Date | string | null
  streams: StreamDemand[] | null
}

/**
 * Returns one bounded database snapshot for every active squad, including
 * explicit zero-demand entries. Demand is executable backlog, not merely a
 * row that exists in an operational table.
 */
export async function getSquadDemandSnapshots(input: { now: Date }): Promise<Map<string, SquadDemandSnapshot>> {
  const now = input.now.toISOString()
  const rows = await db.execute<DemandRow>(sql`
    WITH active_squads AS (
      SELECT id
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
        -- Workflow assignment messages are intentionally held at input gates.
        -- Superseded attempts are history, not runnable inbox demand.
        AND (message.metadata->>'source' IS DISTINCT FROM 'work-stream-resume' OR EXISTS (
          SELECT 1 FROM work_streams AS resumed
          WHERE resumed.id::text = message.metadata->>'workStreamId'
            AND resumed.status = 'active' AND resumed.pause IS NULL
        ))
        AND (COALESCE(message.metadata->>'source', '') NOT IN ('workflow', 'workflow-wait-resolution') OR EXISTS (
          SELECT 1 FROM work_stream_flow_runs AS flow
          JOIN work_streams AS stream ON stream.id = flow.work_stream_id
          CROSS JOIN LATERAL jsonb_array_elements(flow.state->'attempts') AS attempt
          WHERE stream.id::text = message.metadata->>'workStreamId'
            AND flow.activated
            AND (message.metadata->>'source' <> 'workflow' OR
              (stream.status = 'active' AND stream.pause IS NULL AND flow.state->>'status' = 'running'))
            AND attempt->>'status' = 'running'
            AND attempt->>'id' = message.metadata->>'attemptId'
            AND flow.attempt_agents->>(attempt->>'id') = message.recipient_id
            AND (message.metadata->>'source' <> 'workflow' OR NOT EXISTS (SELECT 1 FROM work_stream_waits AS wait
              WHERE wait.work_stream_id = stream.id AND wait.closed_at IS NULL
                AND (wait.flow_attempt_id IS NULL OR wait.flow_attempt_id::text = attempt->>'id')))
        ))
    ), demand AS (
      SELECT agent.squad_id, execution.started_at AS demanded_at
      FROM executions AS execution
      JOIN agents AS agent ON agent.id = execution.agent_id
      JOIN active_squads AS squad ON squad.id = agent.squad_id
      WHERE execution.status = 'queued'
        AND (execution.startup_retry_at IS NULL OR execution.startup_retry_at <= ${now}::timestamptz)
        -- A TERMINATED agent can never serve its queued rows (pickup fails
        -- them on sight), so counting them as demand alerted eternally about
        -- work no live agent exists to run (the 2026-09-04 dead-fleet
        -- incident). A DORMANT agent stays counted: pickup wakes it for
        -- wake-eligible work, so its demand is genuine and must still alert.
        -- Executions whose agent row is gone are structurally excluded by the
        -- inner join — belt and braces for FK-bypassed orphan rows.
        AND agent.status <> 'terminated'
        AND NOT EXISTS (SELECT 1 FROM paused_agents WHERE id = agent.id)

      UNION ALL

      SELECT message.squad_id, message.created_at AS demanded_at
      FROM eligible_inbox AS message
      -- Delivery wakes the entire eligible batch when any message can wake it.
      WHERE message.agent_status <> 'dormant' OR EXISTS (
        SELECT 1 FROM eligible_inbox AS wake WHERE wake.recipient_id = message.recipient_id
          AND CASE WHEN jsonb_typeof(wake.metadata->'wakeEligible') = 'boolean'
            THEN (wake.metadata->>'wakeEligible')::boolean ELSE wake.sender_type <> 'system' END
      )

      UNION ALL

      SELECT CASE
          WHEN schedule.scope_type = 'agent' THEN scoped_agent.squad_id
          ELSE schedule.scope_id
        END AS squad_id,
        schedule.next_trigger_at AS demanded_at
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
      SELECT squad_id, count(*)::integer AS count, min(demanded_at) AS first_demand_at
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
        'participants', (SELECT COALESCE(jsonb_agg(participant.id), '[]'::jsonb)
          FROM agents AS participant
          WHERE participant.squad_id = stream.squad_id
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
      (SELECT jsonb_agg(candidate) FROM stream_candidates WHERE squad_id = squad.id) AS streams
    FROM active_squads AS squad
    LEFT JOIN aggregate_demand AS aggregate ON aggregate.squad_id = squad.id
  `)

  return new Map(
    rows.map((row) => {
      const streams = (row.streams ?? []).filter(hasRunnableStreamDemand)
      const dates = streams.map((stream) => new Date(stream.createdAt).getTime())
      if (row.firstDemandAt) dates.push(new Date(row.firstDemandAt).getTime())
      return [
        row.squadId,
        {
          count: Number(row.count) + streams.length,
          firstDemandAt: dates.length ? new Date(Math.min(...dates)) : null,
        },
      ]
    })
  )
}
