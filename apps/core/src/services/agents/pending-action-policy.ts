import type { PendingAction, WorkStreamActionData } from '@ficus/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestionRecipients, agentQuestionWorkStreamOrigins, agents } from '../../db/schema'
import { hasPermission, type Identity } from '../rbac'
import { activeWorkflowAttempts } from '@ficus/shared'
import { workStreamFlowRuns, workStreams } from '../../db'
import { isWorkflowReviewer } from '../workflows/reviewers'
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
}

export interface PendingActionPolicyDecision {
  visible: boolean
  canRespond: boolean
}

async function isDirectQuestionAttentionRecipient(questionId: string, userId: string): Promise<boolean> {
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
  const squadUnmuted = context.attention.forSquad(question.squadId).decisions !== 'mute'
  if (context.attention.workStreams.size === 0) return squadUnmuted
  const origins = context.questionOrigins
    ? (context.questionOrigins.get(question.id) ?? [])
    : ((await loadQuestionWorkStreamOrigins([question.id])).get(question.id) ?? [])
  if (origins.length === 0) return squadUnmuted
  return origins.some(
    (workStreamId) => context.attention.forWorkStream(workStreamId, question.squadId).decisions !== 'mute'
  )
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
  if (userId && (await isDirectQuestionAttentionRecipient(question.id, userId))) return true
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
    const data = action.data as { ownerUserId: string | null; squadId: string | null }
    const owner = Boolean(userId && data.ownerUserId === userId)
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

  const data = action.data as WorkStreamActionData
  const workStreamId = data.workStreamId
  if (data.wait.resolutionHandler === 'workflow') {
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
    const attempt = run && activeWorkflowAttempts(run.state).find((a) => a.id === data.wait.flowAttemptId)
    const step = attempt?.step ?? run?.state.definition.steps.find((s) => s.id === attempt?.stepId)
    let canRespond = false
    if (identity.type === 'user' && squadId && stream && run?.activated) {
      if (step?.kind === 'human-approval')
        canRespond =
          (await isWorkflowReviewer(identity.userId, squadId)) &&
          (step.approver !== 'assigned-reviewers' ||
            !stream.assignedReviewerIds.length ||
            stream.assignedReviewerIds.includes(identity.userId))
      else if (run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval')
        canRespond =
          (await hasPermission(identity, 'workstreams:respond', squadId)) ||
          (await hasPermission(identity, 'workstreams:update', squadId))
      else canRespond = await hasPermission(identity, 'workstreams:revise-flow', squadId)
    }
    return {
      visible:
        canRead &&
        (identity.type !== 'user' || context.attention.forWorkStream(workStreamId, squadId).decisions !== 'mute'),
      canRespond,
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
