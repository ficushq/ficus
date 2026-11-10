import * as yaml from 'js-yaml'
import { workflowPresetSchema, type WorkflowDefinition, type WorkflowPreset } from '@ficus/shared'
import { workflows } from '../../db'
import { WORKFLOWS_DIR } from '../../lib/paths'
import { ConfigSync } from './ConfigSync'
import { mergeWorkflowTemplate, parseMergedPreset } from '../workflows/template-merge'
import { describeSquadBreaks, findBrokenSquadCustomizations } from '../workflows/squad-impact'

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

  /**
   * Merge a code update into a preset field by field instead of keeping the whole edited
   * definition. Local edits win where both sides changed the same part; those parts are logged
   * and stay visible through the template diff. The merged definition is not applied, and the
   * current one is kept, when it is not a valid workflow or when it would break a squad's saved
   * customization of this preset; a person can then review the drift and restore the template.
   */
  protected override async reconcileUpdate(
    id: string,
    record: Record<string, unknown>,
    existing: Record<string, unknown>,
    current: Record<string, unknown>,
    fieldOverrides: string[]
  ): Promise<Record<string, unknown>> {
    const base = this.storedTemplate(existing)
    let next = base ? this.merge(id, base, current, record) : this.applyOverrideKeys(record, current, fieldOverrides)
    const before = current.definition as WorkflowDefinition
    const after = next.definition as WorkflowDefinition
    if (!this.deepEqual(before, after)) {
      const breaks = await findBrokenSquadCustomizations(id, before, after)
      if (breaks.length) {
        this.log.warn(
          `Holding back the code update to workflow '${id}': it would break saved squad customizations of ` +
            `${describeSquadBreaks({ affectedSquads: breaks, hiddenSquadCount: 0 })}. ` +
            'Review the template diff and restore the preset once the squads are updated.'
        )
        next = { ...next, definition: current.definition }
      }
    }
    return next
  }

  private merge(
    id: string,
    base: Record<string, unknown>,
    current: Record<string, unknown>,
    record: Record<string, unknown>
  ): Record<string, unknown> {
    const { merged, conflicts } = mergeWorkflowTemplate(base, current, record)
    try {
      const value = parseMergedPreset(id, merged)
      if (conflicts.length)
        this.log.warn(
          `Workflow '${id}' keeps local edits where the code template also changed: ${conflicts.join(', ')}`
        )
      return { ...record, description: value.description ?? null, definition: value.definition }
    } catch (error) {
      this.log.warn(
        `Workflow '${id}': merging the code update with local edits gives an invalid workflow, so its local ` +
          `definition is kept unchanged. ${error instanceof Error ? error.message : String(error)}`
      )
      return { ...record, description: merged.description ?? null, definition: current.definition }
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
