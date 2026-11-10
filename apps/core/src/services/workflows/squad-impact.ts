/**
 * Which squads would stop being able to create work streams if a preset's definition changed.
 *
 * Squads customize presets by step and participant ID (update-step, remove-step, set-outcome and
 * so on) in their saved default workflow, their recorded workflow choices and their integration
 * triggers. A preset change that renames or removes one of those IDs makes the customization
 * fail with "Unknown step" when a stream is created. These helpers find those squads before the
 * change is applied, so a restore can warn and a code update can be held back.
 */
import { applyWorkflowCustomizations, type WorkflowDefinition, type WorkflowSource } from '@ficus/shared'
import { db, squads, type DbTx } from '../../db'
import { squadWorkflowSources } from './access'

export interface SquadCustomizationBreak {
  squadId: string
  squadName: string
  /** Why each affected customization would fail, such as "Unknown step 'execute'". */
  problems: string[]
}

function failure(definition: WorkflowDefinition, source: Extract<WorkflowSource, { kind: 'preset' }>) {
  try {
    applyWorkflowCustomizations(definition, source.customizations)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Squads whose saved customizations of `presetId` apply to `current` but would fail on `next`.
 * Customizations that already fail today are not reported: the change does not cause them.
 */
export async function findBrokenSquadCustomizations(
  presetId: string,
  current: WorkflowDefinition,
  next: WorkflowDefinition,
  store: DbTx | typeof db = db
): Promise<SquadCustomizationBreak[]> {
  const rows = await store.select({ id: squads.id, name: squads.name, metadata: squads.metadata }).from(squads)
  const broken: SquadCustomizationBreak[] = []
  for (const row of rows) {
    let sources: WorkflowSource[]
    try {
      sources = squadWorkflowSources((row.metadata ?? {}) as Record<string, unknown>)
    } catch {
      continue
    }
    const problems = new Set<string>()
    for (const source of sources) {
      if (source?.kind !== 'preset' || source.id !== presetId || !source.customizations?.length) continue
      if (failure(current, source) !== undefined) continue
      const problem = failure(next, source)
      if (problem !== undefined) problems.add(problem)
    }
    if (problems.size) broken.push({ squadId: row.id, squadName: row.name, problems: [...problems] })
  }
  return broken.sort((a, b) => a.squadName.localeCompare(b.squadName))
}

/** Split affected squads into the ones the caller may see by name and a count of the rest. */
export function visibleSquadBreaks(breaks: SquadCustomizationBreak[], canSeeSquad: (squadId: string) => boolean) {
  const visible = breaks.filter((item) => canSeeSquad(item.squadId))
  return { affectedSquads: visible, hiddenSquadCount: breaks.length - visible.length }
}

/** One sentence naming the affected squads, for refusals and logs. */
export function describeSquadBreaks(view: ReturnType<typeof visibleSquadBreaks>): string {
  const names = view.affectedSquads.map((item) => `${item.squadName} (${item.problems.join('; ')})`)
  if (view.hiddenSquadCount)
    names.push(`${view.hiddenSquadCount} squad${view.hiddenSquadCount === 1 ? '' : 's'} you cannot see`)
  return names.join(', ')
}
