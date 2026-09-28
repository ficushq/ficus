import type { AuthIdentity } from '@ficus/client-core'
import type { SquadActivityItem, SquadActivityKind } from '@ficus/shared'

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

/** Row agent label: the Title-Cased agent type ONLY, 'system' for rows with no agent type. */
function titleCaseAgentType(agentTypeId: string): string {
  return agentTypeId
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

/**
 * Row agent label (operator decision 2026-08-27: the purpose/name
 * parenthetical always truncated in the label column — it now lives in the
 * row's title tooltip instead). Subagent rows (spawn lifecycle + reports)
 * nest under their parent type: "› Reviewer".
 */
export function activityAgentLabel(agentTypeId: string | null, kind?: SquadActivityKind): string {
  if (!agentTypeId) return 'system'
  const type = titleCaseAgentType(agentTypeId)
  return kind === 'execution' || kind === 'subagent' ? `› ${type}` : type
}

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
