import { createLogger } from '../../lib/infra/logger'

const log = createLogger('schedule-provision')
import { Schedule } from '../../entities/Schedule'
import { Squad } from '../../entities/Squad'
import type { ScheduleTemplateYaml } from '../config-sync'
import type { ScheduleAction } from '@ficus/shared'

/** Copy creation-time schedule templates into independently owned squad schedules. */
export async function provisionSquadSchedules(squadId: string, templates: ScheduleTemplateYaml[]): Promise<number> {
  if (!templates.length) return 0

  const existingSchedules = await Schedule.list({ scopeType: 'squad', scopeId: squadId })
  const existingNames = new Set(existingSchedules.map((s) => s.name))

  let created = 0
  for (const template of templates) {
    // Skip if schedule with this name already exists
    if (existingNames.has(template.name)) {
      // log.info(`Skipping "${template.name}" — already exists in squad ${squadId.slice(0, 8)}`)
      continue
    }

    // Resolve target tokens to concrete action
    const action = await resolveTemplateAction(squadId, template)
    if (!action) {
      log.warn(`Could not resolve action for "${template.name}" in squad ${squadId.slice(0, 8)}`)
      continue
    }

    await Schedule.create({
      scopeType: 'squad',
      scopeId: squadId,
      name: template.name,
      enabled: template.enabled ?? true,
      schedule: template.schedule,
      action,
    })

    log.info(`Created schedule "${template.name}" in squad ${squadId.slice(0, 8)}`)
    created++
  }

  return created
}

/**
 * Resolve template action tokens (manager, agent types) to concrete actions.
 * For inbox_message with target: manager, we use the squad_manager target type.
 */
async function resolveTemplateAction(squadId: string, template: ScheduleTemplateYaml): Promise<ScheduleAction | null> {
  const action = template.action

  // Interpolate squadId in content/prompt
  const interpolate = (s: string | undefined) => s?.replaceAll('{{squad.id}}', squadId)

  switch (action.type) {
    case 'inbox_message': {
      const target = action.target!

      // Handle special target tokens
      if (target === 'manager') {
        // Use squad_manager target type - resolved at trigger time
        return {
          type: 'inbox_message',
          target: { type: 'squad_manager' },
          subject: action.subject,
          content: interpolate(action.content)!,
        }
      }

      if (target === 'all') {
        // Broadcast not yet supported for inbox_message
        log.warn(`"all" target not yet supported for inbox_message`)
        return null
      }

      // Try to resolve as agent type ID
      const squad = await Squad.find(squadId)
      const agents = squad ? await squad.getActiveAgents() : []
      const agentOfType = agents.find((a) => a.agentTypeId === target)
      if (agentOfType) {
        return {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agentOfType.id },
          subject: action.subject,
          content: interpolate(action.content)!,
        }
      }

      // Assume it's a literal agent ID
      return {
        type: 'inbox_message',
        target: { type: 'agent', agentId: target },
        subject: action.subject,
        content: interpolate(action.content)!,
      }
    }

    case 'spawn_agent': {
      if (action.workStream) throw new Error('Use create_work_stream with a workflow instead of spawn_agent.workStream')
      return {
        type: 'spawn_agent',
        agentTypeId: action.agentType!,
        prompt: interpolate(action.prompt)!,
      }
    }

    case 'create_work_stream': {
      if (action.assignee !== undefined || action.completionMode !== undefined)
        throw new Error('Use a workflow to define scheduled participants and delivery policy')

      return {
        type: 'create_work_stream',
        title: interpolate(action.title)!,
        description: interpolate(action.description),
        ...(action.workflow ? { workflow: action.workflow } : {}),
      }
    }
  }
}
