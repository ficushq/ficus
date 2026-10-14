import { describe, expect, it } from 'bun:test'
import { workflowPresetSchema } from '@ficus/shared'
import { validateStructuredInput } from './structured-input'

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
