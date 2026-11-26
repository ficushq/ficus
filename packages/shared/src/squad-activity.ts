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

/**
 * Row lanes. 32 is a Reviewer agent's flow verdict (approved, changes requested, returned), sourced
 * from the work stream's recorded flow transitions.
 */
export const SQUAD_ACTIVITY_LANES = [10, 20, 21, 22, 30, 31, 32, 40, 41, 50, 60, 61, 70, 71] as const
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

/**
 * The work stream an agent row's agent works on: set only when the agent is a
 * workflow-bound participant of that stream (`workflow_bindings`). The stream
 * owner, the squad manager and consultants are never bound, so their rows never
 * carry one. Present only when the viewer may read work streams in the row's squad.
 */
export interface ActivityWorkStreamContext {
  id: string
  /** Instance-wide work stream number (`#1352`). */
  number: number
  title: string
  squadId: string
  status: import('./types').WorkStreamStatus
  /**
   * Display name of the stream's current workflow step, for example "Implement".
   * Several running steps are joined with " + ". `Completion-ready` or `Paused` when
   * no step runs, `Done` or `Canceled` for a finished stream, null without a flow.
   */
  step: string | null
}

/**
 * Server-resolved context for a row whose subject is an agent (`ref.type === 'agent'`),
 * so clients never fetch per row. Both fields are optional and independent: a bound
 * participant carries `workStream`; an agent with a purpose (`set_agent_purpose`)
 * carries `purpose`. Clients show the stream when present, otherwise the purpose,
 * otherwise only the agent type label (`activityRowContextLabel`).
 */
export interface ActivityRowContext {
  workStream?: ActivityWorkStreamContext
  /** The agent's purpose. Present only when the viewer may read agents in the row's squad. */
  purpose?: string
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
  /** Agent rows only. Absent from older servers and when there is nothing the viewer may see. */
  context?: ActivityRowContext
  /**
   * Received-message rows only ("Received message from …" and subagent reports): the
   * activity id (`10:<executionId>`) of the sender's own chat row for the run that sent
   * this inbox message. Clients use it to hide that sender row while this received row
   * is shown (`hideRelayedSenderRows`). Same-squad agent senders only, and only for
   * viewers who may read agents in the row's squad.
   */
  senderActivityId?: string
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

/** One open wait on an Active work card. */
export interface ActivityWorkStreamCardWait {
  /** Display type: `review`, `question`, `dependency` or `manual`. */
  type: import('./types').WorkStreamWaitType
  /** A person must act (rather than an agent, the owner or the manager). */
  needsYou: boolean
}

/** The stream's primary pull request, when its code-host binding names one. */
export interface ActivityWorkStreamCardPullRequest {
  number: number
  url?: string
  repository: string
  /** Open unless delivery tracking observed a merge or close. */
  state: 'open' | 'merged' | 'closed'
}

/**
 * One queued or active work stream on the Activity view's Active work strip.
 * Everything comes from the server; clients render it without further requests.
 */
export interface ActivityWorkStreamCard {
  id: string
  number: number
  squadId: string
  title: string
  status: import('./types').WorkStreamStatus
  /** Same meaning as `ActivityWorkStreamContext.step`. */
  step: string | null
  /** Open waits, display precedence first. */
  waits: ActivityWorkStreamCardWait[]
  /** The stream needs the viewer (the same rule as `needsYouCount`). */
  needsYou: boolean
  pullRequest: ActivityWorkStreamCardPullRequest | null
  /** Aggregate CI state of the delivery pull request when delivery tracking knows it. */
  ci: 'passing' | 'failing' | 'pending' | null
  /** Delivery label such as "Awaiting CI" or "Review Pull Request", when there is one. */
  deliveryLabel: string | null
  /** Bound participants running right now. Empty unless the viewer may read agents. */
  workingAgentIds: string[]
  /** Newest of the bound participants' latest Activity row and the stream's last update (ISO). */
  lastEventAt: string
  /**
   * The stream's one-line summary (docs/wiki/work-stream-summaries.md), only while it was generated
   * for `step` and the instance switch is on; absent otherwise.
   */
  summary?: string | null
  /** ISO time `summary` was generated; present with it. */
  summaryGeneratedAt?: string
  /**
   * The stream's derived state (the same value as `WorkStream.derivedState`), so a paused stream
   * reads as paused even when its flow is not. Absent from older servers.
   */
  derivedState?: import('./types').WorkStreamDerivedState
  /**
   * The participant is queued for a slot (the same value as `WorkStream.slotWait`). The row reads
   * "Waiting for heavy-work slot (position 2 of 5, host busy)" instead of Idle. Absent from older servers.
   */
  slotWait?: import('./types').WorkStreamSlotWait
}

/**
 * Step labels as a person reads them: each running step starts with a capital letter, so a step
 * named `implement` and one named `Implement` look the same ("Implement + review").
 */
export function activityStepLabel(step: string | null | undefined): string | null {
  const trimmed = step?.trim()
  if (!trimmed) return null
  return trimmed
    .split(' + ')
    .map((part) => {
      const name = part.trim()
      return name ? name[0].toUpperCase() + name.slice(1) : name
    })
    .join(' + ')
}

/**
 * The one state an Active work row shows, in precedence order: a person must act; a participant is
 * running; the stream is paused; it waits on something else (a review, an answer, a dependency, its
 * pull request or a slot); it is queued; otherwise nobody is working on it right now.
 */
export type ActivityWorkStreamCardState = 'needs-you' | 'working' | 'paused' | 'waiting' | 'queued' | 'idle'

const WAITING_DERIVED_STATES = new Set<string>([
  'in_review',
  'waiting_on_answer',
  'waiting_on_dependency',
  'awaiting_delivery',
  'blocked',
])

export function activityWorkStreamCardState(
  card: Pick<ActivityWorkStreamCard, 'needsYou' | 'workingAgentIds' | 'step' | 'waits' | 'status' | 'derivedState'> &
    Partial<Pick<ActivityWorkStreamCard, 'slotWait'>>
): ActivityWorkStreamCardState {
  if (card.needsYou) return 'needs-you'
  if (card.workingAgentIds.length > 0) return 'working'
  if (card.derivedState === 'paused' || card.step === 'Paused') return 'paused'
  if (
    card.waits.length > 0 ||
    (card.derivedState && WAITING_DERIVED_STATES.has(card.derivedState)) ||
    (card.slotWait && card.derivedState === 'idle')
  )
    return 'waiting'
  if (card.status === 'queued') return 'queued'
  return 'idle'
}

/** Display labels for {@link ActivityWorkStreamCardState}, shared by the row badge and the counts. */
export const ACTIVITY_WORK_STREAM_CARD_STATE_LABELS: Record<ActivityWorkStreamCardState, string> = {
  'needs-you': 'Waiting on you',
  working: 'Working',
  paused: 'Paused',
  waiting: 'Waiting',
  queued: 'Queued',
  idle: 'Idle',
}

/** Permission-filtered presence summary for the cross-squad activity feed. */
export interface GlobalActivityPresence {
  workingAgentIds: string[]
  workingCount: number
  needsYouCount: number
  streamCount: number
  /**
   * Active work cards: streams needing you first, then newest event first. The same
   * streams `streamCount` counts (muted progress excluded), capped at
   * `ACTIVITY_WORK_STREAM_CARD_LIMIT`. Absent from older servers.
   */
  streams?: ActivityWorkStreamCard[]
}

/** Per-squad presence (GET /api/squads/:id/activity/presence) has the same shape. */
export type SquadActivityPresence = GlobalActivityPresence

/**
 * Row kinds that can change an Active work card (step, waits, handoff, PR state). Clients
 * refetch presence on these live rows only; agent status changes refresh it through the
 * agents topic, and everything else waits for the 30-second poll.
 */
export const ACTIVITY_PRESENCE_ROW_KINDS: readonly SquadActivityKind[] = [
  'workstream',
  'wait',
  'handoff',
  'pr',
  'issue',
]

/**
 * Upper bound on `streams` in one presence response: twice what the strip shows, so a
 * selected card just past the visible six usually stays available. Clients show fewer
 * plus "+N more" (from `streamCount`).
 */
export const ACTIVITY_WORK_STREAM_CARD_LIMIT = 12

export interface SquadActivityFilters {
  verbose?: boolean
  agentIds?: string[]
  kinds?: SquadActivityKind[]
  /** Only this work stream: its own rows plus rows of its bound participants. */
  workStreamId?: string
}

/**
 * Work settled without a person, as the Feed's "since your last visit" line counts it. Each kind
 * names exactly the Activity rows that make up its count (GET /api/activity/settled):
 * - `questions`: closed task-input waits an agent asked of its stream owner (`request-input` with
 *   `actor: owner`) and another agent answered, that never asked a person (lane 41).
 * - `reviews`: verdicts a Reviewer agent submitted on a flow step (lane 32).
 * - `completed`: work streams marked done (lane 31 done notices), counted once per stream.
 */
export const ACTIVITY_SETTLED_KINDS = ['questions', 'reviews', 'completed'] as const
export type ActivitySettledKind = (typeof ACTIVITY_SETTLED_KINDS)[number]

/** An Activity filter to the rows behind one settled count, from `since` (inclusive). */
export interface ActivitySettledFilter {
  kind: ActivitySettledKind
  /** ISO time. The server raises it to the Activity retention floor. */
  since: string
}

/** GET /api/activity/settled: permission-filtered counts of work settled without a person. */
export interface ActivitySettledSummary {
  /** The period start actually counted: the requested time, raised to the retention floor. */
  since: string
  /** True when the requested time was older than Activity keeps rows and was raised. */
  clamped: boolean
  counts: Record<ActivitySettledKind, number>
}

export interface NormalizedSquadActivityFilters {
  verbose: boolean
  agentIds: string[]
  kinds: SquadActivityKind[]
  /** Omitted means every stream. */
  workStreamId?: string
  /** Global feed only: only rows behind one settled count. */
  settled?: ActivitySettledFilter
  /** Global feed only: only these squads (still limited to the ones the caller may read). Omitted means all. */
  squadIds?: string[]
}

/** "4 questions settled by managers": the count with its noun, singular when it is one. */
export function activitySettledCountLabel(kind: ActivitySettledKind, count: number): string {
  const one = count === 1
  if (kind === 'questions') return `${count} ${one ? 'question' : 'questions'} settled by managers`
  if (kind === 'reviews') return `${count} ${one ? 'review' : 'reviews'} done by agents`
  return `${count} ${one ? 'stream' : 'streams'} completed`
}

/**
 * The context line for an agent row: "#1352 Floating agent windows · Implement" for a
 * bound participant, else the agent's purpose, else null (show only the type label).
 */
export function activityRowContextLabel(item: Pick<SquadActivityItem, 'ref' | 'context'>): string | null {
  if (!item.ref || typeof item.ref !== 'object' || item.ref.type !== 'agent') return null
  const stream = item.context?.workStream
  if (stream) return [`#${stream.number} ${stream.title}`, activityStepLabel(stream.step)].filter(Boolean).join(' · ')
  const purpose = item.context?.purpose?.trim()
  return purpose || null
}

/**
 * How much later than the received row a sender row may be and still be the run's
 * lead-up to the message: a step's message row lands after its tool calls finish.
 * A sender row newer than this says something new and stays.
 */
export const RELAYED_SENDER_ROW_SLACK_MS = 60_000

/**
 * Default-view cleanup for relayed messages: hide a sender's own chat row while at least
 * one received row naming it (`senderActivityId`) is in `items`. Pass exactly the rows
 * the view shows after every filter, so a received row that is filtered out, or belongs
 * to a squad the viewer cannot see, never hides the sender row and a message never
 * disappears. With several recipients, any shown received row hides it. Order is kept.
 */
export function hideRelayedSenderRows<T extends Pick<SquadActivityItem, 'id' | 'at' | 'senderActivityId'>>(
  items: readonly T[]
): T[] {
  const latestReceivedAt = new Map<string, number>()
  for (const item of items) {
    if (!item.senderActivityId) continue
    const at = Date.parse(item.at)
    if (!(at <= (latestReceivedAt.get(item.senderActivityId) ?? -Infinity)))
      latestReceivedAt.set(item.senderActivityId, at)
  }
  if (latestReceivedAt.size === 0) return [...items]
  return items.filter((item) => {
    const receivedAt = latestReceivedAt.get(item.id)
    return receivedAt === undefined || Date.parse(item.at) > receivedAt + RELAYED_SENDER_ROW_SLACK_MS
  })
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
