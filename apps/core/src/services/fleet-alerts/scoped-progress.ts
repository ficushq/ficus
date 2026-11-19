import { sql } from 'drizzle-orm'
import { db } from '../../db'

export interface StreamDemandRoute {
  key: string
  streamId: string
  agentId?: string
  attemptId?: number
  responseRequestId?: string
  readyAt: Date
}

interface ClockRow extends Record<string, unknown> {
  key: string
  unservedSince: Date | string
  progressAt: Date | string | null
  running: boolean
  slotWaiting: boolean
}

/**
 * Compute one clock per runnable route, not a squad-wide activity maximum.
 * The latest attributed execution's start, assistant steps and successful end
 * survive turn boundaries. Dispatch and closed admission waits start a fresh
 * eligibility window without pretending that an execution already ran.
 */
export async function getStreamDemandClocks(routes: StreamDemandRoute[], now: Date) {
  if (routes.length === 0) return new Map<string, ClockRow>()
  const rows = await db.execute<ClockRow>(sql`
    WITH routes(key, stream_id, agent_id, attempt_id, request_id, ready_at) AS (VALUES ${sql.join(
      routes.map(
        (route) => sql`(${route.key}::text, ${route.streamId}::uuid, ${route.agentId ?? null}::uuid,
        ${route.attemptId ?? null}::integer, ${route.responseRequestId ?? null}::uuid, ${route.readyAt.toISOString()}::timestamptz)`
      ),
      sql`, `
    )})
    SELECT route.key,
      GREATEST(route.ready_at, dispatch.created_at, receipt.created_at, closed_wait.closed_at,
        admission.ready_at, progress.at) AS "unservedSince",
      progress.at AS "progressAt", COALESCE(execution.status IN ('running', 'stopping'), false) AS running,
      EXISTS (
        -- Match loadSlotWaitingStreams attribution: the subscription must have
        -- been enqueued inside an execution of this still-current pinned attempt.
        -- This bounds the alert exemption, not the actual durable subscription.
        SELECT 1 FROM slot_waiters AS waiter
        JOIN slot_pools AS pool ON pool.id = waiter.pool_id
        JOIN agents AS owner ON owner.id = waiter.owner_agent_id AND owner.squad_id = pool.squad_id
        JOIN work_stream_flow_runs AS flow ON flow.work_stream_id = route.stream_id
          AND flow.activated AND flow.state->>'status' = 'running'
          AND flow.attempt_agents->>route.attempt_id::text = route.agent_id::text
        JOIN executions AS origin ON origin.agent_id = waiter.owner_agent_id
          AND origin.started_at <= waiter.queued_at
          AND (origin.ended_at IS NULL OR origin.ended_at >= waiter.queued_at)
          AND origin.flow_context->>'workStreamId' = route.stream_id::text
          AND origin.flow_context->>'attemptId' = route.attempt_id::text
        WHERE waiter.owner_agent_id = route.agent_id AND waiter.status = 'queued'
          AND waiter.ended_at IS NULL AND waiter.resulting_claim_id IS NULL
          AND pool.disabled_at IS NULL AND pool.unregistered_at IS NULL
          AND owner.status NOT IN ('dormant', 'terminated')
          AND waiter.queued_at <= ${now.toISOString()}::timestamptz
          AND waiter.queued_at > ${now.toISOString()}::timestamptz - pool.claim_timeout_ms * interval '1 millisecond'
      ) AS "slotWaiting"
    FROM routes AS route
    LEFT JOIN LATERAL (
      SELECT created_at FROM inbox
      WHERE idempotency_key = 'flow:' || route.stream_id::text || ':' || route.attempt_id::text
        AND recipient_type = 'agent' AND sender_type = 'system'
        AND (route.agent_id IS NULL OR recipient_id = route.agent_id::text)
        AND created_at <= ${now.toISOString()}::timestamptz
      LIMIT 1
    ) AS dispatch ON true
    LEFT JOIN work_stream_flow_transitions AS receipt
      ON receipt.work_stream_id = route.stream_id AND receipt.request_id = route.request_id
        AND receipt.created_at <= ${now.toISOString()}::timestamptz
    LEFT JOIN LATERAL (
      SELECT MAX(closed_at) AS closed_at FROM work_stream_waits
      WHERE work_stream_id = route.stream_id
        AND (flow_attempt_id IS NULL OR flow_attempt_id = route.attempt_id)
        AND closed_at <= ${now.toISOString()}::timestamptz
    ) AS closed_wait ON true
    LEFT JOIN LATERAL (
      SELECT MAX(waiter.ended_at) AS ready_at FROM slot_waiters AS waiter
      JOIN slot_pools AS pool ON pool.id = waiter.pool_id
      JOIN agents AS owner ON owner.id = route.agent_id AND owner.squad_id = pool.squad_id
      WHERE waiter.owner_agent_id = route.agent_id AND waiter.status IN ('granted', 'canceled')
        AND waiter.ended_at <= ${now.toISOString()}::timestamptz
    ) AS admission ON true
    LEFT JOIN LATERAL (
      SELECT execution.id, execution.agent_id, execution.status, execution.run_started_at, execution.ended_at
      FROM executions AS execution
      WHERE execution.agent_id = route.agent_id
        AND execution.run_started_at IS NOT NULL AND execution.run_started_at <= ${now.toISOString()}::timestamptz
        AND (
          (execution.flow_context->>'workStreamId' = route.stream_id::text
            AND (route.attempt_id IS NULL OR execution.flow_context->>'attemptId' = route.attempt_id::text))
          OR (execution.flow_context IS NULL AND NOT EXISTS (
            -- Legacy executions lack pinned provenance. Only an unambiguous
            -- owner/stream association may use their progress as a fallback.
            SELECT 1 FROM work_streams AS other
            WHERE other.id <> route.stream_id AND other.status IN ('active', 'queued')
              AND (other.assignee_agent_id = route.agent_id OR route.agent_id = ANY(COALESCE(other.agent_ids, '{}'::uuid[])))
          ))
        )
      ORDER BY execution.run_started_at DESC, execution.started_at DESC, execution.id DESC
      LIMIT 1
    ) AS execution ON true
    LEFT JOIN LATERAL (
      SELECT GREATEST(execution.run_started_at,
        CASE WHEN execution.status = 'completed' AND execution.ended_at <= ${now.toISOString()}::timestamptz
          THEN execution.ended_at END,
        (SELECT message.created_at FROM messages AS message
          WHERE message.agent_id = execution.agent_id AND message.role = 'assistant'
            AND message.metadata->>'executionId' = execution.id::text
            AND message.created_at >= execution.run_started_at AND message.created_at <= ${now.toISOString()}::timestamptz
          ORDER BY message.created_at DESC LIMIT 1)) AS at
    ) AS progress ON true
  `)
  return new Map(rows.map((row) => [row.key, row]))
}
