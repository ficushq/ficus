import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestionDeliveryAcknowledgements, agentQuestions } from '../../db/schema'

/** Per-user attention acknowledgement fenced to the current failure generation. No sends or wait changes. */
export async function acknowledgeQuestionDeliveryFailure(
  questionId: string,
  userId: string,
  generation: number
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Lock the question so retry/settlement cannot change its generation between validation and insert.
    const [question] = await tx
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(
        and(
          eq(agentQuestions.id, questionId),
          eq(agentQuestions.status, 'answered'),
          eq(agentQuestions.answerDeliveryStatus, 'failed'),
          eq(agentQuestions.answerDeliveryGeneration, generation)
        )
      )
      .for('update')
    if (!question) return false
    await tx
      .insert(agentQuestionDeliveryAcknowledgements)
      .values({ questionId, userId, generation })
      .onConflictDoUpdate({
        target: [agentQuestionDeliveryAcknowledgements.questionId, agentQuestionDeliveryAcknowledgements.userId],
        set: { generation, acknowledgedAt: sql`now()` },
      })
    return true
  })
}
