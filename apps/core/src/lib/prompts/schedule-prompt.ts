import { Schedule } from '../../entities/Schedule'
import type { ScheduleAction, Schedule as ScheduleType } from '@ficus/shared'

function formatScheduleConfig(schedule: ScheduleType['schedule']): string {
  if (schedule.interval) return `every ${schedule.interval}`
  if (schedule.cron) return `cron: ${schedule.cron}`
  if (schedule.runAt) return `at ${schedule.runAt}`
  return 'unknown'
}

function formatAction(action: ScheduleAction): string {
  switch (action.type) {
    case 'spawn_agent':
      return `spawn ${action.agentTypeId}${action.workStream ? ` → work stream: "${action.workStream.title}"` : ''}`
    case 'inbox_message':
      if (action.target.type === 'squad_manager') {
        return `message → squad manager${action.subject ? `: "${action.subject}"` : ''}`
      }
      return `message → ${action.target.agentId.slice(0, 8)}${action.subject ? `: "${action.subject}"` : ''}`
    case 'create_work_stream':
      return `create work stream: "${action.title}"`
  }
}

/**
 * Build a text summary of active schedules relevant to a specific agent.
 *
 * For managers: shows ALL enabled schedules for the squad.
 * For workers: shows only schedules that target this agent
 *   (inbox_message to them, or spawn_agent/create_work_stream assigned to them).
 */
export async function buildActiveSchedulesPrompt(
  squadId: string,
  agentId: string,
  role: 'manager' | 'worker'
): Promise<string> {
  const allSchedules = await Schedule.list({ scopeType: 'squad', scopeId: squadId })
  const enabled = allSchedules.filter((s) => s.enabled)

  if (enabled.length === 0) return ''

  let relevant: Schedule[]

  if (role === 'manager') {
    relevant = enabled
  } else {
    // Workers only see schedules that target them
    relevant = enabled.filter((s) => isRelevantToAgent(s, agentId))
  }

  if (relevant.length === 0) return ''

  const lines = relevant.map((s) => {
    const runs = s.triggerCount > 0 ? ` (${s.triggerCount} runs)` : ''
    const next = s.nextTriggerAt ? `, next: ${s.nextTriggerAt.toISOString()}` : ''
    return `- [${s.id.slice(0, 8)}] "${s.name}" — ${formatScheduleConfig(s.schedule)}, ${formatAction(s.action)}${runs}${next}`
  })

  const header = role === 'manager' ? '## Active Schedules' : '## Your Active Schedules'
  return `${header}\n${lines.join('\n')}`
}

function isRelevantToAgent(schedule: Schedule, agentId: string): boolean {
  const action = schedule.action

  switch (action.type) {
    case 'inbox_message':
      if (action.target.type === 'squad_manager') return false
      return action.target.agentId === agentId
    case 'create_work_stream':
      return action.assigneeAgentId === agentId
    case 'spawn_agent':
      // Spawn actions aren't relevant to existing workers
      return false
  }
}
