import type { WorkStreamStatus, WorkStreamSummary } from '@ficus/shared'
import { loadWorkStreamSteps } from '../squad-activity/row-context'
import { presentWorkStreamSummary, streamSummariesEnabled } from './visibility'

export interface WorkStreamStepPresentation {
  step: string | null
  summary?: WorkStreamSummary
}

/**
 * `step` and `summary` for list and detail responses, for queued and active streams only (finished
 * streams get neither). Steps come from `loadWorkStreamSteps`: one query of run versions, and run
 * state only for versions not already cached.
 */
export async function loadWorkStreamStepPresentation(
  streams: ReadonlyArray<{ id: string; status: WorkStreamStatus; metadata: unknown }>,
  enabled: boolean = streamSummariesEnabled()
): Promise<Map<string, WorkStreamStepPresentation>> {
  const result = new Map<string, WorkStreamStepPresentation>()
  const open = streams.filter((stream) => stream.status === 'queued' || stream.status === 'active')
  if (!open.length) return result
  const steps = await loadWorkStreamSteps(open)
  for (const stream of open) {
    const step = steps.get(stream.id) ?? null
    const summary = presentWorkStreamSummary(stream.metadata, { status: stream.status, step }, enabled)
    result.set(stream.id, summary ? { step, summary } : { step })
  }
  return result
}
