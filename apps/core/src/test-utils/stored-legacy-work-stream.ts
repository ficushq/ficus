import { eq } from 'drizzle-orm'
import type { CreateWorkStreamInput } from '@ficus/shared'
import { db, squads, workStreams } from '../db'
import { WorkStream } from '../entities/WorkStream'
import { resetContinuationCycle } from '../services/work-streams/continuation-state'
import { syncDependencyWaits } from '../services/work-streams/waits'
import { admitOrQueueAtCreation } from '../services/work-streams/admission'

/**
 * Seed a pre-flow record to exercise the supported lifecycle of stored legacy
 * streams. This deliberately bypasses creation APIs: they always create flows.
 * New-creation tests must call WorkStream.create or the HTTP route instead.
 */
export async function storedLegacyWorkStream(input: CreateWorkStreamInput): Promise<WorkStream> {
  if (input.workflow) throw new Error('A stored legacy fixture cannot contain a flow')
  const [squad] = await db.select().from(squads).where(eq(squads.id, input.squadId))
  const metadata = { ...input.metadata }
  if (input.completionMode) metadata.completion = { ...(metadata.completion as object), mode: input.completionMode }
  const git = { ...(metadata.git as Record<string, unknown>) }
  for (const field of ['branch', 'worktree', 'baseBranch'] as const)
    if (input[field] !== undefined) git[field] = input[field]
  if (Object.keys(git).length) metadata.git = git
  const id = await db.transaction(async (tx) => {
    // Match WorkStream.create: take the admission mutex before the insert acquires
    // an FK key-share lock, otherwise concurrent fixtures deadlock upgrading it.
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, input.squadId)).for('update')
    const [row] = await tx
      .insert(workStreams)
      .values({
        squadId: input.squadId,
        title: input.title,
        description: input.description ?? '',
        assigneeAgentId: input.assigneeAgentId ?? null,
        ownerAgentId: input.ownerAgentId ?? squad?.managerAgentId ?? null,
        creatorAgentId: input.creatorAgentId ?? null,
        requestingUserId: input.requestingUserId ?? null,
        agentIds: input.agentIds ?? null,
        handoffMessage: input.handoffMessage ?? null,
        dependsOn: input.dependsOn ?? [],
        priority: input.priority ?? 'normal',
        metadata,
      })
      .returning()
    if (input.assigneeAgentId) await resetContinuationCycle(tx, row!.id, input.assigneeAgentId)
    if (row!.dependsOn?.length) await syncDependencyWaits(tx, row!.id, row!.dependsOn)
    await admitOrQueueAtCreation(tx, { squadId: row!.squadId, streamId: row!.id })
    return row!.id
  })
  return WorkStream.mustFind(id)
}
