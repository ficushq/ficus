export const SQUAD_ACTIVITY_KINDS = [
  'message',
  'workstream',
  'wait',
  'handoff',
  'execution',
  'subagent',
  'pr',
  'issue',
] as const
export type SquadActivityKind = (typeof SQUAD_ACTIVITY_KINDS)[number]

export const SQUAD_ACTIVITY_LANES = [10, 20, 21, 22, 30, 31, 40, 41, 50, 60, 61, 70, 71] as const
export type SquadActivityLane = (typeof SQUAD_ACTIVITY_LANES)[number]

export type SquadActivityRef =
  | { type: 'agent'; agentId: string; view: 'chat' | 'inbox'; messageId?: string; executionId?: string }
  | { type: 'workstream'; workStreamId: string; workStreamNumber?: number }
  | { type: 'pr'; url: string }
  | { type: 'issue'; url: string; workStreamId?: string; workStreamNumber?: number }

/**
 * Normalize a stored `ref` back into an object.
 *
 * tenant-zero accumulated activity rows whose `ref` jsonb column was double-encoded — persisted as
 * a JSON *string* rather than an object. A string ref breaks every client: the feed reads
 * `ref.type` / `ref.url` as `undefined`, so an agent row no longer routes to a chat — it falls
 * through to the external branch. On mobile that calls `Linking.openURL(undefined)`, a fatal
 * RCTFatalException; on web it builds an `undefined` href, so the row click does nothing. Parsing
 * the string back to an object at the read boundary makes every client see a well-formed ref
 * regardless of how the row happened to be persisted.
 */
export function coerceSquadActivityRef(raw: unknown): SquadActivityRef {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') return parsed as SquadActivityRef
    } catch {
      // Not JSON — return as-is; the caller/client still guards unrecognized shapes.
    }
  }
  return raw as SquadActivityRef
}

/** Flat, source-generated inline spans. No HTML or Markdown parsing on clients.
 * Links are absolute HTTP(S) or explicit Ficus references; code is always literal.
 * The visible budget includes ellipsis, not destinations. Regenerate old rows
 * from source before rollout; summary is plain text, not a rendering fallback.
 */
export interface ActivityPreviewSpan {
  text: string
  bold?: true
  italic?: true
  code?: true
  href?: string
}

export interface SquadActivityItem {
  id: string
  at: string
  agentId: string | null
  agentTypeId: string | null
  kind: SquadActivityKind
  summary: string
  preview: ActivityPreviewSpan[]
  ref: SquadActivityRef
}

/** Agent identity only; a missing/redacted type is not evidence of a system sender. */
export function activityAgentLabel(agentTypeId: string | null): string {
  if (!agentTypeId) return 'Agent'
  return agentTypeId
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

/** The primary identity always names the navigation destination, never its actor. */
export function activitySubjectLabel(item: SquadActivityItem): string {
  const ref = item.ref
  if (!ref || typeof ref !== 'object') return 'Activity'
  if (ref.type === 'agent') return activityAgentLabel(item.agentTypeId)
  if (ref.type === 'workstream')
    return ref.workStreamNumber !== undefined
      ? `Work stream #${ref.workStreamNumber}`
      : ref.workStreamId
        ? `Work stream ${ref.workStreamId.slice(0, 8)}`
        : 'Work stream'
  if (ref.type === 'pr') {
    const number = /\/pull\/(\d+)(?:[/?#]|$)/.exec(ref.url)?.[1]
    return number ? `PR #${number}` : 'Pull request'
  }
  if (ref.type === 'issue') {
    const number = /\/issues\/(\d+)(?:[/?#]|$)/.exec(ref.url)?.[1]
    return number ? `Issue #${number}` : 'Issue'
  }
  return 'Activity'
}

export interface SquadActivityPage {
  items: SquadActivityItem[]
  hasMore: boolean
  nextCursor: string | null
}

/**
 * Cross-squad activity row: the same wire item as the per-squad feed, plus the
 * owning squad's id so a global feed's client can render a "which squad" chip
 * without a follow-up fetch per row. The per-squad `SquadActivityItem` wire
 * shape stays untouched — this is additive, never a replacement.
 */
export interface GlobalSquadActivityItem extends SquadActivityItem {
  squadId: string
}

/** Minimal per-squad info the global feed needs to render its chip. */
export interface GlobalSquadActivitySquadInfo {
  name: string
}

export interface GlobalSquadActivityPage {
  items: GlobalSquadActivityItem[]
  hasMore: boolean
  nextCursor: string | null
  /** Lookup for every squad referenced by `items` (and possibly more) — avoids N follow-up fetches. */
  squads: Record<string, GlobalSquadActivitySquadInfo>
}

/** Permission-filtered presence summary for the cross-squad activity feed. */
export interface GlobalActivityPresence {
  workingAgentIds: string[]
  workingCount: number
  needsYouCount: number
  streamCount: number
}

export interface SquadActivityFilters {
  verbose?: boolean
  agentIds?: string[]
  kinds?: SquadActivityKind[]
}

export interface NormalizedSquadActivityFilters {
  verbose: boolean
  agentIds: string[]
  kinds: SquadActivityKind[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const laneSet = new Set<number>(SQUAD_ACTIVITY_LANES)

export function makeSquadActivityId(lane: SquadActivityLane, rowId: string): string {
  if (!laneSet.has(lane) || !UUID.test(rowId)) throw new TypeError('Invalid squad activity identity')
  return `${lane}:${rowId}`
}

export function parseSquadActivityId(id: string): { lane: SquadActivityLane; rowId: string } | null {
  const match = /^(\d+):(.+)$/.exec(id)
  if (!match) return null
  const lane = Number(match[1])
  if (!laneSet.has(lane) || String(lane) !== match[1] || !UUID.test(match[2])) return null
  return { lane: lane as SquadActivityLane, rowId: match[2] }
}

/** Canonical newest-first order shared by the API merge and the live client overlay. */
export function compareSquadActivityItems(a: SquadActivityItem, b: SquadActivityItem): number {
  const byTime = b.at.localeCompare(a.at)
  if (byTime !== 0) return byTime
  const aIdentity = parseSquadActivityId(a.id)
  const bIdentity = parseSquadActivityId(b.id)
  if (!aIdentity || !bIdentity) return b.id.localeCompare(a.id)
  const byLane = bIdentity.lane - aIdentity.lane
  return byLane !== 0 ? byLane : bIdentity.rowId.localeCompare(aIdentity.rowId)
}
