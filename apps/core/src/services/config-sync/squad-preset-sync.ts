import yaml from 'js-yaml'
import { squadPresets } from '../../db'
import { SQUAD_PRESETS_DIR } from '../../lib/paths'
import { SquadPreset } from '../../entities/SquadPreset'
import { ConfigSync } from './ConfigSync'
import { workflowSourceSchema, squadPresetWorkflowsSchema } from '@ficus/shared'
import type { WorkStreamCompletionMode } from '@ficus/shared'

export interface ScheduleTemplateYaml {
  name: string
  description?: string
  enabled?: boolean
  action: {
    type: 'inbox_message' | 'spawn_agent' | 'create_work_stream'
    target?: string
    subject?: string
    content?: string
    agentType?: string
    prompt?: string
    workStream?: { title: string; description?: string; completionMode?: WorkStreamCompletionMode }
    title?: string
    description?: string
    assignee?: string
    completionMode?: WorkStreamCompletionMode
    workflow?: import('@ficus/shared').WorkflowSource
  }
  schedule: {
    interval?: string
    cron?: string
    runAt?: string
  }
}

export interface SquadPresetYaml {
  workflows?: import('@ficus/shared').SquadPresetWorkflows | null
  id: string
  name: string
  description?: string
  purpose?: string
  defaultAgents?: string[]
  managerInstructions?: string
  scheduleTemplates?: ScheduleTemplateYaml[]
}

class YamlValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YamlValidationError'
  }
}

function validateRequired(obj: Record<string, unknown>, fields: string[], context: string): void {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      throw new YamlValidationError(`${context}: Missing required field '${field}'`)
    }
  }
}

export class SquadPresetSync extends ConfigSync<SquadPresetYaml> {
  readonly name = 'squad-presets'
  readonly directory = SQUAD_PRESETS_DIR
  readonly table = squadPresets
  readonly idColumn = squadPresets.id
  readonly yamlTemplateColumn = squadPresets.yamlTemplate
  readonly yamlFieldOverridesColumn = squadPresets.yamlFieldOverrides
  readonly updatedAtColumn = squadPresets.updatedAt
  readonly disabledColumn = squadPresets.disabled

  parse(content: string, _filename: string): SquadPresetYaml {
    const parsed = yaml.load(content) as Record<string, unknown>

    if (!parsed || typeof parsed !== 'object') {
      throw new YamlValidationError('SquadPreset: Invalid YAML content - expected an object')
    }

    validateRequired(parsed, ['id', 'name'], 'SquadPreset')

    const squadPreset: SquadPresetYaml = {
      id: parsed.id as string,
      name: parsed.name as string,
    }

    if (parsed.description !== undefined) {
      squadPreset.description = parsed.description as string
    }

    if (parsed.purpose !== undefined) {
      squadPreset.purpose = parsed.purpose as string
    }

    if (parsed.workflows !== undefined && parsed.workflows !== null) {
      squadPreset.workflows = squadPresetWorkflowsSchema.parse(parsed.workflows)
    }

    if (parsed.defaultAgents !== undefined) {
      if (!Array.isArray(parsed.defaultAgents)) {
        throw new YamlValidationError("SquadPreset: 'defaultAgents' must be an array")
      }
      for (let i = 0; i < parsed.defaultAgents.length; i++) {
        if (typeof parsed.defaultAgents[i] !== 'string') {
          throw new YamlValidationError(`SquadPreset: 'defaultAgents[${i}]' must be a string`)
        }
      }
      squadPreset.defaultAgents = parsed.defaultAgents as string[]
    }

    if (parsed.managerInstructions !== undefined) {
      if (typeof parsed.managerInstructions !== 'string') {
        throw new YamlValidationError("SquadPreset: 'managerInstructions' must be a string")
      }
      squadPreset.managerInstructions = parsed.managerInstructions
    }

    if (parsed.workerInstructions !== undefined) {
      throw new YamlValidationError(
        'SquadPreset: workerInstructions was removed; put worker behavior in agent expertise and workflows'
      )
    }

    if (parsed.scheduleTemplates !== undefined) {
      if (!Array.isArray(parsed.scheduleTemplates)) {
        throw new YamlValidationError("SquadPreset: 'scheduleTemplates' must be an array")
      }

      squadPreset.scheduleTemplates = parsed.scheduleTemplates.map((t: Record<string, unknown>, i: number) => {
        const ctx = `SquadPreset.scheduleTemplates[${i}]`

        if (!t.name || typeof t.name !== 'string') {
          throw new YamlValidationError(`${ctx}: 'name' is required and must be a string`)
        }
        if (!t.action || typeof t.action !== 'object') {
          throw new YamlValidationError(`${ctx}: 'action' is required and must be an object`)
        }
        if (!t.schedule || typeof t.schedule !== 'object') {
          throw new YamlValidationError(`${ctx}: 'schedule' is required and must be an object`)
        }

        const action = t.action as Record<string, unknown>
        const schedule = t.schedule as Record<string, unknown>

        const validActionTypes = ['inbox_message', 'spawn_agent', 'create_work_stream']
        if (!action.type || !validActionTypes.includes(action.type as string)) {
          throw new YamlValidationError(`${ctx}.action: 'type' must be one of: ${validActionTypes.join(', ')}`)
        }

        if (action.type === 'spawn_agent' && action.workStream !== undefined) {
          throw new YamlValidationError(
            `${ctx}.action: use create_work_stream with a workflow instead of spawn_agent.workStream`
          )
        }
        if (
          action.type === 'create_work_stream' &&
          ['agents', 'agentTypes', 'agentIds', 'assignee', 'assigneeAgentId', 'assigneeIndex', 'completionMode'].some(
            (key) => action[key] !== undefined
          )
        ) {
          throw new YamlValidationError(`${ctx}.action: use a workflow to define participants and delivery policy`)
        }

        if (!schedule.interval && !schedule.cron && !schedule.runAt) {
          throw new YamlValidationError(`${ctx}.schedule: must specify at least one of 'interval', 'cron', or 'runAt'`)
        }

        switch (action.type) {
          case 'inbox_message':
            if (!action.target || typeof action.target !== 'string') {
              throw new YamlValidationError(`${ctx}.action: 'target' is required for inbox_message`)
            }
            if (!action.content || typeof action.content !== 'string') {
              throw new YamlValidationError(`${ctx}.action: 'content' is required for inbox_message`)
            }
            break
          case 'spawn_agent':
            if (!action.agentType || typeof action.agentType !== 'string') {
              throw new YamlValidationError(`${ctx}.action: 'agentType' is required for spawn_agent`)
            }
            if (!action.prompt || typeof action.prompt !== 'string') {
              throw new YamlValidationError(`${ctx}.action: 'prompt' is required for spawn_agent`)
            }
            break
          case 'create_work_stream':
            if (action.workflow) workflowSourceSchema.parse(action.workflow)
            if (!action.title || typeof action.title !== 'string') {
              throw new YamlValidationError(`${ctx}.action: 'title' is required for create_work_stream`)
            }
            break
        }

        return t as unknown as ScheduleTemplateYaml
      })
    }

    return squadPreset
  }

  getId(parsed: SquadPresetYaml): string {
    return parsed.id
  }

  toRecord(parsed: SquadPresetYaml): Record<string, unknown> {
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? null,
      purpose: parsed.purpose ?? null,
      defaultAgents: parsed.defaultAgents ?? [],
      managerInstructions: parsed.managerInstructions ?? null,
      workflows: parsed.workflows ?? null,
      scheduleTemplates: parsed.scheduleTemplates ?? [],
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? null,
      purpose: (row.purpose as string) ?? null,
      defaultAgents: (row.defaultAgents as string[]) ?? [],
      managerInstructions: (row.managerInstructions as string) ?? null,
      workflows: row.workflows ?? null,
      scheduleTemplates: (row.scheduleTemplates as ScheduleTemplateYaml[]) ?? [],
    }
  }

  toYaml(row: Record<string, unknown>): string {
    const obj: Record<string, unknown> = {
      id: row.id,
      name: row.name,
    }
    if (row.description) obj.description = row.description
    if (row.purpose) obj.purpose = row.purpose
    if (row.workflows) obj.workflows = row.workflows
    const defaultAgents = row.defaultAgents as string[] | null
    if (defaultAgents?.length) obj.defaultAgents = defaultAgents
    if (row.managerInstructions) obj.managerInstructions = row.managerInstructions
    const scheduleTemplates = row.scheduleTemplates as unknown[] | null
    if (scheduleTemplates?.length) obj.scheduleTemplates = scheduleTemplates

    return yaml.dump(obj, { lineWidth: 120, noRefs: true })
  }

  async afterSync(_id: string): Promise<void> {
    // Preset changes only affect future squads. Existing squads own their settings.
    SquadPreset.invalidateCache()
  }
}
