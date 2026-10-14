import { describe, expect, it } from 'bun:test'
import { workflowPresetSchema, workflowSourceSchema } from '@ficus/shared'
import { readStructuredInput, validateStructuredInput } from './structured-input'

const preset = (routes: unknown[]) => ({
  id: 'triage-flow',
  definition: {
    schemaVersion: 1,
    name: 'Triage',
    participants: {},
    entry: 'triage',
    routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
    limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
    steps: [
      {
        id: 'triage',
        kind: 'decision',
        instructions: 'Is it a bug?',
        questions: { is_bug: { type: 'yesno', instructions: 'It reports a bug.' } },
        routes,
        otherwise: 'done',
        unavailable: 'done',
        outcomes: { done: { next: 'finish' } },
      },
    ],
    completion: { mode: 'deliverable' },
  },
})

describe('validateStructuredInput', () => {
  it("passes the schema's own explanation through, so an agent knows how to fix it", () => {
    const bad = preset([
      { when: { type: 'yesno', question: 'is_bug', op: 'at-least', probability: 0.7 }, outcome: 'ship' },
    ])
    expect(() => validateStructuredInput(workflowPresetSchema, bad)).toThrow(
      "uses unknown outcome '…'; add it to the step's outcomes"
    )
    // What it quotes from the input is caller data, and is left out.
    expect(() => validateStructuredInput(workflowPresetSchema, bad)).not.toThrow(/ship/)
    expect(() => validateStructuredInput(workflowPresetSchema, bad)).toThrow(/^Invalid workflow input \(definition\./)
  })

  it('accepts a valid decision step', () => {
    const good = preset([
      { when: { type: 'yesno', question: 'is_bug', op: 'at-least', probability: 0.7 }, outcome: 'done' },
    ])
    expect(validateStructuredInput(workflowPresetSchema, good).id).toBe('triage-flow')
  })
})

describe('step validation errors', () => {
  const inline = (step: unknown) => ({
    kind: 'inline',
    definition: {
      schemaVersion: 1,
      name: 'Design gate',
      participants: { architect: { agentTypeId: 'architect', session: 'reuse-within-stream' } },
      entry: 'design',
      routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
      limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
      steps: [
        {
          id: 'design',
          participant: 'architect',
          instructions: 'Write the design.',
          output: 'A design document.',
          outcomes: { ready: { next: 'gate' } },
        },
        step,
      ],
      completion: { mode: 'deliverable' },
    },
  })
  const gate = {
    id: 'gate',
    kind: 'human-approval',
    instructions: 'Approve the design.',
    outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'design' } },
  }

  it('names the step kind and the missing field, and points to the schema command', () => {
    expect(() => validateStructuredInput(workflowSourceSchema, inline(gate))).toThrow(
      'Invalid workflow input (definition.steps[1]: human-approval step: output is required). Run ficus workflow schema for step kinds and their fields.'
    )
  })

  it('lists the valid kinds for an unknown kind without echoing it', () => {
    const run = () => validateStructuredInput(workflowSourceSchema, inline({ ...gate, kind: 'approval', output: 'x' }))
    expect(run).toThrow("unknown step kind '…'; use one of: agent, human-approval, decision")
    expect(run).not.toThrow(/'approval'/)
  })

  it('describes other schema problems with allowed values instead of a bare code', () => {
    const value = inline({ ...gate, output: 'x' })
    ;(value.definition.routing as { mode: string }).mode = 'strict'
    expect(() => validateStructuredInput(workflowSourceSchema, value)).toThrow(
      'definition.routing.mode: value must be one of: guided, flexible, adaptive'
    )
  })

  it('accepts the human-approval example from the setup-workflows skill', async () => {
    const skill = await Bun.file(new URL('../../../config/skills/setup-workflows/SKILL.md', import.meta.url)).text()
    const example = /## Gate with a human approval[\s\S]*?<<'FICUS_FLOW'\n([\s\S]*?)\nFICUS_FLOW/.exec(skill)?.[1]
    expect(example).toBeDefined()
    const source = validateStructuredInput(workflowSourceSchema, await readStructuredInput({ content: example }))
    expect(source.kind === 'inline' && source.definition.steps.map((step) => step.kind)).toEqual([
      'agent',
      'human-approval',
      'agent',
    ])
  })
})
