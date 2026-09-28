import yaml from 'js-yaml'
import { workflowPresetSchema, type WorkflowPreset } from '@ficus/shared'
import { workflows } from '../../db'
import { WORKFLOWS_DIR } from '../../lib/paths'
import { ConfigSync } from './ConfigSync'

export class WorkflowSync extends ConfigSync<WorkflowPreset> {
  readonly name = 'workflows'
  readonly directory: string = WORKFLOWS_DIR
  readonly table = workflows
  readonly idColumn = workflows.id
  readonly yamlTemplateColumn = workflows.yamlTemplate
  readonly yamlFieldOverridesColumn = workflows.yamlFieldOverrides
  readonly updatedAtColumn = workflows.updatedAt
  readonly disabledColumn = workflows.disabled

  parse(content: string): WorkflowPreset {
    return workflowPresetSchema.parse(yaml.load(content))
  }

  getId(value: WorkflowPreset): string {
    return value.id
  }

  toRecord(value: WorkflowPreset): Record<string, unknown> {
    return {
      id: value.id,
      description: value.description ?? null,
      scope: value.scope ?? { kind: 'instance' },
      definition: value.definition,
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      description: row.description ?? null,
      scope: row.scope ?? { kind: 'instance' },
      definition: row.definition,
    }
  }

  toYaml(row: Record<string, unknown>): string {
    const value = workflowPresetSchema.parse({
      id: row.id,
      description: row.description ?? undefined,
      definition: row.definition,
      ...(row.scope && (row.scope as { kind: string }).kind !== 'instance' ? { scope: row.scope } : {}),
    })
    return yaml.dump(value, { lineWidth: 120, noRefs: true })
  }
}
