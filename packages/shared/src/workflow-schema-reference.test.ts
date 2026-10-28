import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  describeZodType,
  formatWorkflowSchemaReference,
  workflowSchemaOverview,
  workflowStepKindReference,
  workflowStepKinds,
} from './workflow-schema-reference'

describe('workflow schema reference', () => {
  test('lists every step kind from the schema, with the default kind', () => {
    expect(workflowStepKinds()).toEqual(['agent', 'human-approval', 'decision'])
    const overview = workflowSchemaOverview()
    expect(overview.defaultKind).toBe('agent')
    expect(overview.transitions).toEqual([
      '{ next: ID | finish }',
      '{ parallel: list of ID (2–16 items), join?: ID | finish }',
      '{ returnTo: ID, afterRework?: follow-graph | return-to-requester }',
    ])
  })

  test('human-approval requires output and offers both approver values', () => {
    const reference = workflowStepKindReference('human-approval')!
    expect(reference.required.map((field) => field.name)).toEqual(['kind', 'id', 'instructions', 'output', 'outcomes'])
    const approver = reference.optional.find((field) => field.name === 'approver')!
    expect(approver.type).toBe('assigned-reviewers | reviewers')
    expect(approver.default).toBe('assigned-reviewers')
    expect(approver.description).toContain('assigned-reviewers:')
    expect(approver.description).toContain('reviewers: anyone with workstreams:review permission')
  })

  test('a decision step has no output and optional routing fields', () => {
    const reference = workflowStepKindReference('decision')!
    expect(reference.required.map((field) => field.name)).toEqual([
      'kind',
      'id',
      'instructions',
      'questions',
      'outcomes',
    ])
    expect(reference.optional.map((field) => field.name)).toEqual([
      'name',
      'input',
      'routes',
      'otherwise',
      'unavailable',
    ])
  })

  test('the text form shows required and optional fields with allowed values', () => {
    const text = formatWorkflowSchemaReference('human-approval')
    expect(text).toMatch(/Required:\n {2}kind {10}human-approval\n/)
    expect(text).toMatch(/\n {2}output {8}text, 1–64000 characters\./)
    expect(text).toContain('approver  assigned-reviewers | reviewers. default: "assigned-reviewers".')
  })

  test('an unknown kind lists the valid kinds', () => {
    expect(workflowStepKindReference('approval')).toBeUndefined()
    expect(() => formatWorkflowSchemaReference('approval')).toThrow(
      'Unknown step kind; use one of: agent, human-approval, decision'
    )
  })
})

describe('Zod 4 format descriptions', () => {
  test('top-level UUID formats retain the UUID label', () => {
    expect(describeZodType(z.uuid())).toBe('UUID')
    expect(describeZodType(z.uuid().max(36))).toBe('UUID, at most 36 characters')
  })

  test('top-level integers retain whole-number labels and explicit bounds', () => {
    expect(describeZodType(z.int())).toBe('whole number')
    expect(describeZodType(z.int().min(1).max(10))).toBe('whole number 1–10')
  })
})
