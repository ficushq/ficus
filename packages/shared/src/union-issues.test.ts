import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { workflowCustomizationSchema, workflowSourceSchema } from './workflows'
import { explainedUnion } from './union-issues'

const design = {
  id: 'design',
  participant: 'architect',
  instructions: 'Write the design.',
  output: 'A design document.',
  outcomes: { ready: { next: 'gate' } },
}
const gate = {
  id: 'gate',
  kind: 'human-approval',
  instructions: 'Approve the design.',
  output: 'The decision.',
  outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'design' } },
}
function source(step: unknown) {
  return {
    kind: 'inline',
    definition: {
      schemaVersion: 1,
      name: 'Design gate',
      participants: { architect: { agentTypeId: 'architect', session: 'reuse-within-stream' } },
      entry: 'design',
      routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
      limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
      steps: [design, step],
      completion: { mode: 'deliverable' },
    },
  }
}
function issues(value: unknown, schema: z.ZodTypeAny = workflowSourceSchema) {
  const result = schema.safeParse(value)
  if (result.success) throw new Error('expected a validation failure')
  return result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message }))
}

describe('step validation messages', () => {
  test('a human-approval step without output names its kind and the missing field', () => {
    const { output: _output, ...withoutOutput } = gate
    expect(issues(source(withoutOutput))).toEqual([
      // Code and path are unchanged; only the message explains the failure.
      { path: 'definition.steps.1', code: 'invalid_union', message: 'human-approval step: output is required' },
    ])
  })

  test('an unknown kind lists the valid kinds', () => {
    expect(issues(source({ ...gate, kind: 'approval' }))[0]!.message).toBe(
      "unknown step kind 'approval'; use one of: agent, human-approval, decision"
    )
  })

  test('without a kind, the step is explained as the default agent kind', () => {
    const { kind: _kind, ...withoutKind } = gate
    expect(issues(source({ ...withoutKind, approver: 'reviewers' }))[0]!.message).toBe(
      "agent step, the default kind: participant is required; unknown field 'approver'"
    )
  })

  test('lists every problem of the matching kind with its field path and allowed values', () => {
    const message = issues(
      source({ ...gate, approver: 'admins', outcomes: { approved: { nxt: 'finish' }, other: { next: 'finish' } } })
    )[0]!.message
    expect(message).toStartWith('human-approval step: ')
    expect(message).toContain(
      "outcomes.'approved': transition must have one of these shapes: { next } or { parallel, join } or { returnTo, afterRework }"
    )
    expect(message).toContain('approver must be one of: assigned-reviewers, reviewers')
  })

  test('a step that is not an object says so', () => {
    expect(issues(source('gate'))[0]!.message).toBe('each step must be an object with a kind')
  })

  test('put-step customizations explain the step the same way', () => {
    const { output: _output, ...withoutOutput } = gate
    const result = issues(
      { op: 'put-step', step: withoutOutput },
      workflowCustomizationSchema as unknown as z.ZodTypeAny
    )
    expect(result).toEqual([
      { path: 'step', code: 'invalid_union', message: 'human-approval step: output is required' },
    ])
  })

  test('valid steps still parse, with the same defaults', () => {
    const parsed = workflowSourceSchema.parse(source(gate))
    expect(parsed.kind === 'inline' && parsed.definition.steps[1]).toMatchObject({
      kind: 'human-approval',
      approver: 'assigned-reviewers',
    })
  })
})

describe('explainedUnion', () => {
  const schema = explainedUnion([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()], {
    label: 'thing',
  })

  test('accepts exactly what z.union accepts', () => {
    const plain = z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()])
    for (const value of [{ a: 'x' }, { b: 1 }, { a: 1 }, { c: 1 }, null, { a: 'x', b: 1 }])
      expect(schema.safeParse(value).success).toBe(plain.safeParse(value).success)
  })

  test('without a discriminator, a field only one member has selects it', () => {
    const result = schema.safeParse({ b: 'one' })
    expect(!result.success && result.error.issues[0]!.message).toBe('thing: b must be a number')
  })
})
