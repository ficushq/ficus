import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assistantEditorProposalSchema,
  assistantEditorEditParameters,
  assistantEditorReadParameters,
  assistantEditorReadResult,
  type AssistantEditorReadState,
} from './assistant-editors'
import { createBlankWorkflow } from './workflow-editing'
import { applyWorkflowCustomizations, resolveWorkflow } from './workflows'

test('targeted flow changes preserve unrelated fields and validate an atomic connected addition', () => {
  const base = createBlankWorkflow()
  const original = structuredClone(base)
  const operations = [
    { op: 'put-participant', id: 'reviewer', participant: { agentTypeId: 'general', session: 'fresh-per-attempt' } },
    {
      op: 'put-step',
      step: { ...base.steps[0], id: 'review', participant: 'reviewer', instructions: 'Check the deliverable.' },
    },
    { op: 'update-step', id: 'execute', changes: { instructions: 'Write a report.' } },
    { op: 'set-outcome', id: 'execute', outcome: 'completed', transition: { next: 'review' } },
  ]
  const next = applyWorkflowCustomizations(base, operations)
  expect(base).toEqual(original)
  expect(next.steps[0]).toEqual({
    ...base.steps[0]!,
    instructions: 'Write a report.',
    outcomes: { completed: { next: 'review' } },
  })
  expect(next.participants.worker).toEqual(base.participants.worker)
  expect(next.limits).toEqual(base.limits)
  expect(next.completion).toEqual(base.completion)
  expect(
    resolveWorkflow(
      { kind: 'preset', id: 'base', customizations: operations },
      { id: 'base', revision: '1', disabled: false, definition: base }
    ).definition
  ).toEqual(next)
  const removed = applyWorkflowCustomizations(next, [
    { op: 'set-outcome', id: 'execute', outcome: 'completed', transition: { next: 'finish' } },
    { op: 'remove-step', id: 'review' },
    { op: 'remove-participant', id: 'reviewer' },
  ])
  expect(removed.steps.length).toBe(1)
})

test('invalid targeted batches reject missing references, unsafe IDs, and incompatible fields without mutating the draft', () => {
  const base = createBlankWorkflow()
  const original = structuredClone(base)
  for (const operations of [
    [
      { op: 'set-name', name: 'Must not leak' },
      { op: 'set-outcome', id: 'execute', outcome: 'completed', transition: { next: 'missing' } },
    ],
    [{ op: 'update-step', id: 'missing', changes: { output: 'Result' } }],
    [{ op: 'update-step', id: 'execute', changes: { id: 'renamed' } }],
    [{ op: 'update-step', id: 'execute', changes: { approver: 'reviewers' } }],
    [{ op: 'set-outcome', id: 'execute', outcome: '__proto__', transition: { next: 'finish' } }],
    [{ op: 'remove-outcome', id: 'execute', outcome: 'completed' }],
  ]) {
    expect(() => applyWorkflowCustomizations(base, operations)).toThrow()
    expect(base).toEqual(original)
  }
})

test('editor requests select one edit mode and expose the operation schema to both assistants', () => {
  const common = { baseRevision: 0, summary: 'Change the flow' }
  const operations = [{ op: 'set-name', name: 'Research' }]
  expect(assistantEditorProposalSchema.safeParse({ ...common, operations }).success).toBe(true)
  expect(assistantEditorProposalSchema.safeParse({ ...common, historyAction: 'undo' }).success).toBe(true)
  for (const value of [
    common,
    { ...common, operations, documentJson: '{}' },
    { ...common, operations, historyAction: 'redo' },
  ]) {
    expect(assistantEditorProposalSchema.safeParse(value).success).toBe(false)
  }
  const schema = assistantEditorEditParameters as any
  expect(schema.type).toBe('object')
  expect(schema.required).toEqual(['baseRevision', 'summary'])
  expect(schema.properties.operations.type).toBe('array')
  expect(JSON.stringify(schema.properties.operations)).toContain('update-step')
  expect(JSON.stringify(schema.properties.operations)).toContain('set-outcome')
})

test('routine model reads omit catalogs, transport fields, and duplicate proposal documents; references are opt-in', () => {
  const state: AssistantEditorReadState = {
    kind: 'workflow',
    target: {},
    revision: 3,
    document: createBlankWorkflow(),
    history: { canUndo: true, canRedo: true },
    expiresAt: '2030-01-01',
    contract: 'Detailed editing reference',
    agentTypes: [{ id: 'general', name: 'General Purpose' }],
    integrationOutputs: ['github', 'linear'].map((integration) => ({
      integration,
      output: 'issue.assigned',
      version: 1,
      title: 'Assigned',
      description: 'An assignment',
      fields: { assignee: { type: 'string', description: 'Assignee ID' } },
    })),
    proposal: {
      id: 'pending',
      baseRevision: 3,
      summary: 'Rename',
      document: { ...createBlankWorkflow(), name: 'New name' },
    },
  }
  const read = assistantEditorReadResult(state)
  expect(read.document).toEqual(state.document)
  expect(read.revision).toBe(3)
  expect(read.history).toEqual(state.history)
  expect(read.pendingEdit?.id).toBe('pending')
  for (const field of ['contract', 'agentTypes', 'integrationOutputs', 'expiresAt', 'proposal'])
    expect(read).not.toHaveProperty(field)
  const reference = assistantEditorReadResult(state, {
    include: ['contract', 'agentTypes', 'integrationOutputs'],
    integration: 'linear',
  })
  expect(reference.contract).toBe(state.contract)
  expect(reference.agentTypes).toEqual([{ id: 'general', name: 'General Purpose', description: undefined }])
  expect(reference.integrationOutputs).toEqual([state.integrationOutputs![1]!])
  expect(() => assistantEditorReadResult(state, { include: ['unknown'] })).toThrow()
})

/**
 * Keys zod 4's JSON Schema adds that zod 3's converter left out. They only describe what validation
 * already enforced (record key patterns, safe-integer bounds, the UUID pattern, explicit string types).
 */
function isAdditiveKey(key: string, value: unknown) {
  if (key === 'propertyNames') return true
  // Approved request cardinalities, asserted independently against production validators.
  if (key === 'maxProperties') return value === 16 || value === 64
  if (key === 'maxItems') return value === 3
  if (key === 'maximum') return value === Number.MAX_SAFE_INTEGER
  if (key === 'type') return value === 'string'
  if (key === 'pattern') return typeof value === 'string' && value.startsWith('^([0-9a-fA-F]{8}-')
  return false
}

/** Differences between the committed zod 3 contract and a generated schema, beyond additive keys. */
function contractDifferences(expected: unknown, actual: unknown, path = '$'): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length)
      return [`${path}: ${JSON.stringify(expected)?.slice(0, 120)} became ${JSON.stringify(actual)?.slice(0, 120)}`]
    return expected.flatMap((item, index) => contractDifferences(item, actual[index], `${path}[${index}]`))
  }
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object')
    return Object.is(expected, actual) ? [] : [`${path}: ${JSON.stringify(expected)} became ${JSON.stringify(actual)}`]
  const want = expected as Record<string, unknown>
  // Zod 4 writes discriminated unions as oneOf; the members are disjoint, so it means the same as anyOf.
  const have = Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [key === 'oneOf' && !('oneOf' in want) ? 'anyOf' : key, value])
  )
  const differences: string[] = []
  for (const key of new Set([...Object.keys(want), ...Object.keys(have)])) {
    if (key === '$schema') continue
    if (!(key in want)) {
      if (!isAdditiveKey(key, have[key])) differences.push(`${path}.${key}: added ${JSON.stringify(have[key])}`)
    } else if (!(key in have)) differences.push(`${path}.${key}: removed`)
    else differences.push(...contractDifferences(want[key], have[key], `${path}.${key}`))
  }
  return differences
}

test('model-facing tool parameters keep the zod 3 contract', () => {
  const baseline = JSON.parse(
    readFileSync(join(import.meta.dir, 'test-fixtures/assistant-editor-parameters.zod3.json'), 'utf8')
  ) as { read: unknown; edit: unknown }
  expect(contractDifferences(baseline.read, assistantEditorReadParameters)).toEqual([])
  expect(contractDifferences(baseline.edit, assistantEditorEditParameters)).toEqual([])
})

test('the contract check notices removed fields, requirements and descriptions', () => {
  const schema = { type: 'object', properties: { a: { type: 'string', description: 'A' } }, required: ['a'] }
  expect(contractDifferences(schema, { ...schema, required: [] })).toEqual([`$.required: ["a"] became []`])
  expect(contractDifferences(schema, { ...schema, properties: { a: { type: 'string' } } })).toEqual([
    '$.properties.a.description: removed',
  ])
  expect(contractDifferences(schema, { ...schema, additionalProperties: true })).toEqual([
    '$.additionalProperties: added true',
  ])
})

test('model-facing bounded records preserve their cardinality metadata', () => {
  const edit = JSON.stringify(assistantEditorEditParameters)
  expect(edit).toContain('"maxProperties":16')
  expect(edit).toContain('"maxProperties":64')
})
