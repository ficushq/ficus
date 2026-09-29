import type { PendingAction } from '@ficus/shared'
import { typedAction } from './match'

/** Headline for an action (the web ActionItem's title rules). */
export function actionTitle(action: PendingAction): string {
  const typed = typedAction(action)
  switch (typed.type) {
    case 'workstream-review':
    case 'workstream-blocked':
      return typed.data.workStreamTitle
    case 'assistant-needs-input':
      return typed.data.taskLabel
    case 'agent-question':
    case 'agent-error':
      return typed.data.agentName || typed.data.agentTypeId
    case 'squad-question':
      return action.squadName ?? typed.data.squadName
    case 'unknown':
      return action.squadName ?? 'Something needs you'
  }
}

/** One plain line saying who needs what (the web ActionItem's subtitle rules). */
export function actionSubtitle(action: PendingAction): string {
  const typed = typedAction(action)
  const squadPrefix = (name: string | null | undefined) => (name ? `${name} · ` : '')
  switch (typed.type) {
    case 'squad-question':
      return `${typed.data.agentName || typed.data.agentTypeId} · needs your input`
    case 'agent-question':
      return `${squadPrefix(typed.data.squadName)}${
        typed.data.answerDelivery?.status === 'failed' ? 'Answer delivery failed' : 'Needs your answer'
      }`
    case 'agent-error':
      return `${squadPrefix(typed.data.squadName)}Robot halted`
    case 'assistant-needs-input':
      return `Assistant task${typed.data.squadName ? ` · ${typed.data.squadName}` : ''} · needs your answer`
    case 'workstream-review': {
      const assignee = typed.data.assigneeName || typed.data.assigneeAgentId?.slice(0, 8)
      return `${typed.data.squadName}${assignee ? ` · ${assignee} requests review` : ' · ready for review'}`
    }
    case 'workstream-blocked': {
      const { wait, squadName } = typed.data
      const assignee = typed.data.assigneeName || typed.data.assigneeAgentId?.slice(0, 8)
      if (wait.resolutionHandler === 'workflow')
        return `${squadName} · ${wait.flowAttemptId != null ? 'review needed' : 'workflow decision'}`
      return `${squadName}${assignee ? ` · ${assignee} needs input` : ' · needs input'}`
    }
    case 'unknown':
      return action.type
  }
}

export type MailboxGroupId = 'halted' | 'questions' | 'assistant' | 'harvest' | 'weeds' | 'other'

export interface MailboxGroup {
  id: MailboxGroupId
  title: string
  /** Plain meaning of the farm name. */
  subtitle: string
  actions: PendingAction[]
}

const GROUPS: Array<Omit<MailboxGroup, 'actions'>> = [
  { id: 'halted', title: 'Halted robots', subtitle: 'Stopped by a provider error' },
  { id: 'questions', title: 'Questions', subtitle: 'Robots waiting on your answer' },
  { id: 'assistant', title: 'Assistant', subtitle: 'Delegated tasks waiting on you' },
  { id: 'harvest', title: 'Ready to harvest', subtitle: 'Work stream reviews' },
  { id: 'weeds', title: 'Weeds', subtitle: 'Blocked work streams needing input' },
  { id: 'other', title: 'Other', subtitle: 'Open these in Ficus' },
]

export function groupOf(action: PendingAction): MailboxGroupId {
  switch (action.type) {
    case 'agent-error':
      return 'halted'
    case 'agent-question':
    case 'squad-question':
      return 'questions'
    case 'assistant-needs-input':
      return 'assistant'
    case 'workstream-review':
      return 'harvest'
    case 'workstream-blocked':
      return 'weeds'
    default:
      return 'other'
  }
}

/**
 * Mailbox sections in the web Action Center's order (halted robots first, then
 * questions, reviews, blocked), newest first within each, matching the
 * server's priority-then-newest sort. Empty sections are dropped.
 */
export function groupActions(actions: PendingAction[]): MailboxGroup[] {
  const newestFirst = [...actions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return GROUPS.map((group) => ({
    ...group,
    actions: newestFirst.filter((action) => groupOf(action) === group.id),
  })).filter((group) => group.actions.length > 0)
}
