import {
  pendingActionContextLine,
  workStreamTitle,
  type Agent,
  type PendingAction,
  type Squad,
  type WorkStream,
} from '@ficus/shared'
import { assistantSearch } from './assistantSearch'
import { getAgentName, getConversationTitle, type AgentTypeName } from './agentDisplay'
import { matchesSetting, settingMatchRank } from '../components/settings/settingsSearch'

export type CommandDestination =
  | { kind: 'squad'; id: string; label: string }
  | { kind: 'work'; id: string; label: string; squadId: string }
  | { kind: 'action'; id: string; label: string }
  | {
      kind: 'chat'
      id: string
      label: string
      agentId?: string
      squadId?: string
      initialText?: string
      readOnly?: boolean
    }

/** A saved Assistant conversation reached from an activity row; opened through the Assistant stack. */
export type AssistantConversationDestination = { kind: 'assistant'; id: string; label: string }

export interface CommandResult {
  id: string
  label: string
  detail: string
  kind: 'Squad' | 'Work stream' | 'Conversation' | 'Needs you' | 'Page' | 'Setting'
  destination?: CommandDestination | AssistantConversationDestination
  path?: string
  keywords?: string
  agentTypeId?: string
  status?: Agent['status']
  work?: WorkStream
  /** Update rows only: unread marker, task summary, and the latest update time. */
  unread?: boolean
  summary?: string
  timestamp?: string
}

export function consultantConversations(agents: readonly Agent[]) {
  return agents
    .filter((a) => a.agentTypeId === 'consultant' && a.squadId && a.status !== 'terminated' && a.status !== 'dormant')
    .sort(
      (a, b) =>
        new Date(b.lastHumanMessageAt ?? b.createdAt).getTime() -
        new Date(a.lastHumanMessageAt ?? a.createdAt).getTime()
    )
}

export function actionTitle(action: PendingAction): string {
  const data = action.data
  if ('workStreamTitle' in data) return data.workStreamTitle
  if ('taskLabel' in data) return data.taskLabel
  if ('reason' in data) return data.reason || 'Work needs attention'
  if ('questionData' in data) {
    const question = data.questionData as { question?: string; questions?: { question?: string }[] }
    return question.question || question.questions?.[0]?.question || 'Question awaiting your answer'
  }
  return 'Needs your attention'
}

export function commandCenterSearch(
  query: string,
  data: {
    squads: readonly Squad[]
    streams: readonly WorkStream[]
    consultants: readonly Agent[]
    actions: readonly PendingAction[]
    allowedSettings: ReadonlySet<string>
    squadId?: string
    /** The configured agent type names, so conversations read as every other surface names them. */
    typeNames?: AgentTypeName
  },
  now = Date.now()
): CommandResult[] {
  const squadName = (id: string | null | undefined) => data.squads.find((s) => s.id === id)?.name ?? 'Personal'
  const scoped = (id: string | null | undefined) => !data.squadId || id === data.squadId
  const squadManager = data.squadId ? data.squads.find((s) => s.id === data.squadId)?.managerAgentId : undefined
  const rows: CommandResult[] = [
    ...(squadManager
      ? [
          {
            id: `chat:${squadManager}`,
            kind: 'Conversation' as const,
            label: 'Manager',
            detail: 'Squad coordinator',
            keywords: 'manager coordinator',
            agentTypeId: 'manager',
            destination: {
              kind: 'chat' as const,
              id: squadManager,
              agentId: squadManager,
              squadId: data.squadId,
              label: 'Manager',
            },
          },
        ]
      : []),
    ...data.actions
      .filter((a) => scoped(a.squadId ?? a.data.squadId))
      .map((a) => ({
        id: `action:${a.id}`,
        kind: 'Needs you' as const,
        label: actionTitle(a),
        detail: pendingActionContextLine(a, data.typeNames),
        destination: { kind: 'action' as const, id: a.id, label: actionTitle(a) },
      })),
    ...data.squads
      .filter((s) => scoped(s.id))
      .map((s) => ({
        id: `squad:${s.id}`,
        kind: 'Squad' as const,
        label: s.name,
        detail: s.purpose || 'Squad',
        destination: { kind: 'squad' as const, id: s.id, label: s.name },
      })),
    ...consultantConversations(data.consultants)
      .filter((a) => scoped(a.squadId))
      .map((a) => ({
        id: `chat:${a.id}`,
        kind: 'Conversation' as const,
        status: a.status,
        agentTypeId: a.agentTypeId,
        label: getConversationTitle(a, data.typeNames),
        // The agent's name stays searchable even though the title leads with its type or topic.
        keywords: getAgentName(a),
        detail: `${squadName(a.squadId)} · ${new Date(a.lastHumanMessageAt ?? a.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
        destination: {
          kind: 'chat' as const,
          id: a.id,
          agentId: a.id,
          squadId: a.squadId!,
          label: getConversationTitle(a, data.typeNames),
        },
      })),
    ...data.streams
      .filter(
        (w) => scoped(w.squadId) && (query.trim() || isOpenWork(w) || (w.status === 'done' && workAgeDays(w, now) <= 7))
      )
      .sort((a, b) => Number(!isOpenWork(a)) - Number(!isOpenWork(b)) || workTimestamp(b) - workTimestamp(a))
      .map((w) => ({
        id: `work:${w.id}`,
        kind: 'Work stream' as const,
        work: w,
        // "#number · title", as every work stream row shows it; the number stays searchable.
        label: workStreamTitle(w),
        detail: squadName(w.squadId),
        keywords: w.derivedState ?? w.status,
        destination: { kind: 'work' as const, id: w.id, squadId: w.squadId, label: workStreamTitle(w) },
      })),
    ...(!data.squadId ? assistantSearch(query, [], [], data.allowedSettings) : []),
  ]
  if (!query.trim()) {
    // Keep the landing list useful even with a large workspace.
    const counts = new Map<string, number>()
    return rows.filter((row) => {
      const count = counts.get(row.kind) ?? 0
      counts.set(row.kind, count + 1)
      return count < (row.kind === 'Needs you' ? 4 : 5)
    })
  }
  return rows
    .filter((row) => matchesSetting(query, row.label, row.detail, row.kind, row.keywords ?? ''))
    .sort((a, b) => {
      const aMatch = titleMatchRank(query, a)
      const bMatch = titleMatchRank(query, b)
      // An exact title remains the best way to retrieve older work. Otherwise,
      // blend title relevance with completion age, keeping keyword-only hits last.
      if (aMatch === 0 || bMatch === 0) {
        if (aMatch !== bMatch) return aMatch - bMatch
      }
      return (
        resultScore(a, aMatch, now) - resultScore(b, bMatch, now) ||
        (a.work && b.work ? workTimestamp(b.work) - workTimestamp(a.work) : 0)
      )
    })
}

/**
 * A work stream's label is "#number · title", so rank on its title as well: an exact or prefix
 * title still finds older work first, and a "#12" search still matches the number.
 */
function titleMatchRank(query: string, row: CommandResult) {
  const label = settingMatchRank(query, row.label)
  return row.work ? Math.min(label, settingMatchRank(query, row.work.title)) : label
}

function isOpenWork(work: WorkStream) {
  return work.status === 'active' || work.status === 'queued'
}

function workTimestamp(work: WorkStream) {
  const value = !isOpenWork(work)
    ? (work.completedAt ?? work.updatedAt ?? work.createdAt)
    : (work.updatedAt ?? work.createdAt)
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function workAgeDays(work: WorkStream, now: number) {
  return Math.max(0, now - workTimestamp(work)) / 86_400_000
}

function resultScore(result: CommandResult, match: number, now: number) {
  const relevance = match === 4 ? 50 : match * 3
  if (!result.work || isOpenWork(result.work)) return relevance
  if (result.work.status === 'canceled') return relevance + 14
  const age = workAgeDays(result.work, now)
  // Smooth decay: yesterday's completion can beat a weaker active title match;
  // old completions sink below similarly relevant unfinished work.
  return relevance + 2 + (10 * age) / (age + 7)
}

/** Completed work uses its completion date, so later edits do not revive old work. */
export function recentlyCompletedWork(streams: readonly WorkStream[], squadId: string, days: 7 | 30, now = Date.now()) {
  return streams
    .filter((work) => work.squadId === squadId && work.status === 'done' && workAgeDays(work, now) <= days)
    .sort((a, b) => workTimestamp(b) - workTimestamp(a))
}
