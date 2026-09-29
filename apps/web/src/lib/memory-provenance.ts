export interface MemoryProvenanceEntry {
  documentId: string
  sourceSquadId: string
  sourceType: string | null
  sensitivity: string
  path: string | null
  title: string | null
  score: number
  url?: string
}

/** The marker Core's memory_search writes: `<!--ficus:memory-provenance [...] -->`. */
export const MEMORY_PROVENANCE_MARKER = 'ficus:memory-provenance'
/**
 * The marker written before the Ficus rename. Tool results stored in conversation history still
 * carry it, so it is read (never written) until the Wave 3 migration.
 */
export const LEGACY_MEMORY_PROVENANCE_MARKER = 'tau:memory-provenance' // ficus-36c

const BLOCK_RE = new RegExp(
  String.raw`<!--(?:${MEMORY_PROVENANCE_MARKER}|${LEGACY_MEMORY_PROVENANCE_MARKER})\s+(\[[\s\S]*?\])\s*-->`
)

export function parseMemoryProvenance(result: string): MemoryProvenanceEntry[] | null {
  const match = result.match(BLOCK_RE)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[1])
    if (!Array.isArray(parsed)) return null
    return parsed as MemoryProvenanceEntry[]
  } catch {
    return null
  }
}

export function stripProvenanceBlock(result: string): string {
  return result.replace(BLOCK_RE, '')
}
