import { describe, expect, test } from 'bun:test'
import type { PendingAction, WorkStreamDeliveryActionData } from '@ficus/shared'
import { otherAction, questionAction, waitAction } from './needsYouNotices.fixtures'
import { pendingActionAgentLabel, pendingActionContextLine, pendingActionWaitPhrase } from './pendingActionWording'

function deliveryAction(deliveryKind: 'review' | 'merge'): PendingAction {
  return {
    ...otherAction('workstream-delivery', 'ws-uuid-8'),
    data: {
      workStreamId: 'ws-uuid-8',
      workStreamNumber: 8,
      workStreamTitle: '#8 · Make every payment retry safe',
      squadId: 'squad-1',
      squadName: 'Product Engineering',
      deliveryKind,
      pullRequests: [],
      focus: { kind: 'workstream', workStreamId: 'ws-uuid-8' },
    } satisfies WorkStreamDeliveryActionData,
  }
}

describe('pendingActionWaitPhrase', () => {
  test('a routine review or approval is never called blocked', () => {
    // A workflow approval gate arrives as `workstream-blocked`; the Assistant used to print its type.
    const gate = waitAction('gate', {
      type: 'workstream-blocked',
      wait: { type: 'manual', workflowHumanGate: true, resolutionHandler: 'workflow' },
    })
    expect(pendingActionWaitPhrase(gate)).toBe('review needed')
    expect(pendingActionWaitPhrase(waitAction('review'))).toBe('review needed')
    const delivery = waitAction('delivery', { type: 'workstream-blocked' }, { deliveryApproval: true })
    expect(pendingActionWaitPhrase(delivery)).toBe('approve delivery')
    const decision = waitAction('decision', { type: 'workstream-blocked', wait: { resolutionHandler: 'workflow' } })
    expect(pendingActionWaitPhrase(decision)).toBe('decision needed')
    for (const action of [gate, delivery, decision]) expect(pendingActionWaitPhrase(action)).not.toContain('blocked')
  })

  test('"blocked" is kept for a manual hold a person must clear', () => {
    expect(pendingActionWaitPhrase(waitAction('hold', { type: 'workstream-blocked' }))).toBe('blocked on your input')
    expect(pendingActionWaitPhrase(waitAction('owner', { type: 'workstream-blocked', wait: { actor: 'owner' } }))).toBe(
      'waiting on owner'
    )
  })

  test('questions, pull request gates and halts each have one phrase', () => {
    expect(pendingActionWaitPhrase(questionAction('q'))).toBe('needs your answer')
    expect(pendingActionWaitPhrase(otherAction('squad-question', 'agent-1'))).toBe('needs your answer')
    expect(pendingActionWaitPhrase(otherAction('assistant-needs-input', 'task-1'))).toBe('needs your answer')
    expect(pendingActionWaitPhrase(deliveryAction('review'))).toBe('review pull request')
    expect(pendingActionWaitPhrase(deliveryAction('merge'))).toBe('merge pull request')
    expect(pendingActionWaitPhrase(otherAction('agent-error', 'agent-1'))).toBe('agent halted')
  })
})

describe('pendingActionAgentLabel', () => {
  test('names a question asker by type and the work stream it asked from, never by name', () => {
    expect(pendingActionAgentLabel(questionAction('q'))).toBe('Engineer (#8)')
    expect(pendingActionAgentLabel(questionAction('q', {}, { workStream: undefined }))).toBe('Engineer')
  })

  test('names a work stream assignee by type, and not at all when an older server sends no type', () => {
    expect(pendingActionAgentLabel(waitAction('r'))).toBe('Engineer')
    expect(pendingActionAgentLabel(waitAction('r', {}, { assigneeAgentTypeId: undefined }))).toBeNull()
  })

  test('uses the configured type name when it is known', () => {
    const typeNames = (id: string) => (id === 'engineer' ? 'Builder' : undefined)
    expect(pendingActionAgentLabel(questionAction('q'), typeNames)).toBe('Builder (#8)')
    expect(pendingActionAgentLabel(waitAction('r'), typeNames)).toBe('Builder')
    expect(pendingActionContextLine(waitAction('r', {}, { assigneeAgentTypeId: 'engineer' }), typeNames)).toBe(
      'Product Engineering · Builder · review needed'
    )
  })
})

describe('pendingActionContextLine', () => {
  test('reads squad, agent and wait for a work stream, and squad and wait when the title names the agent', () => {
    expect(pendingActionContextLine(waitAction('r', {}, { assigneeAgentTypeId: 'engineer' }))).toBe(
      'Product Engineering · Engineer · review needed'
    )
    expect(pendingActionContextLine(questionAction('q'))).toBe('Product Engineering · needs your answer')
    expect(pendingActionContextLine(otherAction('agent-error', 'agent-1'))).toBe('Agent halted')
  })
})
