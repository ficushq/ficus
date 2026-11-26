import {
  WORK_STREAM_STATUS_ROLE,
  type AgentQuestionActionData,
  type PendingAction,
  type SquadQuestionActionData,
  type WorkStreamActionData,
} from '@ficus/shared'
import { workStreamActionPresentationState } from './workStreamStatusPresentation'
import { workflowReviewPath } from './workflowReview'

/**
 * The in-app "Needs you" notice: a small card at the top right that appears, on any page, when an
 * item starts needing the signed-in user while the app is open. These are the rules; the component
 * (`components/NeedsYouNotifications.tsx`) only renders and times them.
 */

/** How many cards show at once: the newest ones. */
export const MAX_NEEDS_YOU_NOTICES = 3
/** Each card dismisses itself after this long, paused while hovered or focused. */
export const NEEDS_YOU_NOTICE_TIMEOUT_MS = 8000

/** The notification preference category a notice belongs to (the push category ids). */
export type NeedsYouNoticeCategory = 'question' | 'review'

/**
 * Which new Needs-you items announce themselves, and under which preference category. Only an
 * agent question the user can answer, or a review, approval or input gate the user can decide,
 * and only where it alerts the user (`alerts`: a direct recipient, or Decisions at Notify for its
 * squad or work stream). At Show an item is listed in Needs you without interrupting, so no card.
 * Halted agents, Assistant task updates, code-host delivery gates (decided outside Ficus), and an
 * answered question whose delivery failed are not new asks, so they never raise a card.
 */
export function needsYouNoticeCategory(action: PendingAction): NeedsYouNoticeCategory | null {
  if (!action.canRespond || action.alerts !== true) return null
  switch (action.type) {
    case 'agent-question':
      return (action.data as AgentQuestionActionData).answerDelivery ? null : 'question'
    case 'squad-question':
      return 'question'
    case 'workstream-review':
    case 'workstream-blocked':
      return 'review'
    default:
      return null
  }
}

/** The subset of the user's notification preferences (`GET /notification-config/me`) a notice follows. */
export interface NeedsYouNoticePreferences {
  pushEnabled: boolean
  mutedEvents: string[]
}

/** Legacy event ids that mute the same notices as their category. */
const CATEGORY_EVENTS: Record<NeedsYouNoticeCategory, readonly string[]> = {
  question: ['agent-question.created'],
  review: ['workStream.review', 'workStream.blocked'],
}

/**
 * A notice follows the same preferences as push: nothing while push is off or the category is
 * muted, and nothing until the preferences have loaded.
 */
export function needsYouNoticesAllowed(
  preferences: NeedsYouNoticePreferences | undefined,
  category: NeedsYouNoticeCategory
): boolean {
  if (!preferences?.pushEnabled) return false
  if (preferences.mutedEvents.includes(category)) return false
  return !CATEGORY_EVENTS[category].some((event) => preferences.mutedEvents.includes(event))
}

export interface NeedsYouNoticeContent {
  /** Who is asking: the agent's name, else its role. */
  who: string
  /** One line: "<who> has a question", "<who> requests review" or "<who> needs your input". */
  headline: string
  /** The question or the input request, when there is one. */
  detail: string | null
  /** "#8 · Make every payment retry safe", or the squad when the item has no work stream. */
  context: string | null
}

function questionText(questions: { question: string }[]): string | null {
  const text = questions
    .map((item) => item.question.trim())
    .filter(Boolean)
    .join(' ')
  return text || null
}

function workStreamLabel(work: { number?: number | null; title: string }): string {
  return work.number ? `#${work.number} · ${work.title}` : work.title
}

export function needsYouNoticeContent(action: PendingAction): NeedsYouNoticeContent {
  switch (action.type) {
    case 'agent-question': {
      const data = action.data as AgentQuestionActionData
      const who = data.agentName || data.agentTypeId
      return {
        who,
        headline: `${who} has a question`,
        detail: questionText(data.questionData.questions),
        context: data.workStream ? workStreamLabel(data.workStream) : data.squadName,
      }
    }
    case 'squad-question': {
      const data = action.data as SquadQuestionActionData
      const who = data.agentName || data.agentTypeId
      return {
        who,
        headline: `${who} has a question`,
        detail: questionText(data.questionData.questions),
        context: data.squadName,
      }
    }
    default: {
      const data = action.data as WorkStreamActionData
      const who = data.assigneeName || 'An agent'
      const state = workStreamActionPresentationState(action)
      const review = state !== null && WORK_STREAM_STATUS_ROLE[state] === 'review'
      return {
        who,
        headline: review ? `${who} requests review` : `${who} needs your input`,
        detail: review ? null : data.wait.message?.trim() || null,
        context: workStreamLabel({ number: data.workStreamNumber, title: data.workStreamTitle }),
      }
    }
  }
}

/**
 * A flow-owned gate opens its review surface, the same as the Review button on its Needs-you row.
 * An attempt-limit pause is decided in the row's body, so it is not one.
 */
function isWorkflowReviewGate(action: PendingAction): action is PendingAction & { data: WorkStreamActionData } {
  if (action.type !== 'workstream-blocked') return false
  const data = action.data as WorkStreamActionData
  return data.wait.resolutionHandler === 'workflow' && !data.attemptLimit
}

interface Place {
  pathname: string
  search: string
}

/**
 * Where clicking the notice goes: a workflow gate's review over the current page (what Review does
 * in Needs you), otherwise the item itself in the Action Center, focused and expanded with its
 * answer or decision controls (the same exact target a push notification for it opens).
 */
export function needsYouNoticeDestination(action: PendingAction, here: Place): string {
  if (isWorkflowReviewGate(action)) {
    const review = new URLSearchParams(workflowReviewPath(action.data.workStreamId, action.data.focus.waitId).slice(2))
    const params = new URLSearchParams(here.search)
    for (const [key, value] of review) params.set(key, value)
    return `${here.pathname}?${params}`
  }
  return `/actions/${encodeURIComponent(action.id)}`
}

function workStreamRefs(action: PendingAction): string[] {
  if (action.type === 'workstream-review' || action.type === 'workstream-blocked') {
    const data = action.data as WorkStreamActionData
    return [data.workStreamId, ...(data.workStreamNumber ? [String(data.workStreamNumber)] : [])]
  }
  if (action.type === 'agent-question') {
    const work = (action.data as AgentQuestionActionData).workStream
    return work ? [work.id, String(work.number)] : []
  }
  return []
}

/**
 * True when the user already has this item open, so a notice would only repeat what is on screen:
 * the item in the Action Center, the review or detail of its work stream, or, for a question, the
 * asking agent's conversation (where the question shows above the composer).
 */
export function isNeedsYouItemOpen(action: PendingAction, here: Place): boolean {
  let actionPath: string
  try {
    actionPath = decodeURIComponent(here.pathname)
  } catch {
    actionPath = here.pathname
  }
  if (actionPath === `/actions/${action.id}`) return true

  const params = new URLSearchParams(here.search)
  const refs = workStreamRefs(action)
  if (refs.length && ['review', 'ws'].some((key) => refs.includes(params.get(key) ?? ''))) return true

  // A squad agent's conversation (`agentChatPath`): its squad's Agents tab with `?agent=<id>`. The
  // squad segment may be its id or its slug, so only the tab and the agent are compared.
  if (action.type === 'agent-question' || action.type === 'squad-question') {
    const data = action.data as AgentQuestionActionData | SquadQuestionActionData
    return /^\/squads\/[^/]+\/agents\/?$/.test(here.pathname) && params.get('agent') === data.agentId
  }
  return false
}

/**
 * Merge newly announced items into the cards on screen: newest first, at most three. Older cards
 * beyond that are dropped, not queued.
 */
export function mergeNeedsYouNotices(current: PendingAction[], incoming: PendingAction[]): PendingAction[] {
  const byId = new Map(current.map((action) => [action.id, action]))
  for (const action of incoming) byId.set(action.id, action)
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_NEEDS_YOU_NOTICES)
}
