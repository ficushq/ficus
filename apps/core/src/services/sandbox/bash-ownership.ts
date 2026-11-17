import { createLogger } from '../../lib/infra/logger'

const log = createLogger('bash-ownership')

/** The work stream and flow attempt an agent's command runs for. */
export interface BashFlowOwnership {
  workStreamId: string
  attemptId: number
}

/** A lookup slower than this is skipped: the command still runs, attributed to its agent only. */
const LOOKUP_TIMEOUT_MS = 2_000

/**
 * The flow attempt an execution is working on right now, read from its row
 * rather than the runner's copy: an inline handoff rebinds a running
 * execution to its next attempt (workflows/execution.ts), so the attempt can
 * change during one execution. Sent with each bash request so the box can
 * stop what the command leaves running when that attempt or its stream ends.
 * Never throws; undefined when the execution has no flow context.
 */
export async function executionFlowOwnership(executionId: string): Promise<BashFlowOwnership | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const lookup = (async () => {
      const [{ db }, { executions }, { eq }] = await Promise.all([
        import('../../db'),
        import('../../db/schema'),
        import('drizzle-orm'),
      ])
      const [row] = await db
        .select({ flowContext: executions.flowContext })
        .from(executions)
        .where(eq(executions.id, executionId))
        .limit(1)
      const context = row?.flowContext
      return context && typeof context.workStreamId === 'string' && Number.isSafeInteger(context.attemptId)
        ? { workStreamId: context.workStreamId, attemptId: context.attemptId }
        : undefined
    })()
    return await Promise.race([
      lookup,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    log.debug(`No flow attribution for execution ${executionId}: ${(error as Error).message}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
