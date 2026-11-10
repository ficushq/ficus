import { test, expect } from 'bun:test'
import { createBlankWorkflow } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import {
  discardWorkflowDraft,
  readWorkflowDraft,
  subscribeWorkflowDraftWrites,
  workflowDraftKey,
  workflowDraftWriteFailed,
  writeWorkflowDraft,
} from './workflowDraftStorage'

test('draft storage isolates users and retains incomplete editable fields and graph positions', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const key = workflowDraftKey({ type: 'user', userId: 'one' }, '1')!
    const other = workflowDraftKey({ type: 'user', userId: 'two' }, '1')!
    expect(key).not.toBe(other)
    const definition = createBlankWorkflow()
    definition.name = ''
    definition.steps[0]!.instructions = ''
    definition.steps[0]!.outcomes.completed = { next: 'missing-step' }
    definition.limits.maxStepAttempts = 0
    const draft = {
      version: 1,
      id: 'unfinished',
      idEdited: true,
      description: '',
      source: { kind: 'inline', definition },
      positions: { execute: { x: 32, y: 320 } },
    }
    localStorage.setItem(key, JSON.stringify(draft))
    expect(readWorkflowDraft(key)).toEqual(draft)
    expect(readWorkflowDraft(other)).toBeUndefined()
    definition.steps[0]!.outcomes.completed = { parallel: ['remaining-branch'], join: 'join-step' }
    localStorage.setItem(key, JSON.stringify(draft))
    expect(readWorkflowDraft(key)).toEqual(draft)
    const early = structuredClone(draft) as any
    early.source.definition.steps[0].independentFrom = ['author']
    early.source.definition.steps[0].required = true
    early.source.definition.steps[0].outcomes.revise = { returnTo: 'earlier', resumeAt: 'execute' }
    localStorage.setItem(key, JSON.stringify(early))
    const restored = readWorkflowDraft(key)!
    expect(restored.positions).toEqual(draft.positions)
    expect(restored.source.definition.steps[0]!.outcomes.revise).toEqual({ returnTo: 'earlier' })
    expect('required' in restored.source.definition.steps[0]!).toBe(false)
    expect('independentFrom' in restored.source.definition.steps[0]!).toBe(false)
    localStorage.setItem(key, '{broken')
    expect(readWorkflowDraft(key)).toBeUndefined()
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, source: { kind: 'inline', definition: { steps: 'broken' } } })
    )
    expect(readWorkflowDraft(key)).toBeUndefined()
  } finally {
    await dom.cleanup()
  }
})

test('a refused draft write or discard is reported to subscribers until a later write succeeds', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const original = globalThis.localStorage
  const values = new Map<string, string>()
  let refuse = true
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error('quota')
      values.set(key, value)
    },
    removeItem: (key: string) => {
      if (refuse) throw new Error('blocked')
      values.delete(key)
    },
  } as unknown as Storage
  let notified = 0
  const unsubscribe = subscribeWorkflowDraftWrites(() => notified++)
  try {
    const key = workflowDraftKey({ type: 'user', userId: 'writer' }, 'w')!
    const draft = {
      version: 1 as const,
      positions: {},
      id: 'w',
      idEdited: false,
      description: '',
      source: { kind: 'inline' as const, definition: createBlankWorkflow() },
    }
    expect(workflowDraftWriteFailed(key)).toBe(false)
    writeWorkflowDraft(key, draft)
    expect(workflowDraftWriteFailed(key)).toBe(true)
    expect(notified).toBe(1)
    // The same outcome again does not notify.
    writeWorkflowDraft(key, draft)
    expect(notified).toBe(1)
    refuse = false
    writeWorkflowDraft(key, draft)
    expect(workflowDraftWriteFailed(key)).toBe(false)
    expect(notified).toBe(2)
    expect(readWorkflowDraft(key)?.id).toBe('w')
    refuse = true
    expect(discardWorkflowDraft(key)).toBe(false)
    expect(workflowDraftWriteFailed(key)).toBe(true)
    refuse = false
    expect(discardWorkflowDraft(key)).toBe(true)
    expect(readWorkflowDraft(key)).toBeUndefined()
  } finally {
    unsubscribe()
    globalThis.localStorage = original
    await dom.cleanup()
  }
})
