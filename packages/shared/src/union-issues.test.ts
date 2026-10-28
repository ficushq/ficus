import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { workflowCustomizationSchema, workflowSourceSchema } from './workflows'
import { describeZodIssue, explainedUnion } from './union-issues'

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

  test('an otherwise valid step with an unknown field reports that field at the step', () => {
    // Zod 4 returns the only failing member's issues directly when they are all continuable, so this
    // is an unrecognized_keys issue at the step rather than an explained invalid_union.
    expect(issues(source({ ...gate, extra: 1 }))).toEqual([
      { path: 'definition.steps.1', code: 'unrecognized_keys', message: 'Unrecognized key: "extra"' },
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

describe('describeZodIssue', () => {
  const schema = z
    .object({ name: z.string(), size: z.number().int().max(3), tags: z.array(z.string()).min(1) })
    .strict()
  function described(value: unknown) {
    const result = schema.safeParse(value)
    if (result.success) throw new Error('expected a validation failure')
    return result.error.issues.map((issue) => describeZodIssue(issue, issue.path.join('.'), { root: value }))
  }

  test('tells a missing field from a wrong type', () => {
    expect(described({ size: 1, tags: ['a'] })).toEqual(['name is required'])
    expect(described({ name: 1, size: 1, tags: ['a'] })).toEqual(['name must be text'])
  })

  test('without a root, a missing field is recognised from the default message', () => {
    const result = schema.safeParse({ size: 1, tags: ['a'] })
    expect(!result.success && describeZodIssue(result.error.issues[0]!, 'name')).toBe('name is required')
  })

  test('describes sizes, whole numbers, unknown fields and allowed values', () => {
    expect(described({ name: 'a', size: 4, tags: [], other: true })).toEqual([
      'size must be at most 3',
      'tags must have at least 1 items',
      "unknown field 'other'",
    ])
    expect(described({ name: 'a', size: 1.5, tags: ['a'] })).toEqual(['size must be a whole number'])
    const choice = z.object({ mode: z.enum(['a', 'b']), exact: z.literal('x') })
    const result = choice.safeParse({ mode: 'c', exact: 'y' })
    expect(
      !result.success && result.error.issues.map((issue) => describeZodIssue(issue, String(issue.path[0])))
    ).toEqual(['mode must be one of: a, b', 'exact must be "x"'])
  })

  test('a discriminated union without a matching member lists the valid discriminators', () => {
    const union = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])
    const result = union.safeParse({ kind: 'c' })
    expect(!result.success && describeZodIssue(result.error.issues[0]!, 'kind')).toBe('kind must be one of: a, b')
  })
})
