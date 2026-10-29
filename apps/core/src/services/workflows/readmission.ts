import { activeWorkflowAttempts } from '@ficus/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { inbox, workStreamFlowRuns, type DbTx } from '../../db'
import { InboxMessage } from '../../entities/InboxMessage'
import type { WorkStreamRow } from '../../entities/WorkStream'

/**
 * Called only by the guarded queued -> active transition, while its stream row
 * is locked. Assignment receipts (including inline responses) are immutable;
 * they are not a pending wake once the worker has consumed them. Commit a new
 * resume intent with admission so a crash before dispatch cannot strand it.
 * Ordinary dispatch/reconciliation never manufactures an idle nudge.
 */
export async function persistFlowReadmission(
  tx: DbTx,
  stream: WorkStreamRow,
  afterCommit: Array<() => void>
): Promise<void> {
  const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  if (!run?.activated || run.state.status !== 'running' || stream.pause) return
  for (const attempt of activeWorkflowAttempts(run.state)) {
    const agentId = run.attemptAgents[String(attempt.id)]
    // New work still gets its first assignment from dispatchFlow. Never reopen
    // completed delivery steps or rebind an existing participant here.
    if (!agentId) continue
    const [pending] = await tx
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientId, agentId),
          isNull(inbox.readAt),
          isNull(inbox.deliveredAt),
          sql`${inbox.metadata}->>'workStreamId' = ${stream.id}`,
          sql`${inbox.metadata}->>'attemptId' = ${String(attempt.id)}`,
          sql`${inbox.metadata}->>'source' = 'workflow'`
        )
      )
      .limit(1)
    if (pending) continue
    await InboxMessage.persistSystemAgentOnceInTransaction(
      tx,
      {
        recipientId: agentId,
        subject: 'Work stream re-admitted',
        content: `Work stream ${stream.id} has been re-admitted after parking. Continue the existing ${attempt.stepId} attempt ${attempt.id} from its saved state; do not restart completed work. Any remaining waits still apply.`,
        metadata: {
          source: 'workflow',
          workStreamId: stream.id,
          squadId: stream.squadId,
          attemptId: attempt.id,
          workStreamResume: true,
          workStreamReadmission: true,
        },
        recordOnly: true,
        wakeEligible: true,
      },
      `flow-readmission:${stream.id}:${attempt.id}:${crypto.randomUUID()}`,
      afterCommit
    )
  }
}
