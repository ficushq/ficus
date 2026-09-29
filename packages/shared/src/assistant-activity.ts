import { z } from 'zod'
import type { AssistantMessageTargetKind } from './assistant'

/**
 * Lifecycle of one delegated Assistant request. A task is a tracking record around an inbox
 * request chain, not a work stream or an execution.
 */
export const assistantTaskStatusSchema = z.enum([
  'working',
  'waiting',
  'needs-input',
  'completed',
  'failed',
  'cancelled',
  'unknown',
])
export type AssistantTaskStatus = z.infer<typeof assistantTaskStatusSchema>

/** Statuses an agent may report. `unknown` only normalizes historical data. */
export const reportableAssistantTaskStatusSchema = z.enum([
  'working',
  'waiting',
  'needs-input',
  'completed',
  'failed',
  'cancelled',
])
export type ReportableAssistantTaskStatus = z.infer<typeof reportableAssistantTaskStatusSchema>

/** How each task status reads to a person (web and farm alike). */
export const ASSISTANT_TASK_STATUS_LABELS: Record<AssistantTaskStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  'needs-input': 'Needs your input',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Earlier task',
}

export function isTerminalAssistantTaskStatus(status: AssistantTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * Apply one update's reported status. Updates never reopen a finished request, never change a
 * task through an older request, and never change anything without an explicit status. A new
 * user follow-up resets status explicitly instead of using this transition.
 */
export function applyAssistantTaskStatus(
  current: AssistantTaskStatus,
  reported: AssistantTaskStatus | undefined,
  isCurrentRequest: boolean
): AssistantTaskStatus {
  if (!isCurrentRequest || reported === undefined) return current
  if (isTerminalAssistantTaskStatus(current)) return current
  return reported
}

export interface AssistantTaskSummary {
  id: string
  currentRequestId: string
  agentId: string | null
  kind: AssistantMessageTargetKind
  squadId: string | null
  label: string
  status: AssistantTaskStatus
  /** The task is unfinished but its agent is missing or terminated. Derived, never stored. */
  unavailable: boolean
  createdAt: string
  updatedAt: string
}

export interface AssistantActivityUpdate {
  messageId: string
  taskId: string | null
  requestId: string | null
  sequence: number
  reportedStatus: AssistantTaskStatus | null
  content: string
  subject: string | null
  senderName: string
  processedAt: string | null
  seenAt: string | null
  createdAt: string
}

export interface AssistantActivityCounts {
  unreadConversations: number
  unreadUpdates: number
  workingTasks: number
  waitingTasks: number
  needsInputTasks: number
  unavailableTasks: number
}

export interface AssistantConversationActivity {
  id: string
  title: string
  updatedAt: string
  latestUpdateSequence: number
  unreadUpdates: number
  workingTasks: number
  waitingTasks: number
  needsInputTasks: number
  unavailableTasks: number
  latestUpdate: {
    messageId: string
    preview: string
    createdAt: string
  } | null
}

export interface AssistantActivityPage {
  totals: AssistantActivityCounts
  conversations: AssistantConversationActivity[]
  hasMore: boolean
}

export interface AssistantConversationActivityDetail {
  conversation: AssistantConversationActivity
  tasks: AssistantTaskSummary[]
  updates: AssistantActivityUpdate[]
  /** Latest current-request question per waiting task, independent of read state and update pagination. */
  pendingInputs?: AssistantActivityUpdate[]
  hasMore: boolean
  beforeSequence: number | null
}

/** Canonical web path of a saved Assistant conversation; the navigation reader recognizes it. */
export function assistantConversationPath(id: string): string {
  const params = new URLSearchParams({
    chat: 'open',
    assistantConversation: z.string().uuid().parse(id),
  })
  return `/?${params}`
}
