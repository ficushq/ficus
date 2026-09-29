import { db } from '../../../db'
import { memoryAccessAudit } from '../../../db/schema'

export interface RecordAccessInput {
  callerSquadId: string
  callerAgentId?: string | null
  action: 'search' | 'read' | 'write' | 'outline' | `live_search:${string}`
  sourceSquadIds: string[]
  resourcePath?: string | null
  resultCount?: number | null
}

export async function recordMemoryAccess(input: RecordAccessInput): Promise<void> {
  const sourceSquadIds = Array.from(new Set(input.sourceSquadIds.filter((id) => id !== input.callerSquadId)))
  if (sourceSquadIds.length === 0) return

  await db.insert(memoryAccessAudit).values(
    sourceSquadIds.map((sourceSquadId) => ({
      callerSquadId: input.callerSquadId,
      sourceSquadId,
      callerAgentId: input.callerAgentId ?? null,
      action: input.action,
      resourcePath: input.resourcePath ?? null,
      resultCount: input.resultCount ?? null,
    }))
  )
}
