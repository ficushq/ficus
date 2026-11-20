import type { WorkStreamStatus, WorkStreamSummary } from '@ficus/shared'
import { hasPermission, type Identity } from '../rbac'
import { loadWorkStreamSteps } from '../squad-activity/row-context'
import { presentWorkStreamSummary, streamSummariesEnabled } from './visibility'

export interface WorkStreamStepPresentation {
  step: string | null
  summary?: WorkStreamSummary
}

/**
 * The squads (of `squadIds`) where the viewer may read agents. A summary paraphrases participants'
 * chat, which the Activity feed shows only with `agents:read`, so it needs the same permission.
 */
export async function squadsWithAgentsRead(identity: Identity | undefined, squadIds: Iterable<string>) {
  const unique = [...new Set(squadIds)]
  if (!identity || !unique.length) return new Set<string>()
  const allowed = await Promise.all(unique.map((squadId) => hasPermission(identity, 'agents:read', squadId)))
  return new Set(unique.filter((_, index) => allowed[index]))
}

/**
 * `step` and `summary` for list and detail responses, for queued and active streams only (finished
 * streams get neither). `step` needs only the caller's `workstreams:read` on the stream; `summary`
 * also needs `agents:read` in the stream's squad. Steps come from `loadWorkStreamSteps`: one query of
 * run versions, and run state only for versions not already cached.
 */
export async function loadWorkStreamStepPresentation(
  streams: ReadonlyArray<{ id: string; squadId: string; status: WorkStreamStatus; metadata: unknown }>,
  identity: Identity | undefined,
  enabled: boolean = streamSummariesEnabled()
): Promise<Map<string, WorkStreamStepPresentation>> {
  const result = new Map<string, WorkStreamStepPresentation>()
  const open = streams.filter((stream) => stream.status === 'queued' || stream.status === 'active')
  if (!open.length) return result
  const [steps, readable] = await Promise.all([
    loadWorkStreamSteps(open),
    enabled
      ? squadsWithAgentsRead(
          identity,
          open.filter((stream) => stream.status === 'active').map((stream) => stream.squadId)
        )
      : new Set<string>(),
  ])
  for (const stream of open) {
    const step = steps.get(stream.id) ?? null
    const summary = readable.has(stream.squadId)
      ? presentWorkStreamSummary(stream.metadata, { status: stream.status, step }, enabled)
      : undefined
    result.set(stream.id, summary ? { step, summary } : { step })
  }
  return result
}
