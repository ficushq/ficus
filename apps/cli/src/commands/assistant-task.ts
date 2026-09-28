/**
 * `ficus assistant-task` — the delegated agent's direct handle on a task that a saved Assistant
 * conversation gave it. `status` reports lifecycle for a specific request generation; the server turns
 * it into the same inbox reply that `ficus inbox send --assistant-task-status` would produce.
 */

import { Command, Option } from 'commander'
import type { AssistantTaskSummary } from '@ficus/shared'
import { apiGet, apiPost } from '../client'
import { output, outputError } from '../output'

export const ASSISTANT_TASK_STATUSES = ['working', 'waiting', 'needs-input', 'completed', 'failed', 'cancelled']

export function renderAssistantTask(task: AssistantTaskSummary): string {
  return [
    `Task ${task.id}`,
    `  label:    ${task.label}`,
    `  status:   ${task.status}${task.unavailable ? ' (agent unavailable)' : ''}`,
    `  request:  ${task.currentRequestId}`,
    `  kind:     ${task.kind}${task.squadId ? ` (squad ${task.squadId})` : ''}`,
    `  updated:  ${task.updatedAt}`,
  ].join('\n')
}

export function registerAssistantTaskCommands(program: Command): void {
  const task = program.command('assistant-task').description('Tasks delegated to you by a saved Assistant conversation')

  task
    .command('get <taskId>')
    .description('Show a task you own: its label, tracked status, and current request ID')
    .action(async (taskId: string) => {
      try {
        const summary = await apiGet<AssistantTaskSummary>(`/api/assistant-tasks/${encodeURIComponent(taskId)}`)
        output(summary, renderAssistantTask(summary))
      } catch (error) {
        outputError(error as Error)
      }
    })

  task
    .command('status <taskId>')
    .description('Report the tracked status of a task you own; delivered to the Assistant as an update')
    .addOption(new Option('-s, --status <status>', 'New status').choices(ASSISTANT_TASK_STATUSES).makeOptionMandatory())
    .option('--request-id <requestId>', 'Request UUID being reported (required after a task continuation)')
    .option('-m, --message <text>', 'Update text shown to the user (defaults to a short status line)')
    .action(async (taskId: string, options: { status: string; message?: string; requestId?: string }) => {
      try {
        const result = await apiPost<{ task: AssistantTaskSummary; messageId: string }>(
          `/api/assistant-tasks/${encodeURIComponent(taskId)}/status`,
          {
            status: options.status,
            ...(options.requestId ? { requestId: options.requestId } : {}),
            ...(options.message ? { message: options.message } : {}),
          }
        )
        output(result, `${renderAssistantTask(result.task)}\n  update:   ${result.messageId}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
