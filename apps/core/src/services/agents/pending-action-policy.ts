import { isHumanFlowWait } from '../workflows/wait-policy'
import { listOpenWaits, toWaitJson } from '../work-streams/waits'
import { workflowReviewBlockingWaits } from '@ficus/shared'
import { recoveryRecipientsById } from '../recovery/recipients'
import type {
  AgentQuestionActionData,
  AttentionLevel,
  PendingAction,
  WorkStreamActionData,
  WorkStreamDeliveryActionData,
} from '@ficus/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestionRecipients, agentQuestionWorkStreamOrigins, agents } from '../../db/schema'
import { hasPermission, type Identity } from '../rbac'
import { activeWorkflowAttempts, workflowGateDecisionBasis, workflowAttemptLimitPause } from '@ficus/shared'
import { canRaiseFlowAttemptLimit } from '../workflows/attempt-limit'
import { workStreamFlowRuns, workStreams } from '../../db'
import { isWorkflowReviewer, workflowGateFallbackFor } from '../workflows/reviewers'
import type { UserAttention } from '../attention/resolver'
import { canAnswerAgentQuestion } from './question-authorization'

export interface PendingActionAttentionContext {
  /** The viewer's resolved attention rows. Non-user identities pass EMPTY_USER_ATTENTION. */
  attention: UserAttention
  /**
   * Preloaded question id -> work-stream origin ids, so a caller evaluating many actions pays one
   * origin query instead of one per question. When present it is authoritative: a question with no
   * entry has no origins. Omit it and each question loads its own origins on demand.
   */
  questionOrigins?: ReadonlyMap<string, readonly string[]>
  /**
   * Preloaded ids of the questions the viewer is a direct attention recipient of, so a caller
   * evaluating many questions pays one recipient query instead of one or two per question. When
   * present it is authoritative; omit it and each question checks its own row.
   */
  directRecipientQuestionIds?: ReadonlySet<string>
}

export interface PendingActionPolicyDecision {
  visible: boolean
  canRespond: boolean
  workflowGateFallbackBasis?: PendingAction['workflowGateFallbackBasis']
}

/** The ids among `questionIds` that `userId` is a direct attention recipient of, in one query. */
export async function loadDirectRecipientQuestionIds(
  userId: string,
  questionIds: readonly string[]
): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set()
  const rows = await db
    .select({ questionId: agentQuestionRecipients.questionId })
    .from(agentQuestionRecipients)
    .where(
      and(eq(agentQuestionRecipients.userId, userId), inArray(agentQuestionRecipients.questionId, [...questionIds]))
    )
  return new Set(rows.map((row) => row.questionId))
}

async function isDirectQuestionAttentionRecipient(
  questionId: string,
  userId: string,
  context?: PendingActionAttentionContext
): Promise<boolean> {
  if (context?.directRecipientQuestionIds) return context.directRecipientQuestionIds.has(questionId)
  const [recipient] = await db
    .select({ userId: agentQuestionRecipients.userId })
    .from(agentQuestionRecipients)
    .where(and(eq(agentQuestionRecipients.questionId, questionId), eq(agentQuestionRecipients.userId, userId)))
  return Boolean(recipient)
}

/** questionId -> its work-stream origin ids, for every given question, in one query. */
export async function loadQuestionWorkStreamOrigins(
  questionIds: readonly string[]
): Promise<Map<string, readonly string[]>> {
  const byQuestion = new Map<string, string[]>()
  if (questionIds.length === 0) return byQuestion
  const rows = await db
    .select({
      questionId: agentQuestionWorkStreamOrigins.questionId,
      workStreamId: agentQuestionWorkStreamOrigins.workStreamId,
    })
    .from(agentQuestionWorkStreamOrigins)
    .where(inArray(agentQuestionWorkStreamOrigins.questionId, [...questionIds]))
  for (const row of rows) {
    const origins = byQuestion.get(row.questionId) ?? []
    origins.push(row.workStreamId)
    byQuestion.set(row.questionId, origins)
  }
  return byQuestion
}

/**
 * Is this question's `decisions` attention un-muted for the viewer?
 *
 * ORIGIN PRECEDENCE. With work-stream origins the question IS its origins: each one resolves the
 * normal way (stream row, else squad row, else the default) and any un-muted origin shows it — so
 * muting a stream silences its questions inside a shown squad, and the squad row alone can never
 * show them. With no origins the question is the squad's own, so the squad level decides. With no
 * stream rows at all every origin would resolve to the squad level anyway, so that common case
 * skips the origin lookup and stays a single in-memory read.
 */
async function decisionsUnmuted(
  question: { id: string; squadId: string | null },
  context: PendingActionAttentionContext
): Promise<boolean> {
  return questionDecisions(question, context, (level) => level !== 'mute')
}

/** Does `matches` hold for the question's effective `decisions` level, by the origin precedence above? */
async function questionDecisions(
  question: { id: string; squadId: string | null },
  context: PendingActionAttentionContext,
  matches: (level: AttentionLevel) => boolean
): Promise<boolean> {
  const squadMatches = matches(context.attention.forSquad(question.squadId).decisions)
  if (context.attention.workStreams.size === 0) return squadMatches
  const origins = context.questionOrigins
    ? (context.questionOrigins.get(question.id) ?? [])
    : ((await loadQuestionWorkStreamOrigins([question.id])).get(question.id) ?? [])
  if (origins.length === 0) return squadMatches
  return origins.some((workStreamId) =>
    matches(context.attention.forWorkStream(workStreamId, question.squadId).decisions)
  )
}

/**
 * Does this visible item ALERT the viewer (inbox message and push), beyond being listed in Needs
 * you? The same audience its push uses: a question's squadless personal owner and direct
 * recipients, and otherwise an effective `decisions` level of `notify` (a question by its origins,
 * a review or input gate by its work stream, a squad question by its squad). `show`, the default
 * with no attention row, lists an item without interrupting. Personal push preferences (master
 * switch, category mutes) are the client's to apply. Only questions and human gates alert here.
 */
export async function pendingActionAlertsViewer(
  identity: Identity,
  action: PendingAction,
  context: PendingActionAttentionContext
): Promise<boolean> {
  if (identity.type !== 'user') return false
  const notify = (level: AttentionLevel) => level === 'notify'
  switch (action.type) {
    case 'agent-question': {
      const data = action.data as AgentQuestionActionData
      if (data.ownerUserId === identity.userId && !data.squadId) return true
      if (await isDirectQuestionAttentionRecipient(data.questionId, identity.userId, context)) return true
      if (!data.squadId) return false
      return questionDecisions({ id: data.questionId, squadId: data.squadId }, context, notify)
    }
    case 'squad-question':
      return Boolean(action.squadId && notify(context.attention.forSquad(action.squadId).decisions))
    case 'workstream-review':
    case 'workstream-blocked': {
      const data = action.data as WorkStreamActionData
      return notify(context.attention.forWorkStream(data.workStreamId, action.squadId).decisions)
    }
    default:
      return false
  }
}

/**
 * Action Center/push ATTENTION policy for an agent question. Direct attention recipients (durable
 * rows) and compatible squadless personal owners receive the action with no permission or level
 * check; everyone else needs `actions:read` AND an un-muted `decisions` level for the question's
 * squad or one of its work-stream origins. A subscription is no longer required — the default for
 * a user with no row at all is `show`.
 *
 * SQUADLESS QUESTIONS ARE NOT AN ATTENTION SURFACE. A personal agent belongs to no squad and to no
 * work stream, so there is nothing its question could be muted or followed through; the `show`
 * default must not turn instance-wide `actions:read` into a view of someone else's personal
 * questions. Those stay exactly where they were: their owner and their direct recipients.
 *
 * This is deliberately NOT chat/history readability, which follows canonical agents:read on the
 * agent (see routes/agent-questions.ts).
 */
export async function canReceiveAgentQuestionAttention(
  identity: Identity,
  question: { id: string; ownerUserId: string | null; squadId: string | null },
  context: PendingActionAttentionContext
): Promise<boolean> {
  const userId = identity.type === 'user' ? identity.userId : null
  // Only a squadless personal agent's owner bypasses attention; a squad-bound agent's owner
  // snapshot is metadata, not an attention entitlement.
  if (userId && question.ownerUserId === userId && !question.squadId) return true
  if (userId && (await isDirectQuestionAttentionRecipient(question.id, userId, context))) return true
  if (!(await hasPermission(identity, 'actions:read', question.squadId ?? undefined))) return false
  // Non-user identities (agents, system/legacy tokens) never carried attention rows.
  if (identity.type !== 'user') return true
  if (!question.squadId) return false
  return decisionsUnmuted(question, context)
}

export async function evaluatePendingAction(
  identity: Identity,
  action: PendingAction,
  context: PendingActionAttentionContext
): Promise<PendingActionPolicyDecision> {
  const userId = identity.type === 'user' ? identity.userId : null
  const squadId = action.squadId
  const canRead = await hasPermission(identity, 'actions:read', squadId)
  // Non-user identities (agents, system/legacy tokens) never carried attention rows and keep
  // permission-only visibility. For a user this is the squad's `decisions` level — and a SQUADLESS
  // item never qualifies, because there is no squad or stream through which anyone could follow a
  // personal agent; such items reach their owner only (see canReceiveAgentQuestionAttention).
  const squadUnmuted =
    identity.type !== 'user' || Boolean(squadId && context.attention.forSquad(squadId).decisions !== 'mute')

  if (action.type === 'agent-question') {
    const data = action.data as {
      agentId: string
      questionId: string
      ownerUserId: string | null
      squadId: string | null
    }
    return {
      visible: await canReceiveAgentQuestionAttention(
        identity,
        { id: data.questionId, ownerUserId: data.ownerUserId, squadId: data.squadId },
        context
      ),
      canRespond: await canAnswerAgentQuestion(identity, data),
    }
  }

  if (action.type === 'assistant-needs-input') {
    // Private to the conversation owner; squad access or administration never widens it.
    const data = action.data as { ownerUserId: string }
    const owner = Boolean(userId && data.ownerUserId === userId)
    return { visible: owner, canRespond: owner }
  }

  if (action.type === 'agent-error') {
    const data = action.data as import('@ficus/shared').AgentErrorActionData
    const owner = Boolean(userId && data.ownerUserId === userId)
    if (data.recovery) {
      const audience = await recoveryRecipientsById(data.recovery.id)
      const visible = Boolean(
        userId &&
        audience?.target === 'owner' &&
        audience.ownerUserIds.includes(userId) &&
        !data.recovery.structured.stopped
      )
      return {
        visible,
        canRespond: visible,
      }
    }
    return {
      visible: owner || (canRead && squadUnmuted),
      canRespond:
        Boolean(!data.squadId && owner) ||
        Boolean(data.squadId && (await hasPermission(identity, 'agents:run', data.squadId))),
    }
  }

  if (action.type === 'squad-question') {
    const data = action.data as { agentId: string }
    const [target] = await db
      .select({ squadId: agents.squadId })
      .from(agents)
      .where(and(eq(agents.id, data.agentId), ne(agents.status, 'terminated')))
    const currentSquadId = target?.squadId ?? null
    if (!currentSquadId) return { visible: false, canRespond: false }
    const currentCanRead = await hasPermission(identity, 'actions:read', currentSquadId)
    const currentUnmuted = identity.type !== 'user' || context.attention.forSquad(currentSquadId).decisions !== 'mute'
    return {
      visible: currentCanRead && currentUnmuted,
      canRespond: await hasPermission(identity, 'agents:run', currentSquadId),
    }
  }

  if (action.type === 'workstream-delivery') {
    // Settled on the code host (review or merge there), so nothing to respond to in Ficus.
    const { workStreamId } = action.data as WorkStreamDeliveryActionData
    return {
      visible:
        canRead &&
        (identity.type !== 'user' || context.attention.forWorkStream(workStreamId, squadId).decisions !== 'mute'),
      canRespond: false,
    }
  }

  const data = action.data as WorkStreamActionData
  const workStreamId = data.workStreamId
  if (data.wait.structured?.request.kind === 'continue') {
    const audience = await recoveryRecipientsById(data.wait.structured.request.recoveryId)
    const actionable = Boolean(
      userId && audience?.target === 'owner' && audience.ownerUserIds.includes(userId) && !data.wait.structured.stopped
    )
    return {
      visible: actionable && context.attention.forWorkStream(workStreamId, squadId).decisions !== 'mute',
      canRespond: actionable,
    }
  }

  if (data.wait.resolutionHandler === 'workflow') {
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
    if (
      isHumanFlowWait({ ...data.wait, flowAttemptId: data.wait.flowAttemptId ?? null, resolutionHandler: 'workflow' })
    ) {
      const waits = (await listOpenWaits(db, workStreamId)).map((row) => toWaitJson(row))
      const gate = waits.find((wait) => wait.id === data.wait.id)
      if (
        !gate ||
        !stream ||
        stream.pause ||
        !['active', 'queued'].includes(stream.status) ||
        run?.state.status !== 'running' ||
        !activeWorkflowAttempts(run.state).some((a) => a.id === data.wait.flowAttemptId) ||
        workflowReviewBlockingWaits(gate, waits).length
      )
        return { visible: false, canRespond: false }
    }
    const attempt = run && activeWorkflowAttempts(run.state).find((a) => a.id === data.wait.flowAttemptId)
    const step = attempt?.step ?? run?.state.definition.steps.find((s) => s.id === attempt?.stepId)
    let canRespond = false
    let workflowGateFallbackBasis: PendingAction['workflowGateFallbackBasis']
    if (identity.type === 'user' && squadId && stream && run?.activated) {
      // A human approval, or a decision step without an automatic decision, waits for a person who may decide it.
      if (step?.kind === 'human-approval' || step?.kind === 'decision') {
        const canReview = await isWorkflowReviewer(identity.userId, squadId)
        // The fallback's reads are needed only when the plain rule says no to a reviewer.
        let basis = workflowGateDecisionBasis(identity, canReview, stream.assignedReviewerIds, step)
        if (!basis && canReview)
          basis = workflowGateDecisionBasis(
            identity,
            canReview,
            stream.assignedReviewerIds,
            step,
            await workflowGateFallbackFor(identity, stream)
          )
        canRespond = basis !== null
        if (basis === 'owner' || basis === 'admin') workflowGateFallbackBasis = basis
      } else if (run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval')
        canRespond =
          (await hasPermission(identity, 'workstreams:respond', squadId)) ||
          (await hasPermission(identity, 'workstreams:update', squadId))
      // An attempt-limit pause is unblocked by Raise limit, which reviewers may also use.
      else if (workflowAttemptLimitPause(run.state)) canRespond = await canRaiseFlowAttemptLimit(identity, stream, run)
      else canRespond = await hasPermission(identity, 'workstreams:revise-flow', squadId)
    }
    return {
      visible:
        canRead &&
        (identity.type !== 'user' || context.attention.forWorkStream(workStreamId, squadId).decisions !== 'mute'),
      canRespond,
      ...(workflowGateFallbackBasis ? { workflowGateFallbackBasis } : {}),
    }
  }
  return {
    visible:
      canRead &&
      (identity.type !== 'user' || context.attention.forWorkStream(workStreamId, squadId).decisions !== 'mute'),
    canRespond: Boolean(
      squadId &&
      ((await hasPermission(identity, 'workstreams:respond', squadId)) ||
        (await hasPermission(identity, 'workstreams:update', squadId)))
    ),
  }
}
