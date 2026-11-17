import { createLogger } from '../../lib/infra/logger'

const log = createLogger('bash-ownership')

/** The work stream and flow attempt an agent's command runs for. */
export interface BashFlowOwnership {
  workStreamId: string
  attemptId: number
}

/** A lookup slower than this is skipped: the command still runs, attributed to its agent only. */
const LOOKUP_TIMEOUT_MS = 2_000

/** `lookup`'s answer, or `fallback` when it fails or takes longer than LOOKUP_TIMEOUT_MS. Never throws. */
async function boundedLookup<T>(what: string, fallback: T, lookup: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    log.debug(`No ${what}: ${(error as Error).message}`)
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The flow attempt an execution is working on right now, read from its row
 * rather than the runner's copy: an inline handoff rebinds a running
 * execution to its next attempt (workflows/execution.ts), so the attempt can
 * change during one execution. Sent with each bash request so the box can
 * stop what the command leaves running when that attempt or its stream ends.
 * Never throws; undefined when the execution has no flow context.
 */
export function executionFlowOwnership(executionId: string): Promise<BashFlowOwnership | undefined> {
  return boundedLookup(`flow attribution for execution ${executionId}`, undefined, async () => {
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
  })
}

/**
 * The slot claims an agent holds right now: active and not yet past their
 * expiry. Sent with each bash request so the box can stop what the command
 * leaves running once the last of these claims is released or expires
 * (leftover-processes.ts), and read again when a claim ends to learn which
 * claims still cover the agent's work. Never throws; undefined when the
 * lookup failed or timed out, so a command is at worst not attributed to a
 * claim, and a cleanup that cannot tell which claims are held does nothing.
 */
export function heldSlotClaimIds(agentId: string): Promise<string[] | undefined> {
  return boundedLookup<string[] | undefined>(`slot claims for agent ${agentId}`, undefined, async () => {
    const [{ db }, { slotClaims }, { and, eq, gt, sql }] = await Promise.all([
      import('../../db'),
      import('../../db/schema'),
      import('drizzle-orm'),
    ])
    const rows = await db
      .select({ id: slotClaims.id })
      .from(slotClaims)
      .where(
        and(eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.status, 'active'), gt(slotClaims.expiresAt, sql`now()`))
      )
    return rows.map((row) => row.id).sort()
  })
}
