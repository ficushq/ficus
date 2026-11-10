import * as yaml from 'js-yaml'
import { workflowPresetSchema, type WorkflowDefinition, type WorkflowPreset } from '@ficus/shared'
import { workflows } from '../../db'
import { WORKFLOWS_DIR } from '../../lib/paths'
import { ConfigSync, type ReconciledUpdate } from './ConfigSync'
import { describeSquadBreaks, findBrokenSquadCustomizations } from '../workflows/squad-impact'
import { nextTemplateHold, planWorkflowTemplateUpdate, type WorkflowTemplateHold } from '../workflows/template-hold'

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
   * and stay visible through the template diff. The definition update is held back, and the
   * current definition kept, when the merged preset is not a valid workflow or would break a
   * squad's saved customization of this preset. A held-back update keeps its merge base in
   * `yamlTemplateHold`, so every later sync retries it and it applies once nothing blocks it.
   */
  protected override async reconcileUpdate(
    id: string,
    record: Record<string, unknown>,
    existing: Record<string, unknown>,
    current: Record<string, unknown>,
    fieldOverrides: string[]
  ): Promise<ReconciledUpdate> {
    const hold = (existing.yamlTemplateHold as WorkflowTemplateHold | null | undefined) ?? null
    const base = hold?.base ?? this.storedTemplate(existing)
    if (!base) return { data: await this.applyWithoutBase(id, record, current, fieldOverrides) }
    const plan = await planWorkflowTemplateUpdate(id, base, current as { definition: WorkflowDefinition }, record)
    if (plan.conflicts.length)
      this.log.warn(
        `Workflow '${id}' keeps local edits where the code template also changed: ${plan.conflicts.join(', ')}`
      )
    if (plan.blocked?.reason === 'invalid-workflow')
      this.log.warn(
        `Holding back the code update to workflow '${id}': merging it with local edits gives an invalid workflow, ` +
          `so its local definition is kept. ${plan.blocked.detail}`
      )
    else if (plan.blocked)
      this.log.warn(
        `Holding back the code update to workflow '${id}': it would break saved squad customizations of ` +
          `${describeSquadBreaks({ affectedSquads: plan.blocked.breaks, hiddenSquadCount: 0 })}. ` +
          'It applies on a later sync once those squads are updated, or restore the preset from the template diff.'
      )
    else if (hold) this.log.info(`Applied the held-back code update to workflow '${id}'`)
    return {
      data: { ...record, description: plan.description, definition: plan.definition },
      tracking: { yamlTemplateHold: nextTemplateHold(plan, hold, base, record) },
    }
  }

  /**
   * A row with no stored template has no merge base: overridden fields keep their values, and a
   * definition update that breaks a squad is held back without a stored hold.
   */
  private async applyWithoutBase(
    id: string,
    record: Record<string, unknown>,
    current: Record<string, unknown>,
    fieldOverrides: string[]
  ): Promise<Record<string, unknown>> {
    const next = this.applyOverrideKeys(record, current, fieldOverrides)
    const before = current.definition as WorkflowDefinition
    const after = next.definition as WorkflowDefinition
    if (this.deepEqual(before, after)) return next
    const breaks = await findBrokenSquadCustomizations(id, before, after)
    if (!breaks.length) return next
    this.log.warn(
      `Holding back the code update to workflow '${id}': it would break saved squad customizations of ` +
        `${describeSquadBreaks({ affectedSquads: breaks, hiddenSquadCount: 0 })}.`
    )
    return { ...next, definition: current.definition }
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
