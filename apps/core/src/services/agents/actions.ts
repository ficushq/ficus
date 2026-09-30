import { selectWorkStreamPresentationState, workStreamTitle } from '@ficus/shared'
import { resolveActingUser } from '../rbac'
import { eq, desc, isNull, and, sql, inArray } from 'drizzle-orm'
import {
  db,
  agents,
  squads,
  workStreams,
  workStreamWaits,
  workStreamFlowRuns,
  assistantConversations,
  assistantTasks,
  assistantUpdates,
  inbox,
} from '../../db'
import type {
  AssistantTaskActionData,
  PendingAction,
  PendingActionType,
  SquadQuestionActionData,
  AgentQuestionActionData,
  AgentErrorActionData,
  WorkStreamActionData,
  WorkStreamDeliveryActionData,
  WorkStreamPrompt,
  QuestionData,
} from '@ficus/shared'
import { listActionableAgentQuestions } from './questions'
import { listErrorHaltedAgents, errorHaltReason, ERROR_HALT_QUESTION_IDS } from './resume'
import { WorkStream } from '../../entities/WorkStream'
import type { Identity } from '../rbac'
import { EMPTY_USER_ATTENTION, loadUserAttention } from '../attention/resolver'
import { evaluatePendingAction, loadQuestionWorkStreamOrigins } from './pending-action-policy'
import { listOpenWaitsForStreams, toWaitJson } from '../work-streams/waits'
import { loadDeliveryPresentations } from '../workflows/delivery-state'
import { deliveryView } from '../work-streams/delivery-pull-requests'
import { agentQuestionDeliveryAcknowledgements } from '../../db/schema'

// Priority: lower number = higher priority
const PRIORITY: Record<PendingActionType, number> = {
  'agent-error': 0,
  'squad-question': 1,
  'agent-question': 1,
  'assistant-needs-input': 1,
  'workstream-review': 2,
  'workstream-delivery': 2,
  'workstream-blocked': 3,
}

/**
 * Code-host delivery gates a person must act on: the server-classified delivery
 * is a human PR review or merge, and neither a pause nor an open wait (which
 * has its own action) takes display precedence. These
 * have no wait, so they are listed from the same batch classification the work
 * stream feed uses, never from provider calls.
 */
async function listDeliveryGateActions(): Promise<PendingAction[]> {
  const rows = await db
    .select({ ws: workStreams, squad: squads, state: workStreamFlowRuns.state })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .innerJoin(squads, eq(squads.id, workStreams.squadId))
    .where(and(eq(workStreamFlowRuns.activated, true), inArray(workStreams.status, ['active', 'queued'])))
  const candidates = rows.filter(
    ({ ws, state }) =>
      !ws.pause &&
      state.status === 'completion-ready' &&
      ['pr-merge', 'pr-auto-merge'].includes(state.definition.completion.mode)
  )
  if (candidates.length === 0) return []
  const ids = candidates.map(({ ws }) => ws.id)
  const [deliveries, waits] = await Promise.all([loadDeliveryPresentations(db, ids), listOpenWaitsForStreams(ids)])
  const actions: PendingAction[] = []
  for (const { ws, squad } of candidates) {
    const delivery = deliveries.get(ws.id)
    const state = selectWorkStreamPresentationState({
      status: ws.status,
      openWaits: (waits.get(ws.id) ?? []).map(toWaitJson),
      delivery,
    })
    if (state !== 'delivery_review' && state !== 'delivery_merge') continue
    const data: WorkStreamDeliveryActionData = {
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      workStreamTitle: workStreamTitle(ws),
      squadId: squad.id,
      squadName: squad.name,
      deliveryKind: state === 'delivery_review' ? 'review' : 'merge',
      pullRequests: deliveryView(ws.metadata)
        .pullRequests.filter((pullRequest) => pullRequest.state === 'open')
        .map(({ repository, number, url }) => ({ repository, number, ...(url ? { url } : {}) })),
      focus: { kind: 'workstream', workStreamId: ws.id },
    }
    actions.push({
      id: `workstream-delivery:${ws.id}:${data.deliveryKind}`,
      type: 'workstream-delivery',
      priority: PRIORITY['workstream-delivery'],
      createdAt: ws.updatedAt.toISOString(),
      canRespond: false,
      squadId: squad.id,
      squadName: squad.name,
      data,
    })
  }
  return actions
}

/**
 * List all pending actions that require user attention.
 *
 * This aggregates:
 * - Squad agents waiting for human input (questions)
 * - Work streams in review or blocked status with prompts
 */
export async function listPendingActions(): Promise<PendingAction[]> {
  const pendingActions: PendingAction[] = []

  // 1. Get squad-bound agents waiting for input (context has squadId)
  const waitingSquadAgents = await db
    .select({
      agent: agents,
      squad: squads,
    })
    .from(agents)
    .innerJoin(squads, eq(agents.squadId, squads.id))
    .where(and(eq(agents.status, 'waiting-input'), sql`${agents.questionData} IS NOT NULL`))
    .orderBy(desc(agents.updatedAt))

  for (const { agent, squad } of waitingSquadAgents) {
    // Provider-exhaustion / rate-limit halts are surfaced as 'agent-error' (below), not as questions.
    const qid = (agent.questionData as QuestionData | null)?.questions?.[0]?.id
    if (qid && ERROR_HALT_QUESTION_IDS.has(qid)) continue
    const data: SquadQuestionActionData = {
      agentId: agent.id,
      agentName: (agent.metadata as Record<string, unknown>)?.name as string | null,
      agentTypeId: agent.agentTypeId,
      squadId: squad.id,
      squadName: squad.name,
      questionData: agent.questionData as QuestionData,
    }

    pendingActions.push({
      id: `squad-question:${agent.id}`,
      type: 'squad-question',
      priority: PRIORITY['squad-question'],
      createdAt: agent.updatedAt.toISOString(),
      canRespond: false,
      squadId: squad.id,
      squadName: squad.name,
      data,
    })
  }

  // 1b. Async agent questions (status open). Scoping to the right user happens in the route.
  const openQuestions = await listActionableAgentQuestions()
  if (openQuestions.length > 0) {
    const agentIds = [...new Set(openQuestions.map((q) => q.agentId))]
    const agentRows = agentIds.length ? await db.select().from(agents).where(inArray(agents.id, agentIds)) : []
    const agentMap = new Map(agentRows.map((a) => [a.id, a]))
    const squadIds = [...new Set(openQuestions.map((q) => q.squadId).filter((id): id is string => Boolean(id)))]
    const squadRows = squadIds.length ? await db.select().from(squads).where(inArray(squads.id, squadIds)) : []
    const squadMap = new Map(squadRows.map((s) => [s.id, s]))

    for (const q of openQuestions) {
      const agent = agentMap.get(q.agentId)
      const squad = q.squadId ? squadMap.get(q.squadId) : null
      const data: AgentQuestionActionData = {
        questionId: q.id,
        agentId: q.agentId,
        agentName: ((agent?.metadata as Record<string, unknown>)?.name as string | null) ?? null,
        agentTypeId: agent?.agentTypeId ?? 'unknown',
        squadId: q.squadId,
        squadName: squad?.name ?? null,
        ownerUserId: q.ownerUserId,
        questionData: q.questionData,
        ...(q.answerDelivery ? { answerDelivery: q.answerDelivery } : {}),
      }
      pendingActions.push({
        id: `agent-question:${q.id}`,
        type: 'agent-question',
        priority: PRIORITY['agent-question'],
        createdAt: q.createdAt,
        canRespond: false,
        squadId: q.squadId ?? undefined,
        squadName: squad?.name,
        data,
      })
    }
  }

  // 1c. Agents halted by a provider/rate-limit error (squad-bound and squad-less). Scoping happens
  // in the route; these support individual + bulk "Continue".
  const haltedAgents = await listErrorHaltedAgents()
  if (haltedAgents.length > 0) {
    const haltedSquadIds = [...new Set(haltedAgents.map((a) => a.squadId).filter((id): id is string => Boolean(id)))]
    const haltedSquadRows = haltedSquadIds.length
      ? await db.select().from(squads).where(inArray(squads.id, haltedSquadIds))
      : []
    const haltedSquadMap = new Map(haltedSquadRows.map((s) => [s.id, s]))

    for (const agent of haltedAgents) {
      const squad = agent.squadId ? haltedSquadMap.get(agent.squadId) : null
      const data: AgentErrorActionData = {
        agentId: agent.id,
        agentName: ((agent.metadata as Record<string, unknown>)?.name as string | null) ?? null,
        agentTypeId: agent.agentTypeId,
        squadId: agent.squadId,
        squadName: squad?.name ?? null,
        ownerUserId: agent.ownerUserId,
        reason: errorHaltReason(agent),
      }
      pendingActions.push({
        id: `agent-error:${agent.id}`,
        type: 'agent-error',
        priority: PRIORITY['agent-error'],
        createdAt: agent.updatedAt.toISOString(),
        canRespond: false,
        squadId: agent.squadId ?? undefined,
        squadName: squad?.name,
        data,
      })
    }
  }

  // 2. Get work streams needing human response: a non-terminal stream with an
  // open review or manual wait (waits replaced the review/blocked statuses).
  const actionableWorkStreams = await db
    .select({
      ws: workStreams,
      squad: squads,
      wait: workStreamWaits,
    })
    .from(workStreamWaits)
    .innerJoin(workStreams, eq(workStreamWaits.workStreamId, workStreams.id))
    .innerJoin(squads, eq(workStreams.squadId, squads.id))
    .where(
      and(
        isNull(workStreamWaits.closedAt),
        inArray(workStreamWaits.type, ['review', 'manual']),
        inArray(workStreams.status, ['active', 'queued'])
      )
    )
    .orderBy(desc(workStreamWaits.openedAt))

  for (const { ws, squad, wait } of actionableWorkStreams) {
    const isReview = wait.type === 'review'
    // Synthesize the legacy prompt shape from the wait so the Action Center
    // respond flows (#970) keep working unchanged.
    const prompt: WorkStreamPrompt = isReview
      ? {
          type: 'select',
          message: wait.message ?? ws.handoffMessage ?? `Work stream "${workStreamTitle(ws)}" is ready for review.`,
          options: ['Approve', 'Request changes'],
        }
      : {
          type: 'text',
          message: wait.message ?? `Work stream "${workStreamTitle(ws)}" is blocked and needs attention.`,
        }

    // A sibling may be the stream's current assignee while this attempt waits.
    let assigneeAgentId = ws.assigneeAgentId
    if (wait.flowAttemptId != null) {
      const [run] = await db
        .select({ attemptAgents: workStreamFlowRuns.attemptAgents })
        .from(workStreamFlowRuns)
        .where(eq(workStreamFlowRuns.workStreamId, ws.id))
      assigneeAgentId = run?.attemptAgents[String(wait.flowAttemptId)] ?? wait.createdByAgentId ?? null
    }
    let assigneeName: string | null = null
    if (assigneeAgentId) {
      const [assignee] = await db.select().from(agents).where(eq(agents.id, assigneeAgentId))
      if (assignee) {
        assigneeName = (assignee.metadata as Record<string, unknown>)?.name as string | null
      }
    }

    const data: WorkStreamActionData = {
      workStreamId: ws.id,
      workStreamNumber: ws.number,
      workStreamTitle: workStreamTitle(ws),
      squadId: squad.id,
      squadName: squad.name,
      waitId: wait.id,
      wait: toWaitJson(wait),
      focus: { kind: 'workstream-wait', workStreamId: ws.id, waitId: wait.id },
      assigneeAgentId,
      assigneeName,
      completionMode: new WorkStream(ws).completionMode,
      prompt,
    }

    pendingActions.push({
      id: `workstream-${isReview ? 'review' : 'blocked'}:${ws.id}:${wait.id}`,
      type: isReview ? 'workstream-review' : 'workstream-blocked',
      priority: PRIORITY[isReview ? 'workstream-review' : 'workstream-blocked'],
      createdAt: wait.openedAt.toISOString(),
      canRespond: false,
      squadId: squad.id,
      squadName: squad.name,
      data,
    })
  }

  // 3. Code-host delivery gates that need a person on the code host (no wait exists).
  pendingActions.push(...(await listDeliveryGateActions()))

  // Sort by priority (ascending) then by createdAt (descending - most recent first)
  pendingActions.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })

  // 4. Assistant tasks whose delegate reported needs-input: blocked on the conversation owner's
  //    answer, which is given inside that saved conversation. Scoped to the owner in the policy.
  const waitingTasks = await db
    .select({
      task: assistantTasks,
      conversationTitle: assistantConversations.title,
      ownerUserId: assistantConversations.ownerUserId,
      squadName: squads.name,
      updateMessageId: sql<string | null>`latest.message_id`,
      updateContent: sql<string | null>`latest.content`,
      updateCreatedAt: sql<Date | null>`latest.created_at`,
    })
    .from(assistantTasks)
    .innerJoin(
      assistantConversations,
      and(eq(assistantConversations.id, assistantTasks.conversationId), eq(assistantConversations.kind, 'assistant'))
    )
    .leftJoin(squads, eq(squads.id, assistantTasks.squadId))
    .leftJoin(
      sql`LATERAL (
        SELECT au.message_id, i.content, au.created_at FROM ${assistantUpdates} au
        JOIN ${inbox} i ON i.id = au.message_id
        WHERE au.task_id = ${assistantTasks.id}
          AND au.request_id = ${assistantTasks.currentRequestId}
          AND au.reported_status = 'needs-input'
        ORDER BY au.sequence DESC LIMIT 1
      ) latest`,
      sql`true`
    )
    .where(eq(assistantTasks.status, 'needs-input'))
    .orderBy(desc(assistantTasks.updatedAt))
  for (const row of waitingTasks) {
    const data: AssistantTaskActionData = {
      conversationId: row.task.conversationId,
      conversationTitle: row.conversationTitle,
      taskId: row.task.id,
      taskLabel: row.task.label,
      ownerUserId: row.ownerUserId,
      agentId: row.task.agentId,
      squadId: row.task.squadId,
      squadName: row.squadName ?? null,
      question: row.updateContent ?? 'The task is waiting for your answer.',
      updateMessageId: row.updateMessageId,
      updateCreatedAt: row.updateCreatedAt ? new Date(row.updateCreatedAt).toISOString() : null,
    }
    pendingActions.push({
      id: `assistant-needs-input:${row.task.id}`,
      type: 'assistant-needs-input',
      priority: PRIORITY['assistant-needs-input'],
      createdAt: row.task.updatedAt.toISOString(),
      canRespond: false,
      ...(row.task.squadId && row.squadName ? { squadId: row.task.squadId, squadName: row.squadName } : {}),
      data,
    })
  }

  return pendingActions
}

export async function listPendingActionsForIdentity(identity: Identity): Promise<PendingAction[]> {
  identity = (await resolveActingUser(identity)) ?? identity
  const userId = identity.type === 'user' ? identity.userId : null
  // One attention load per request; every action below resolves precedence against it in memory.
  const attention = userId ? await loadUserAttention(userId) : EMPTY_USER_ATTENTION
  const actions = await listPendingActions()
  // With no work-stream rows every origin resolves to its squad's level, so the policy never asks
  // for origins and loading them would be pure cost.
  const questionOrigins =
    attention.workStreams.size === 0
      ? undefined
      : await loadQuestionWorkStreamOrigins(
          actions
            .filter((action) => action.type === 'agent-question')
            .map((action) => (action.data as AgentQuestionActionData).questionId)
        )
  const failedIds = userId
    ? actions
        .filter(
          (action) =>
            action.type === 'agent-question' &&
            (action.data as AgentQuestionActionData).answerDelivery?.status === 'failed'
        )
        .map((action) => (action.data as AgentQuestionActionData).questionId)
    : []
  const acknowledgements = failedIds.length
    ? await db
        .select()
        .from(agentQuestionDeliveryAcknowledgements)
        .where(
          and(
            eq(agentQuestionDeliveryAcknowledgements.userId, userId!),
            inArray(agentQuestionDeliveryAcknowledgements.questionId, failedIds)
          )
        )
    : []
  const acknowledged = new Map(acknowledgements.map((row) => [row.questionId, row.generation]))
  const context = { attention, questionOrigins }
  const visible: PendingAction[] = []
  for (const action of actions) {
    if (action.type === 'agent-question') {
      const data = action.data as AgentQuestionActionData
      if (
        data.answerDelivery?.status === 'failed' &&
        acknowledged.get(data.questionId) === data.answerDelivery.generation
      )
        continue
    }
    const decision = await evaluatePendingAction(identity, action, context)
    if (decision.visible) {
      if (action.type === 'agent-question') {
        const data = action.data as AgentQuestionActionData
        if (data.answerDelivery?.status === 'failed') {
          visible.push({
            ...action,
            canRespond: decision.canRespond,
            data: { ...data, answerDelivery: { ...data.answerDelivery, canRetry: decision.canRespond } },
          })
          continue
        }
      }
      visible.push({ ...action, canRespond: decision.canRespond })
    }
  }
  return visible
}
