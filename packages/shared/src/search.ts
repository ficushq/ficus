import { z } from 'zod'

export const searchEntityKindSchema = z.enum([
  'squad',
  'work_stream',
  'consultant_conversation',
  'assistant_conversation',
])
export const entitySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  kind: searchEntityKindSchema.optional(),
  squadId: z.string().uuid().optional(),
})
export type EntitySearchQuery = z.infer<typeof entitySearchQuerySchema>
export interface EntitySearchResult {
  number?: number | null
  kind: z.infer<typeof searchEntityKindSchema>
  id: string
  label: string
  detail: string
  squadId: string | null
  squadName: string | null
  status: string | null
  updatedAt: string
  /** The agent behind a conversation result: the Assistant agent, or the consultant itself. Null otherwise. */
  agentId: string | null
  score: number
}
export interface EntitySearchResponse {
  results: EntitySearchResult[]
}
