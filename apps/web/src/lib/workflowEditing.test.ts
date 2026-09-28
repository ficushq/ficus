import { FLOW_START_ID, layoutWorkflowGraph } from './workflowGraph'
import { expect, test } from 'bun:test'
import { createBlankWorkflow, workflowDefinitionSchema } from '@ficus/shared'
import {
  insertWorkflowStep,
  separateWorkflowParticipant,
  changedWorkflowSteps,
  removeWorkflowStep,
  connectWorkflowOutcome,
} from './workflowEditing'

test('inserting a step splices one forward connection and preserves later work and the source snapshot', () => {
  const source = createBlankWorkflow()
  const original = structuredClone(source)
  const one = insertWorkflowStep(source, source.entry)
  const two = insertWorkflowStep(one.definition, source.entry, true)
  expect(source).toEqual(original)
  expect(two.definition.steps.find((step) => step.id === source.entry)!.outcomes.completed).toEqual({
    next: two.selected,
  })
  expect(two.definition.steps.find((step) => step.id === two.selected)!.outcomes.completed).toEqual({
    next: one.selected,
  })
  expect(workflowDefinitionSchema.safeParse(two.definition).success).toBe(true)
  expect(changedWorkflowSteps(source, two.definition)).toContain(two.selected)
  expect(Object.keys(two.definition.participants)).toHaveLength(Object.keys(source.participants).length + 1)
})

test('changes to a reused participant highlight every affected step', () => {
  const before = createBlankWorkflow()
  const after = structuredClone(before)
  after.participants[Object.keys(after.participants)[0]!]!.tier = 'deep'
  expect(changedWorkflowSteps(before, after)).toEqual([before.entry])
})

test('renaming a step preserves branch, join, return, and integration references', async () => {
  const { renameWorkflowStep } = await import('./workflowEditing')
  const definition = createBlankWorkflow()
  const step = definition.steps[0]!
  step.outcomes = {
    completed: { next: step.id },
    review: { parallel: [step.id, 'other'], join: step.id },
    retry: { returnTo: step.id, afterRework: 'return-to-requester' },
  }
  definition.subscriptions = [
    {
      id: 'review',
      source: { integration: 'github', output: 'review', version: 1 },
      match: { repo: { streamMetadata: 'repo' } },
      deliver: { to: { step: step.id }, whenInactive: 'retain' },
    },
  ]
  const result = renameWorkflowStep(definition, step.id, 'research')
  expect(result.entry).toBe('research')
  expect(result.steps[0]!.outcomes).toEqual({
    completed: { next: 'research' },
    review: { parallel: ['research', 'other'], join: 'research' },
    retry: { returnTo: 'research', afterRework: 'return-to-requester' },
  })
  expect(result.subscriptions![0]!.deliver.to).toEqual({ step: 'research' })
  expect(() => renameWorkflowStep(definition, step.id, 'finish')).toThrow()
})

test('canvas rewiring infers forward destinations and preserves the other parallel branch', async () => {
  const { connectWorkflowOutcome } = await import('./workflowEditing')
  let definition = createBlankWorkflow()
  for (let i = 0; i < 4; i++) definition = insertWorkflowStep(definition, definition.entry).definition
  definition.steps[0]!.outcomes = {
    review: { parallel: ['step-1', 'step-2'], join: 'step-3' },
    revise: { returnTo: 'step-1', afterRework: 'return-to-requester' },
  }
  const branch = connectWorkflowOutcome(definition, definition.entry, 'review', 'step-4', 1)
  expect(branch.steps[0]!.outcomes.review).toEqual({ parallel: ['step-1', 'step-4'], join: 'step-3' })
  const appended = connectWorkflowOutcome(definition, definition.entry, 'review', 'step-4')
  expect(appended.steps[0]!.outcomes.review).toEqual({ parallel: ['step-1', 'step-2', 'step-4'], join: 'step-3' })
  expect(() => connectWorkflowOutcome(definition, definition.entry, 'review', 'step-1')).toThrow('already a branch')
  expect(connectWorkflowOutcome(definition, definition.entry, 'review', 'step-3').steps[0]!.outcomes.review).toEqual({
    parallel: ['step-1', 'step-2', 'step-3'],
    join: 'step-3',
  })
  const returned = connectWorkflowOutcome(definition, definition.entry, 'revise', 'step-2')
  expect(returned.steps[0]!.outcomes.revise).toEqual({ next: 'step-2' })
  expect(definition.steps[0]!.outcomes.revise).toEqual({ returnTo: 'step-1', afterRework: 'return-to-requester' })
  expect(() => connectWorkflowOutcome(definition, definition.entry, 'review', 'step-1', 1)).toThrow(
    'Each parallel branch needs a different starting step'
  )
  expect(connectWorkflowOutcome(definition, definition.entry, 'revise', 'finish').steps[0]!.outcomes.revise).toEqual({
    next: 'finish',
  })
})

test('deleting a sequential step reconnects its neighbors without changing the source or shared participant', () => {
  const initial = createBlankWorkflow()
  const { definition, selected } = insertWorkflowStep(initial, initial.entry)
  const removed = removeWorkflowStep(definition, selected)
  expect(removed.steps).toEqual(initial.steps)
  expect(removed.participants[selected]).toEqual(definition.participants[selected])
  expect(definition.steps).toHaveLength(2)
  expect(workflowDefinitionSchema.safeParse(removed).success).toBe(true)
})

test('deleting a branch target preserves its sibling handoff and removes only the affected return', () => {
  const { definition, selected } = insertWorkflowStep(createBlankWorkflow(), 'execute')
  definition.steps[0]!.outcomes = {
    review: { parallel: [selected, 'qa'], join: 'join' },
    retry: { returnTo: selected, afterRework: 'return-to-requester' },
    done: { next: 'finish' },
  }
  expect(removeWorkflowStep(definition, selected).steps[0]!.outcomes).toEqual({
    review: { next: 'qa' },
    done: { next: 'finish' },
  })
})

function parallelDeletionFixture(branches: string[]) {
  const definition = createBlankWorkflow()
  const template = structuredClone(definition.steps[0]!)
  definition.steps[0]!.outcomes = { completed: { parallel: branches, join: 'publish' } }
  definition.steps.push(
    ...branches.map((id) => ({ ...structuredClone(template), id, outcomes: { completed: { next: 'publish' } } })),
    { ...template, id: 'publish', outcomes: { completed: { next: 'finish' } } }
  )
  return workflowDefinitionSchema.parse(definition)
}

test('deleting one of three parallel steps preserves the outcome, sibling branches, and join connections', () => {
  const definition = parallelDeletionFixture(['audience', 'competitors', 'channels'])
  const original = structuredClone(definition)
  const result = removeWorkflowStep(definition, 'competitors')
  expect(result.steps[0]!.outcomes.completed).toEqual({ parallel: ['audience', 'channels'], join: 'publish' })
  expect(result.steps.slice(1)).toEqual(
    definition.steps.filter((step) => !['execute', 'competitors'].includes(step.id))
  )
  expect(workflowDefinitionSchema.safeParse(result).success).toBe(true)
  expect(definition).toEqual(original)
})

test('deleting either of two parallel steps keeps the named outcome connected to the surviving track', () => {
  const definition = parallelDeletionFixture(['audience', 'competitors'])
  for (const removed of ['audience', 'competitors']) {
    const remaining = removed === 'audience' ? 'competitors' : 'audience'
    const result = removeWorkflowStep(definition, removed)
    expect(result.steps[0]!.outcomes.completed).toEqual({ next: remaining })
    expect(result.steps.find((step) => step.id === remaining)!.outcomes.completed).toEqual({ next: 'publish' })
    expect(workflowDefinitionSchema.safeParse(result).success).toBe(true)
    const edges = layoutWorkflowGraph(result).edges
    expect(edges.some((edge) => edge.from === 'execute' && edge.to === remaining)).toBe(true)
    expect(edges.some((edge) => edge.from === remaining && edge.to === 'publish')).toBe(true)
  }
})

test('deleting the shared next step preserves the parallel branches and reconnects them onward', () => {
  const definition = parallelDeletionFixture(['audience', 'competitors'])
  const result = removeWorkflowStep(definition, 'publish')
  expect(result.steps[0]!.outcomes.completed).toEqual({ parallel: ['audience', 'competitors'], join: 'finish' })
  for (const branch of result.steps.slice(1)) expect(branch.outcomes.completed).toEqual({ next: 'finish' })
  expect(workflowDefinitionSchema.safeParse(result).success).toBe(true)
})

test('a second outgoing wire creates a split, and removing one restores a single handoff', async () => {
  const { connectWorkflowOutcome, removeWorkflowConnection } = await import('./workflowEditing')
  let flow = createBlankWorkflow()
  flow = insertWorkflowStep(flow, flow.entry).definition
  flow = insertWorkflowStep(flow, flow.entry).definition
  const first = (flow.steps[0]!.outcomes.completed as { next: string }).next
  const other = flow.steps.find((step) => step.id !== flow.entry && step.id !== first)!.id
  const split = connectWorkflowOutcome(flow, flow.entry, 'completed', other)
  expect(split.steps[0]!.outcomes.completed).toEqual({ parallel: [first, other], join: 'finish' })
  expect(removeWorkflowConnection(split, flow.entry, 'completed', 1).steps[0]!.outcomes.completed).toEqual({
    next: first,
  })
  expect(flow.steps[0]!.outcomes.completed).toEqual({ next: first })
})

test('Start reconnects exactly one entry without introducing parallel branches or changing step outcomes', () => {
  const definition = insertWorkflowStep(createBlankWorkflow(), 'execute').definition
  const original = structuredClone(definition)
  const updated = connectWorkflowOutcome(definition, FLOW_START_ID, 'starts', definition.steps[1]!.id)
  expect(updated.entry).toBe(definition.steps[1]!.id)
  expect(updated.steps).toEqual(original.steps)
  const restored = connectWorkflowOutcome(updated, FLOW_START_ID, 'starts', 'execute')
  expect(restored).toEqual(original)
  expect(layoutWorkflowGraph(updated).edges.filter((edge) => edge.from === FLOW_START_ID)).toEqual([
    { from: FLOW_START_ID, to: updated.entry, label: 'starts', rework: false },
  ])
  expect(() => connectWorkflowOutcome(updated, FLOW_START_ID, 'starts', 'finish')).toThrow('Start must connect')
})

test('backward connections infer rework, while reconnecting the same arrow forward preserves its destination', () => {
  const definition = insertWorkflowStep(createBlankWorkflow(), 'execute').definition
  const review = definition.steps[1]!
  review.outcomes.revise = { next: 'finish' }
  const backward = connectWorkflowOutcome(definition, review.id, 'revise', 'execute')
  expect(backward.steps[1]!.outcomes.revise).toEqual({ returnTo: 'execute', afterRework: 'follow-graph' })
  expect(backward.steps[1]!.outcomes.completed).toEqual({ next: 'finish' })
  expect(workflowDefinitionSchema.safeParse(backward).success).toBe(true)
  const forward = connectWorkflowOutcome(backward, review.id, 'revise', 'finish', undefined, true)
  expect(forward.steps[1]!.outcomes.revise).toEqual({ next: 'finish' })
  expect(forward.steps[0]!.outcomes.completed).toEqual({ next: review.id })
})

test('making a participant separate copies settings for only the selected step and preserves graph references', () => {
  const source = createBlankWorkflow()
  source.participants.worker!.tier = 'deep'
  source.steps[0]!.outcomes = { completed: { next: 'publish' } }
  source.steps.push({
    ...structuredClone(source.steps[0]!),
    id: 'publish',
    outcomes: { completed: { next: 'finish' } },
  })
  source.participants['publish-agent'] = { agentTypeId: 'general', session: 'fresh-per-attempt' }
  const before = structuredClone(source)
  const separated = separateWorkflowParticipant(source, 'publish')
  expect(separated.participant).toBe('publish-agent-2')
  expect(source).toEqual(before)
  expect(separated.definition.steps[0]).toEqual(source.steps[0])
  expect(separated.definition.entry).toBe(source.entry)
  expect(separated.definition.steps[1]).toEqual({ ...source.steps[1]!, participant: 'publish-agent-2' })
  expect(separated.definition.participants['publish-agent-2']).toEqual(source.participants.worker!)
  separated.definition.participants['publish-agent-2']!.tier = 'exhaustive'
  expect(separated.definition.participants.worker!.tier).toBe('deep')
  expect(workflowDefinitionSchema.safeParse(separated.definition).success).toBe(true)
})
