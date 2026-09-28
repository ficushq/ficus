import { eq } from 'drizzle-orm'
import { activeWorkflowAttempts, summarizeWorkflowUsage, type SessionUsage, type WorkflowRun } from '@ficus/shared'
import { db, executions, workflowBindings, workStreamFlowRuns, type DbTx } from '../../db'

/** Capture at acceptance, never at settlement: an agent may hand off before its turn's usage arrives. */
export async function executionFlowContext(agentId: string, tx: DbTx) {
  const [row] = await tx
    .select({ run: workStreamFlowRuns })
    .from(workflowBindings)
    .innerJoin(workStreamFlowRuns, eq(workflowBindings.workStreamId, workStreamFlowRuns.workStreamId))
    .where(eq(workflowBindings.agentId, agentId))
  const run = row?.run
  if (!run?.activated || run.state.status !== 'running') return null
  const attempt = activeWorkflowAttempts(run.state).find((entry) => run.attemptAgents[String(entry.id)] === agentId)
  return attempt ? { workStreamId: run.workStreamId, attemptId: attempt.id, stepId: attempt.stepId } : null
}

export async function getFlowUsage(workStreamId: string, state: WorkflowRun) {
  const rows = await db
    .select({ agentId: executions.agentId, context: executions.flowContext, usage: executions.usage })
    .from(executions)
    .innerJoin(workflowBindings, eq(executions.agentId, workflowBindings.agentId))
    .where(eq(workflowBindings.workStreamId, workStreamId))
  return summarizeWorkflowUsage(
    state,
    rows.map((row) => ({
      agentId: row.agentId,
      attemptId: row.context?.workStreamId === workStreamId ? row.context.attemptId : null,
      usage: row.usage as SessionUsage | null,
    }))
  )
}
