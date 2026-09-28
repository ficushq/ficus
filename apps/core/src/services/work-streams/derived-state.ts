import { and, desc, inArray, isNotNull } from 'drizzle-orm'
import {
  WORK_STREAM_WAIT_DISPLAY_PRECEDENCE,
  WORK_STREAM_WAIT_STATE,
  workStreamWaitDisplayType,
  selectWorkStreamPresentationState,
  type WorkStreamDeliveryPresentation,
  type WorkStreamDerivedState,
  type WorkStreamStatus,
  type WorkStreamTerminalFailure,
  type WorkStreamWait,
} from '@ficus/shared'
import { db } from '../../db'
import { executions } from '../../db/schema'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { collectWorkStreamAgentIds } from './agent-ids'
import { listOpenWaitsForStreams, toWaitJson } from './waits'
import { loadDeliveryPresentations } from '../workflows/delivery-state'
import { flowWaitReference } from '../workflows/wait-policy'

/**
 * Display-state derivation (spec: computed in serializers, never stored).
 *
 * Precedence, pinned:
 * 1. terminal status (done/canceled)
 * 2. open wait, by type: review > question > dependency > manual — the wait
 *    is the actionable fact, so it wins even while an execution runs
 * 3. active + live execution for any assigned agent -> in_progress
 * 4. active + newest terminal execution of an assigned agent failed in a way
 *    that needs attention -> execution_failed (platform admission refusal,
 *    unclassified/legacy failure, or a provider failure; transport is
 *    excluded because the continuation watchdog auto-continues it)
 * 5. active, nothing else -> idle (the only alarming display)
 * 6. queued -> queued (clients render position / parked wait from
 *    queuePosition + openWaits)
 */

export interface DerivedStreamInfo {
  delivery?: WorkStreamDeliveryPresentation
  derivedState: WorkStreamDerivedState
  /** Open waits, display precedence first (then newest first within a type). */
  openWaits: WorkStreamWait[]
  /**
   * Present only for derivedState 'execution_failed': the newest terminal
   * failed execution the display state was derived from. Clearing is
   * deterministic — any newer terminal outcome (or a live execution) replaces
   * the display state and this field.
   */
  terminalFailure?: WorkStreamTerminalFailure
}

export function sortWaitsByDisplayPrecedence(waits: WorkStreamWait[]): WorkStreamWait[] {
  return [...waits].sort((a, b) => {
    const rank =
      WORK_STREAM_WAIT_DISPLAY_PRECEDENCE.indexOf(workStreamWaitDisplayType(a)) -
      WORK_STREAM_WAIT_DISPLAY_PRECEDENCE.indexOf(workStreamWaitDisplayType(b))
    if (rank !== 0) return rank
    return b.openedAt.localeCompare(a.openedAt)
  })
}

interface StreamShape {
  pause?: unknown
  id: string
  status: WorkStreamStatus
  assigneeAgentId: string | null
  agentIds: string[] | null
}

export interface DerivedStateDeps {
  loadDelivery?: (ids: string[]) => Promise<Map<string, WorkStreamDeliveryPresentation>>
  /** Agent ids that currently have a live (active-status) execution. */
  loadBusyAgentIds?: (agentIds: string[]) => Promise<Set<string>>
  /** Newest attention-worthy terminal failure per agent (test seam). */
  loadSurfacedFailures?: (agentIds: string[]) => Promise<Map<string, WorkStreamTerminalFailure>>
}

async function defaultLoadBusyAgentIds(agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set()
  const rows = await db
    .select({ agentId: executions.agentId })
    .from(executions)
    .where(and(inArray(executions.agentId, agentIds), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
  return new Set(rows.map((r) => r.agentId))
}

/**
 * The newest TERMINAL execution per agent (any terminal status — newest wins,
 * so a newer completed/stopped outcome deterministically clears an older
 * failure), surfaced only when it is a failed row whose stored class is not
 * `provider_transport` (transport is auto-continued by the continuation
 * watchdog, so it must not read as an attention-needing failure). Legacy NULL
 * rows count as unclassified and ARE surfaced — those failed rows are exactly
 * the ambiguous `idle` cases this state exists to expose.
 */
async function defaultLoadSurfacedFailures(agentIds: string[]): Promise<Map<string, WorkStreamTerminalFailure>> {
  const surfaced = new Map<string, WorkStreamTerminalFailure>()
  if (agentIds.length === 0) return surfaced
  const rows = await db
    .selectDistinctOn([executions.agentId], {
      executionId: executions.id,
      agentId: executions.agentId,
      status: executions.status,
      failureClass: executions.failureClass,
      failureReason: executions.failureReason,
      endedAt: executions.endedAt,
    })
    .from(executions)
    .where(
      and(
        inArray(executions.agentId, agentIds),
        inArray(executions.status, ['completed', 'failed', 'stopped']),
        isNotNull(executions.endedAt)
      )
    )
    .orderBy(executions.agentId, desc(executions.endedAt), desc(executions.id))
  for (const row of rows) {
    if (row.status !== 'failed') continue
    if (row.failureClass === 'provider_transport') continue
    surfaced.set(row.agentId, {
      executionId: row.executionId,
      failureClass: row.failureClass,
      failureReason: row.failureReason,
      endedAt: row.endedAt!,
    })
  }
  return surfaced
}

/**
 * Compute derived display states + open waits for a batch of streams. The
 * execution probes run only for `active` streams with no open wait (the only
 * cases where they decide in_progress / execution_failed vs idle), and the
 * failure probe only for agents that are not busy.
 */
export async function computeDerivedStates(
  streams: StreamShape[],
  deps: DerivedStateDeps = {}
): Promise<Map<string, DerivedStreamInfo>> {
  const result = new Map<string, DerivedStreamInfo>()
  if (streams.length === 0) return result

  const ids = streams.map((s) => s.id)
  const [waitsByStream, deliveryByStream] = await Promise.all([
    listOpenWaitsForStreams(ids),
    (deps.loadDelivery ?? ((ids) => loadDeliveryPresentations(db, ids)))(ids),
  ])

  const executionCandidates = streams.filter(
    (s) => !s.pause && s.status === 'active' && (waitsByStream.get(s.id)?.length ?? 0) === 0
  )
  const probeAgentIds = [...new Set(executionCandidates.flatMap(collectWorkStreamAgentIds))]
  const loadBusy = deps.loadBusyAgentIds ?? defaultLoadBusyAgentIds
  const busyAgents = await loadBusy(probeAgentIds)

  const idleProbeAgentIds = probeAgentIds.filter((id) => !busyAgents.has(id))
  const loadSurfaced = deps.loadSurfacedFailures ?? defaultLoadSurfacedFailures
  const surfacedFailures = await loadSurfaced(idleProbeAgentIds)

  for (const stream of streams) {
    const openWaits = sortWaitsByDisplayPrecedence((waitsByStream.get(stream.id) ?? []).map(toWaitJson))

    let delivery = deliveryByStream.get(stream.id)
    if (delivery?.kind === 'approval') {
      const approval = openWaits.find(
        (wait) =>
          wait.type === 'manual' &&
          wait.resolutionHandler === 'workflow' &&
          wait.referenceId === flowWaitReference(stream.id, 'delivery', 0)
      )
      if (approval) delivery = { ...delivery, approvalWaitId: approval.id }
    }

    let derivedState: WorkStreamDerivedState
    let terminalFailure: WorkStreamTerminalFailure | undefined
    if (stream.status === 'done' || stream.status === 'canceled') {
      derivedState = stream.status
    } else if (stream.pause) {
      derivedState = 'paused'
    } else if (openWaits.length > 0) {
      derivedState = WORK_STREAM_WAIT_STATE[workStreamWaitDisplayType(openWaits[0])]
    } else if (stream.status === 'active') {
      const agentIds = collectWorkStreamAgentIds(stream)
      if (agentIds.some((id) => busyAgents.has(id))) {
        derivedState = 'in_progress'
      } else {
        const failure = agentIds.map((id) => surfacedFailures.get(id)).find(Boolean)
        if (failure) {
          derivedState = 'execution_failed'
          terminalFailure = failure
        } else {
          derivedState = 'idle'
        }
      }
    } else {
      derivedState = 'queued'
    }

    const presentation = selectWorkStreamPresentationState({ ...stream, derivedState, openWaits, delivery })
    // Keep the existing derived vocabulary for older consumers. New consumers
    // retain the typed delivery fact even with an explicit empty wait list.
    const deliveryStates = {
      delivery_approval: 'in_review',
      delivery_review: 'in_review',
      delivery_merge: 'in_review',
      delivery_external: 'waiting_on_dependency',
      delivery_setup: 'blocked',
      delivery_failure: 'blocked',
    } as const
    derivedState =
      presentation in deliveryStates
        ? deliveryStates[presentation as keyof typeof deliveryStates]
        : (presentation as WorkStreamDerivedState)
    result.set(stream.id, {
      derivedState,
      openWaits,
      ...(delivery ? { delivery } : {}),
      ...(terminalFailure ? { terminalFailure } : {}),
    })
  }
  return result
}
