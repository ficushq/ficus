import type { AssistantConversationActivity } from '@ficus/shared'

/** Short task-state summary for a conversation row; empty when nothing is in progress. */
export function summarizeAssistantTasks(
  counts: Pick<AssistantConversationActivity, 'workingTasks' | 'waitingTasks' | 'needsInputTasks' | 'unavailableTasks'>
): string {
  const parts: string[] = []
  if (counts.needsInputTasks > 0)
    parts.push(
      counts.needsInputTasks === 1 ? '1 task needs your input' : `${counts.needsInputTasks} tasks need your input`
    )
  if (counts.workingTasks > 0) parts.push(`${counts.workingTasks} working`)
  if (counts.waitingTasks > 0) parts.push(`${counts.waitingTasks} waiting`)
  if (counts.unavailableTasks > 0) parts.push(`${counts.unavailableTasks} unavailable`)
  return parts.join(' · ')
}

export { ASSISTANT_TASK_STATUS_LABELS } from '@ficus/shared'

/** Compact timestamp: time of day today, otherwise a short date. */
export function formatAssistantUpdateTime(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
