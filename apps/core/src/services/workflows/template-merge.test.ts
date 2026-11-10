import { describe, expect, test } from 'bun:test'
import * as yaml from 'js-yaml'
import { workflowPresetSchema, type WorkflowPreset } from '@ficus/shared'
import {
  describeTemplatePath,
  diffWorkflowTemplate,
  mergeWorkflowTemplate,
  parseMergedPreset,
  restoreWorkflowTemplatePaths,
} from './template-merge'

const base = async (): Promise<WorkflowPreset> =>
  workflowPresetSchema.parse(
    yaml.load(await Bun.file(new URL('../../../../../config/workflows/reviewed-coding.yaml', import.meta.url)).text())
  )

/** The old shape of solo-coding (worker / execute), before its participant and step were renamed. */
const oldSoloCoding = (): WorkflowPreset =>
  workflowPresetSchema.parse({
    id: 'solo-coding',
    description: 'One engineer implements a change.',
    definition: {
      schemaVersion: 1,
      name: 'Solo Coding',
      participants: { worker: { agentTypeId: 'engineer', session: 'reuse-within-stream' } },
      entry: 'execute',
      routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
      limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
      steps: [
        {
          id: 'execute',
          participant: 'worker',
          instructions: 'Do it.',
          output: 'Done.',
          outcomes: { completed: { next: 'finish' } },
        },
      ],
      completion: { mode: 'pr-merge', followChanges: true },
    },
  })
const renamedSoloCoding = (): WorkflowPreset => {
  const value = structuredClone(oldSoloCoding())
  value.definition.participants = { engineer: { agentTypeId: 'engineer', session: 'reuse-within-stream' } }
  value.definition.entry = 'implement'
  value.definition.steps = [
    {
      kind: 'agent',
      id: 'implement',
      participant: 'engineer',
      instructions: 'Implement it.',
      output: 'Done.',
      outcomes: { completed: { next: 'finish' } },
    },
  ] as WorkflowPreset['definition']['steps']
  return value
}

describe('mergeWorkflowTemplate', () => {
  test('a participant tier edit no longer holds back step changes elsewhere in the preset', async () => {
    const template = await base()
    const local = structuredClone(template)
    const [participant] = Object.keys(local.definition.participants)
    local.definition.participants[participant!]!.tier = 'deep'
    const update = structuredClone(template)
    update.definition.steps[0]!.instructions = 'New upstream instructions.'
    update.description = 'New upstream description.'

    const { merged, conflicts } = mergeWorkflowTemplate(template, local, update)
    const value = parseMergedPreset(template.id, merged)
    expect(conflicts).toEqual([])
    expect(value.definition.participants[participant!]!.tier).toBe('deep')
    expect(value.definition.steps[0]!.instructions).toBe('New upstream instructions.')
    expect(value.description).toBe('New upstream description.')
    expect(value.definition.steps.map((step) => step.id)).toEqual(template.definition.steps.map((step) => step.id))
  })

  test('step and participant renames apply around an unrelated local edit', () => {
    const template = oldSoloCoding()
    const local = structuredClone(template)
    local.definition.name = 'Our Solo Coding'
    const { merged, conflicts } = mergeWorkflowTemplate(template, local, renamedSoloCoding())
    const value = parseMergedPreset('solo-coding', merged)
    expect(conflicts).toEqual([])
    expect(value.definition.name).toBe('Our Solo Coding')
    expect(value.definition.entry).toBe('implement')
    expect(Object.keys(value.definition.participants)).toEqual(['engineer'])
    expect(value.definition.steps.map((step) => step.id)).toEqual(['implement'])
  })

  test('a part changed on both sides keeps the local value and reports the conflict', async () => {
    const template = await base()
    const local = structuredClone(template)
    local.definition.steps[0]!.instructions = 'Our instructions.'
    local.definition.limits.maxDelegations = 7
    const update = structuredClone(template)
    update.definition.steps[0]!.instructions = 'Upstream instructions.'
    update.definition.steps[1]!.instructions = 'Second step upstream.'
    const { merged, conflicts } = mergeWorkflowTemplate(template, local, update)
    const value = parseMergedPreset(template.id, merged)
    expect(conflicts).toEqual([`definition/steps/${template.definition.steps[0]!.id}/instructions`])
    expect(value.definition.steps[0]!.instructions).toBe('Our instructions.')
    expect(value.definition.steps[1]!.instructions).toBe('Second step upstream.')
    expect(value.definition.limits.maxDelegations).toBe(7)
  })

  test('a step the code removed but the preset edited is kept as a conflict', () => {
    const template = oldSoloCoding()
    const local = structuredClone(template)
    local.definition.steps[0]!.instructions = 'Our edit.'
    const { conflicts } = mergeWorkflowTemplate(template, local, renamedSoloCoding())
    expect(conflicts).toContain('definition/steps/execute')
  })

  test('steps added on both sides keep the local order and insert the new code step after its predecessor', async () => {
    const template = await base()
    const ids = template.definition.steps.map((step) => step.id)
    const local = structuredClone(template)
    local.definition.steps.push({ ...structuredClone(local.definition.steps[0]!), id: 'ours' })
    const update = structuredClone(template)
    update.definition.steps.splice(1, 0, { ...structuredClone(update.definition.steps[0]!), id: 'theirs' })
    const { merged } = mergeWorkflowTemplate(template, local, update)
    const steps = (merged.definition as WorkflowPreset['definition']).steps.map((step) => step.id)
    expect(steps).toEqual([ids[0]!, 'theirs', ...ids.slice(1), 'ours'])
  })
})

describe('diffWorkflowTemplate and restore', () => {
  test('lists each differing part with a readable label and restores only the selected parts', async () => {
    const template = await base()
    const current = structuredClone(template)
    const [participant] = Object.keys(current.definition.participants)
    current.definition.participants[participant!]!.tier = 'deep'
    current.definition.steps[0]!.instructions = 'Local instructions.'
    const stepId = current.definition.steps[0]!.id
    const differences = diffWorkflowTemplate(current, template)
    expect(differences.map((item) => item.path)).toEqual([
      `definition/participants/${participant}/tier`,
      `definition/steps/${stepId}/instructions`,
    ])
    expect(differences[0]).toMatchObject({ label: `Participant ${participant}: tier`, current: 'deep' })
    expect(differences[0]).not.toHaveProperty('template')
    expect(differences[1]!.label).toBe(`Step ${stepId}: instructions`)

    const restored = restoreWorkflowTemplatePaths(current, template, [`definition/steps/${stepId}/instructions`])
    const value = parseMergedPreset(template.id, restored)
    expect(value.definition.steps[0]!.instructions).toBe(template.definition.steps[0]!.instructions)
    expect(value.definition.participants[participant!]!.tier).toBe('deep')
    expect(() => restoreWorkflowTemplatePaths(current, template, ['definition/name'])).toThrow('do not differ')
  })

  test('a frozen preset shows renamed steps as separate parts; restoring one alone is an invalid graph', () => {
    const differences = diffWorkflowTemplate(oldSoloCoding(), renamedSoloCoding())
    const paths = differences.map((item) => item.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'definition/participants/worker',
        'definition/participants/engineer',
        'definition/entry',
        'definition/steps/execute',
        'definition/steps/implement',
      ])
    )
    expect(paths).not.toContain('definition/steps/@order')
    const partial = restoreWorkflowTemplatePaths(oldSoloCoding(), renamedSoloCoding(), ['definition/steps/execute'])
    expect(() => parseMergedPreset('solo-coding', partial)).toThrow()
    const all = restoreWorkflowTemplatePaths(oldSoloCoding(), renamedSoloCoding(), paths)
    expect(parseMergedPreset('solo-coding', all).definition).toEqual(
      workflowPresetSchema.parse(renamedSoloCoding()).definition
    )
  })

  test('labels', () => {
    expect(describeTemplatePath('description')).toBe('Description')
    expect(describeTemplatePath('definition/name')).toBe('Name')
    expect(describeTemplatePath('definition/steps/@order')).toBe('Step order')
    expect(describeTemplatePath('definition/completion/mode')).toBe('Completion: mode')
    expect(describeTemplatePath('definition/participants/engineer')).toBe('Participant engineer')
  })
})
