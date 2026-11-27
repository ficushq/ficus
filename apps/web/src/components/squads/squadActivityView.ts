import type { AuthIdentity } from '@ficus/client-core'
import {
  ACTIVITY_WORK_STREAM_CARD_STATE_LABELS,
  PERSON_WAIT_NOUN,
  activityStepLabel,
  activityWorkStreamCardState,
  workStreamSlotWaitLabel,
  type ActivityWorkStreamCard,
  type ActivityWorkStreamCardWait,
  type SquadActivityItem,
  type SquadActivityKind,
  type WorkStreamWaitType,
} from '@ficus/shared'

/**
 * Kind toggles as the user sees them (2026-08-27 audit): the three
 * work-stream-lifecycle kinds present as ONE 'Work' toggle; stored kinds stay
 * distinct on the wire. Labels are explicit — no auto-capitalize ('Pr').
 *
 * Shared by the per-squad tab (SquadActivityTab.tsx) and the global
 * cross-squad feed (ActivityPage.tsx) — both filter the exact same kind
 * vocabulary, so this lives here once rather than forking.
 */
export const FILTER_GROUPS: Array<{ label: string; kinds: SquadActivityKind[] }> = [
  // Operator-audited grouping (2026-08-27 v2): Messages = chat firsts +
  // inbox sends between agents; Work = work-stream lifecycle (status
  // changes, waits, handoffs); Subagents = dispatch lifecycle rows;
  // GitHub = pull-request and issue events. 'execution' rows moved out of
  // Work — subagent starts/finishes are a different signal than work-stream state.
  // 'subagent' rows (a subagent's report to its parent — its completion
  // signal) deliberately belong to BOTH Messages and Subagents.
  { label: 'Messages', kinds: ['message', 'subagent'] },
  { label: 'Work', kinds: ['workstream', 'wait', 'handoff'] },
  { label: 'Subagents', kinds: ['execution', 'subagent'] },
  { label: 'GitHub', kinds: ['pr', 'issue'] },
]

export { activityAgentLabel, activitySubjectLabel } from '@ficus/shared'

/** Per-squad row href: the tab's own squad slug for every row. */
export function squadActivityItemHref(item: SquadActivityItem, slug: string): string {
  if (item.ref.type === 'workstream')
    return `/squads/${slug}/work?ws=${item.ref.workStreamNumber ?? item.ref.workStreamId}`
  if (item.ref.type === 'agent') {
    const params = new URLSearchParams({ agent: item.ref.agentId })
    if (item.ref.view === 'inbox') params.set('view', 'inbox')
    return `/squads/${slug}?${params}`
  }
  return item.ref.url
}

/** Global row href: same shape, but each row resolves its OWN squad's slug. */
export function globalActivityItemHref(
  item: SquadActivityItem & { squadId: string },
  slugFor: (squadId: string) => string
): string {
  return squadActivityItemHref(item, slugFor(item.squadId))
}

export function resolveActivityInboxAccess(
  identity: AuthIdentity | undefined,
  squadId: string,
  can: (permission: string) => boolean
): { mode: 'all' } | { mode: 'own'; recipientId: string } | { mode: 'none' } {
  if (!identity) return { mode: 'none' }
  if (identity.type === 'agent') {
    if (identity.userId || identity.squadId !== squadId) return { mode: 'none' }
    if (can('inbox:read-squad')) return { mode: 'all' }
    return { mode: 'own', recipientId: identity.agentId }
  }
  return can('inbox:read') ? { mode: 'all' } : { mode: 'none' }
}

export function activityAccessSignature(
  identity: AuthIdentity | undefined,
  squadId: string,
  accessResolved: boolean,
  can: (permission: string) => boolean
): string {
  const identityKey =
    identity?.type === 'agent'
      ? `agent:${identity.agentId}:${identity.squadId ?? ''}:${identity.userId ?? ''}`
      : identity?.type === 'user'
        ? `user:${identity.userId}`
        : identity?.type === 'system'
          ? `system:${identity.systemTokenId}`
          : (identity?.type ?? 'unresolved')
  const inbox = resolveActivityInboxAccess(identity, squadId, can)
  const inboxKey = inbox.mode === 'own' ? `own:${inbox.recipientId}` : inbox.mode
  return `${accessResolved}:${identityKey}:${can('squads:read')}:${can('agents:read')}:${can('workstreams:read')}:${inboxKey}`
}

export const ACTIVITY_SMALL_TEXT_CLASS = 'text-secondary'

/**
 * Minimal feed timestamp in the viewer's own timezone (implicit — no offset
 * suffix; the <time dateTime> attribute keeps the machine-readable instant):
 * today → just "13:29"; any other day → "Aug 27 13:29" (no year — the feed
 * retains 30 days, so a year is never ambiguous). `now` is a test seam.
 */
export function formatActivityTimestamp(
  value: string,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
  now: Date = new Date()
): string {
  const date = new Date(value)
  const time = new Intl.DateTimeFormat(locales, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date)
  // Same-calendar-day check in the DISPLAY timezone (en-CA = stable Y-M-D).
  const dayKey = (input: Date) =>
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(input)
  if (dayKey(date) === dayKey(now)) return time
  const day = new Intl.DateTimeFormat(locales, { month: 'short', day: 'numeric', timeZone }).format(date)
  return `${day} ${time}`
}

export function squadActivityStatusMessage(isLoading: boolean, isError: boolean, itemCount: number): string | null {
  if (isError) return 'Unable to load activity.'
  if (isLoading) return 'Loading activity…'
  return itemCount === 0 ? 'No activity matches these filters.' : null
}

export function activityExternalHref(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return value
  } catch {
    /* Unknown and unsafe destinations render as text. */
  }
}

/* Active work labels (ActivityWorkPicker.tsx, ActivityWorkStreamDetails.tsx). */

/**
 * A row's state line: the state ("Working", "Paused", "Waiting on you: review", "Waiting: dependency")
 * then the step when it adds something ("Working · Implement"). The step label is normalized, so
 * `implement` and `Implement` read the same.
 */
export function activityWorkStateLine(card: ActivityWorkStreamCard): { state: string; step: string | null } {
  const kind = activityWorkStreamCardState(card)
  const waits =
    activityCardWaitLabel(card) ?? (kind === 'waiting' && card.slotWait ? workStreamSlotWaitLabel(card.slotWait) : null)
  const state =
    (kind === 'needs-you' || kind === 'waiting') && waits ? waits : ACTIVITY_WORK_STREAM_CARD_STATE_LABELS[kind]
  const step = activityStepLabel(card.step)
  return { state, step: step && step !== state && step !== 'Paused' ? step : null }
}

const WAIT_LABELS: Record<WorkStreamWaitType, string> = {
  review: 'review',
  question: 'question',
  dependency: 'dependency',
  manual: 'blocker',
}

/** What a person is waited on for, as "Waiting on review" reads it to someone who cannot act. */
const PERSON_WAIT_NOUNS: Record<WorkStreamWaitType, string> = {
  review: PERSON_WAIT_NOUN.review,
  question: PERSON_WAIT_NOUN.answer,
  // A dependency never waits on a person; named only so every wait type reads.
  dependency: 'a dependency',
  manual: PERSON_WAIT_NOUN.blocker,
}

/**
 * One wait as the label reads it. `you` narrows "a person must act" (`needsYou`) to the viewer:
 * false when this viewer cannot act on it. Core sets it on Active work cards for the viewer; cards
 * from older servers omit it and read as the viewer's.
 */
export type ActivityCardLabelWait = ActivityWorkStreamCardWait

/**
 * "Waiting on you: review" when the viewer must act, "Waiting on review" when someone else must,
 * else "Waiting: dependency". A review no person can act on yet is a workflow gate queued behind
 * the other waits, so it trails as "· review next" ("Waiting on you: question · review next")
 * instead of reading as current.
 */
export function activityCardWaitLabel(card: { waits: readonly ActivityCardLabelWait[] }): string | null {
  const queuedReview = card.waits.some((wait) => wait.type === 'review' && !wait.needsYou)
  const current = queuedReview ? card.waits.filter((wait) => wait.type !== 'review' || wait.needsYou) : card.waits
  const suffix = queuedReview ? ' · review next' : ''
  const named = (waits: readonly ActivityCardLabelWait[], words: Record<WorkStreamWaitType, string>) =>
    [...new Set(waits.map((wait) => words[wait.type]))].join(', ')
  const mine = current.filter((wait) => wait.needsYou && wait.you !== false)
  if (mine.length) return `Waiting on you: ${named(mine, WAIT_LABELS)}${suffix}`
  const people = current.filter((wait) => wait.needsYou)
  if (people.length) return `Waiting on ${named(people, PERSON_WAIT_NOUNS)}${suffix}`
  if (current.length) return `Waiting: ${named(current, WAIT_LABELS)}${suffix}`
  return queuedReview ? 'Waiting: review' : null
}

const CI_LABELS: Record<NonNullable<ActivityWorkStreamCard['ci']>, string> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI running',
}

/** "PR #12 · CI failing · Review Pull Request", omitting anything not known. */
export function activityCardDeliveryLabel(
  card: Pick<ActivityWorkStreamCard, 'pullRequest' | 'ci' | 'deliveryLabel'>
): string | null {
  const parts: string[] = []
  if (card.pullRequest)
    parts.push(`PR #${card.pullRequest.number}${card.pullRequest.state === 'open' ? '' : ` ${card.pullRequest.state}`}`)
  if (card.ci) parts.push(CI_LABELS[card.ci])
  // The CI part already says what a CI delivery label would.
  if (card.deliveryLabel && !(card.ci && /\bCI\b/.test(card.deliveryLabel))) parts.push(card.deliveryLabel)
  return parts.length ? parts.join(' · ') : null
}
