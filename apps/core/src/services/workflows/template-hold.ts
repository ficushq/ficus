/**
 * Code updates to a shared workflow preset that are held back, and how they apply later.
 *
 * Sync merges a code update into a preset against the template the preset was last reconciled
 * with (see template-merge.ts). When the merged definition would break a squad's saved
 * customization, or is not a valid workflow, the definition update is held back and the preset
 * keeps its current definition. The preset's `yamlTemplate` still moves to the new template (so
 * the template diff and restore use the code version), but `yamlTemplateHold.base` keeps the old
 * definition as the merge base. Every later sync retries the update from that base, so the held
 * parts are not mistaken for local edits: once no squad depends on the old IDs the update applies
 * through the normal merge, and a later code change to a held part replaces it instead of
 * conflicting with it.
 */
import type { WorkflowDefinition } from '@ficus/shared'
import { db, type DbTx, type workflows } from '../../db'
import {
  copyTemplatePaths,
  describeTemplatePath,
  diffWorkflowTemplate,
  mergeWorkflowTemplate,
  parseMergedPreset,
  sameTemplateValue,
  type TemplateFields,
} from './template-merge'
import { findBrokenSquadCustomizations, visibleSquadBreaks, type SquadCustomizationBreak } from './squad-impact'

/** Stored in `workflows.yaml_template_hold` while a definition update is held back. */
export interface WorkflowTemplateHold {
  /** The merge base for the next sync: the new template's description and the old definition. */
  base: TemplateFields
  /** When the update was first held back (ISO time); kept while it stays held. */
  heldAt: string
}

export type TemplateUpdateBlock =
  { reason: 'squad-customizations'; breaks: SquadCustomizationBreak[] } | { reason: 'invalid-workflow'; detail: string }

export interface TemplateUpdatePlan {
  /** The description and definition to store. */
  description: string | null
  definition: WorkflowDefinition
  /** Parts changed both locally and in code; the local value was kept. */
  conflicts: string[]
  /** The merged fields, before validation. When blocked, the definition here is what is held back. */
  merged: TemplateFields
  /** Why the definition update is held back, or null when it applies. */
  blocked: TemplateUpdateBlock | null
}

type Store = DbTx | typeof db

/**
 * Merge `template` into `current` from `base` and decide whether the definition update applies.
 * It is held back when the merged preset is invalid or when it would break a saved squad
 * customization of this preset; the description still applies in both cases.
 */
export async function planWorkflowTemplateUpdate(
  id: string,
  base: TemplateFields,
  current: { description?: unknown; definition: WorkflowDefinition },
  template: TemplateFields,
  store: Store = db
): Promise<TemplateUpdatePlan> {
  const { merged, conflicts } = mergeWorkflowTemplate(base, current, template)
  let value: ReturnType<typeof parseMergedPreset>
  try {
    value = parseMergedPreset(id, merged)
  } catch (error) {
    return {
      description: typeof merged.description === 'string' ? merged.description : null,
      definition: current.definition,
      conflicts,
      merged,
      blocked: { reason: 'invalid-workflow', detail: error instanceof Error ? error.message : String(error) },
    }
  }
  const description = value.description ?? null
  if (!sameTemplateValue(current.definition, value.definition)) {
    const breaks = await findBrokenSquadCustomizations(id, current.definition, value.definition, store)
    if (breaks.length)
      return {
        description,
        definition: current.definition,
        conflicts,
        merged,
        blocked: { reason: 'squad-customizations', breaks },
      }
  }
  return { description, definition: value.definition, conflicts, merged, blocked: null }
}

/**
 * The hold to store after a sync: none when the update applied, otherwise a merge base that keeps
 * the held definition and takes the template's description (which did apply).
 */
export function nextTemplateHold(
  plan: Pick<TemplateUpdatePlan, 'blocked'>,
  previous: WorkflowTemplateHold | null,
  base: TemplateFields,
  template: TemplateFields,
  now: Date = new Date()
): WorkflowTemplateHold | null {
  if (!plan.blocked) return null
  return {
    base: { description: template.description, definition: base.definition },
    heldAt: previous?.heldAt ?? now.toISOString(),
  }
}

/**
 * The hold after a person restores parts of the preset to its code template: restored parts now
 * follow the template, so the merge base takes them too. No hold remains after a full restore or
 * once the base definition matches the template.
 */
export function holdAfterRestore(
  hold: WorkflowTemplateHold | null,
  template: TemplateFields,
  paths: readonly string[] | undefined
): WorkflowTemplateHold | null {
  if (!hold || !paths) return null
  const base = copyTemplatePaths(hold.base, template, paths)
  if (sameTemplateValue(base.definition, template.definition)) return null
  return { ...hold, base: { description: template.description, definition: base.definition } }
}

/** The held-back state shown in the template diff. Squads are named only to callers who can read them. */
export interface WorkflowTemplateHoldView {
  heldAt: string
  /**
   * What holds the update back now: `squad-customizations`, `invalid-workflow`, or null when
   * nothing does any more and it applies on the next sync.
   */
  blockedBy: TemplateUpdateBlock['reason'] | null
  /** The validation error, when the merged preset is not a valid workflow. */
  invalidReason?: string
  affectedSquads: SquadCustomizationBreak[]
  hiddenSquadCount: number
  /** The parts of the definition the held-back update would change. */
  parts: Array<{ path: string; label: string }>
}

/** Recheck a held-back update against the squads as they are now. Null when nothing is held back. */
export async function describeWorkflowTemplateHold(
  row: Pick<typeof workflows.$inferSelect, 'id' | 'description' | 'definition' | 'yamlTemplate' | 'yamlTemplateHold'>,
  canSeeSquad: (squadId: string) => boolean,
  store: Store = db
): Promise<WorkflowTemplateHoldView | null> {
  const hold = row.yamlTemplateHold
  if (!hold || !row.yamlTemplate) return null
  const plan = await planWorkflowTemplateUpdate(
    row.id,
    hold.base,
    row,
    row.yamlTemplate as Record<string, unknown>,
    store
  )
  const breaks = plan.blocked?.reason === 'squad-customizations' ? plan.blocked.breaks : []
  return {
    heldAt: hold.heldAt,
    blockedBy: plan.blocked?.reason ?? null,
    ...(plan.blocked?.reason === 'invalid-workflow' ? { invalidReason: plan.blocked.detail } : {}),
    ...visibleSquadBreaks(breaks, canSeeSquad),
    parts: diffWorkflowTemplate({ definition: row.definition }, { definition: plan.merged.definition }).map(
      ({ path }) => ({ path, label: describeTemplatePath(path) })
    ),
  }
}
