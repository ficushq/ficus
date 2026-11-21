import { resolveLimits } from './concurrency-config'
import { ConcurrencyLimiter, parseConcurrencyKey } from './concurrency-limits'
import type { Execution } from '../../entities/Execution'
import { selectModelSpecForCurrentEnv } from '../model-selection'
import { parseModelSpec } from '../../lib/utils/model-spec'

/** Process-wide limiter. Limits resolved once from defaults + env. */
export const concurrencyLimiter = new ConcurrencyLimiter(resolveLimits())

/**
 * Best-effort resolution of the provider/modelId a queued execution would
 * run on, using the same selection logic as the runner. Returns undefined if
 * it can't be resolved (treat as unlimited — never block on unknown).
 */
export async function resolveExecutionConcurrencyKey(
  execution: Execution
): Promise<{ provider: string; modelId?: string } | undefined> {
  try {
    const agent = await execution.mustGetAgent()
    // Full resolution: a workflow worker runs its participant's tier or model, not its agent type's.
    const priorityList = await agent.getEffectiveModelSpec()
    const { selected } = selectModelSpecForCurrentEnv(priorityList)
    const parsed = parseModelSpec(selected)
    return { provider: parsed.provider, modelId: parsed.modelId }
  } catch {
    return undefined
  }
}

export { parseConcurrencyKey }
