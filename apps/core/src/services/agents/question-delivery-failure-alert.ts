import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestions, inbox } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { FLOW_WAIT_SUPERSEDED_MESSAGE } from '../work-streams/wait-scope'

interface DeliveryFailureAlert {
  id: string
  agentId: string
  squadId: string | null
  generation: number
  attemptCount: number
  lastError: string | null
}

export type QuestionDeliveryFailureAlertSender = (question: DeliveryFailureAlert) => Promise<void>

function alertKey(questionId: string, generation: number): string {
  return `agent-question-delivery-failure:v1:${questionId}:${generation}`
}

/**
 * What the operator is told. The alert used to say only "retry after resolving the target agent
 * state", which named no cause, and for a replaced flow attempt named a remedy that cannot work:
 * a retry re-checks the same attempt.
 */
export function questionDeliveryFailureAlertContent(question: Pick<DeliveryFailureAlert, 'agentId' | 'lastError'>) {
  if (question.lastError === FLOW_WAIT_SUPERSEDED_MESSAGE) {
    return `An accepted answer was not delivered to agent ${question.agentId}: the workflow attempt the question was asked from was replaced before the answer arrived. Retrying will not deliver it. The answer is kept in the question's history; if it still applies, send it to the agent as a message.`
  }
  const reason = question.lastError?.split('\n')[0]?.trim().slice(0, 300)
  return `An accepted answer could not be delivered to agent ${question.agentId}${
    reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''
  }. Retry from the Action Center after resolving the target agent state.`
}

export async function sendQuestionDeliveryFailureAlert(question: DeliveryFailureAlert): Promise<void> {
  await InboxMessage.sendOnce(
    {
      recipientType: 'system',
      recipientId: SYSTEM_RECIPIENT_ID,
      senderType: 'system',
      wakeEligible: false,
      subject: 'Agent question answer delivery failed',
      content: questionDeliveryFailureAlertContent(question),
      metadata: {
        source: 'agent-question-delivery-failure',
        questionId: question.id,
        agentId: question.agentId,
        squadId: question.squadId,
        generation: question.generation,
        attemptCount: question.attemptCount,
        lastError: question.lastError,
        actionId: `agent-question:${question.id}`,
      },
    },
    alertKey(question.id, question.generation)
  )
}

export async function ensureQuestionDeliveryFailureAlert(
  questionId: string,
  options: { alert?: QuestionDeliveryFailureAlertSender } = {}
): Promise<boolean> {
  const [question] = await db
    .select({
      id: agentQuestions.id,
      agentId: agentQuestions.agentId,
      squadId: agentQuestions.squadId,
      generation: agentQuestions.answerDeliveryGeneration,
      status: agentQuestions.answerDeliveryStatus,
      attemptCount: agentQuestions.answerDeliveryAttemptCount,
      lastError: agentQuestions.answerDeliveryLastError,
    })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
  if (!question || question.status !== 'failed') return false

  await (options.alert ?? sendQuestionDeliveryFailureAlert)(question)
  return true
}

export async function reconcileQuestionDeliveryFailureAlertsOnce(
  limit = 100,
  options: { alert?: QuestionDeliveryFailureAlertSender } = {}
): Promise<number> {
  const durableAlertKey = sql<string>`'agent-question-delivery-failure:v1:' || ${agentQuestions.id}::text || ':' || ${agentQuestions.answerDeliveryGeneration}::text`
  const rows = await db
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .leftJoin(inbox, eq(inbox.idempotencyKey, durableAlertKey))
    .where(
      and(eq(agentQuestions.status, 'answered'), eq(agentQuestions.answerDeliveryStatus, 'failed'), isNull(inbox.id))
    )
    .orderBy(asc(agentQuestions.id))
    .limit(limit)
  for (const { id } of rows) await ensureQuestionDeliveryFailureAlert(id, options)
  return rows.length
}
