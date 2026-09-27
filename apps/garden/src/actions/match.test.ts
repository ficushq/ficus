import { describe, expect, it } from 'bun:test'
import type { PendingAction } from '@ficus/shared'
import {
  agentErrorAction,
  agentQuestionAction,
  assistantAction,
  squadQuestionAction,
  streamAction,
  wait,
} from './fixtures'
import { actionsForAgent, actionsForStream, typedAction } from './match'
import { actionSubtitle, actionTitle, groupActions } from './present'

const ids = (actions: PendingAction[]) => actions.map((action) => action.id)

const review = streamAction('review')
const otherStreamBlocked = streamAction(
  'blocked',
  { id: 'wait-9', workStreamId: 'ws-2', createdByAgentId: 'agent-7' },
  { assigneeAgentId: 'agent-8', assigneeName: null }
)
const squadQ = squadQuestionAction()
const agentQ = agentQuestionAction()
const halted = agentErrorAction('agent-3')
const assistant = assistantAction()
const all = [review, otherStreamBlocked, squadQ, agentQ, halted, assistant]

describe('actionsForStream', () => {
  it('matches review and blocked waits by workStreamId', () => {
    expect(ids(actionsForStream(all, 'ws-1'))).toEqual([review.id])
    expect(ids(actionsForStream(all, 'ws-2'))).toEqual([otherStreamBlocked.id])
    expect(actionsForStream(all, 'ws-404')).toEqual([])
  })

  it("adds agent questions the stream's question waits point at", () => {
    const openWaits = [wait({ id: 'wq', type: 'question', referenceId: 'q-1' })]
    expect(ids(actionsForStream(all, 'ws-1', { openWaits }))).toEqual([review.id, agentQ.id])
    expect(ids(actionsForStream(all, 'ws-1', { openWaits: [wait({ type: 'question', referenceId: 'q-x' })] }))).toEqual(
      [review.id]
    )
  })
})

describe('actionsForAgent', () => {
  it('matches questions, halts and assistant tasks by agentId', () => {
    expect(ids(actionsForAgent(all, 'agent-2', { direct: true }))).toEqual([agentQ.id])
    expect(ids(actionsForAgent(all, 'agent-3', { direct: true }))).toEqual([halted.id])
    expect(ids(actionsForAgent(all, 'agent-9', { direct: true }))).toEqual([assistant.id])
  })

  it('includes stream waits the robot is assigned to or opened unless direct', () => {
    // agent-1 asked the squad question and is the assignee (and wait opener) on ws-1's review.
    expect(ids(actionsForAgent(all, 'agent-1'))).toEqual([review.id, squadQ.id])
    expect(ids(actionsForAgent(all, 'agent-1', { direct: true }))).toEqual([squadQ.id])
    expect(ids(actionsForAgent(all, 'agent-7'))).toEqual([otherStreamBlocked.id])
    expect(ids(actionsForAgent(all, 'agent-8'))).toEqual([otherStreamBlocked.id])
  })

  it('ignores unknown action types', () => {
    const future = { ...halted, id: 'future:1', type: 'robot-sings' } as unknown as PendingAction
    expect(typedAction(future).type).toBe('unknown')
    expect(actionsForAgent([future], 'agent-3')).toEqual([])
    expect(actionsForStream([future], 'ws-1')).toEqual([])
  })
})

describe('presentation', () => {
  it('titles actions like the web', () => {
    expect(actionTitle(review)).toBe('Grow tomatoes')
    expect(actionTitle(assistant)).toBe('Book the barn')
    expect(actionTitle(agentQ)).toBe('Bean')
    expect(actionTitle(squadQ)).toBe('Veg Squad')
  })

  it('says plainly what each needs', () => {
    expect(actionSubtitle(squadQ)).toBe('Sprout · needs your input')
    expect(actionSubtitle(agentQ)).toBe('Veg Squad · Needs your answer')
    expect(
      actionSubtitle(
        agentQuestionAction(
          {},
          {
            answerDelivery: {
              status: 'failed',
              generation: 1,
              attemptCount: 3,
              nextAttemptAt: null,
              lastError: 'x',
              deliveredAt: null,
              canRetry: true,
            },
          }
        )
      )
    ).toBe('Veg Squad · Answer delivery failed')
    expect(actionSubtitle(halted)).toBe('Veg Squad · Robot halted')
    expect(actionSubtitle(review)).toBe('Veg Squad · Sprout requests review')
    expect(actionSubtitle(otherStreamBlocked)).toBe('Veg Squad · agent-8 needs input')
    expect(actionSubtitle(streamAction('blocked', { resolutionHandler: 'workflow', flowAttemptId: 2 }))).toBe(
      'Veg Squad · review needed'
    )
    expect(actionSubtitle(streamAction('blocked', { resolutionHandler: 'workflow' }))).toBe(
      'Veg Squad · workflow decision'
    )
  })

  it('groups in the web order, newest first within a group', () => {
    const older = agentErrorAction('agent-4', { createdAt: '2026-09-26T10:00:00.000Z' })
    const newer = agentErrorAction('agent-5', { createdAt: '2026-09-27T12:00:00.000Z' })
    const future = { ...halted, id: 'future:1', type: 'robot-sings' } as unknown as PendingAction
    const groups = groupActions([future, review, otherStreamBlocked, assistant, agentQ, older, newer, squadQ])
    expect(groups.map((group) => group.id)).toEqual(['halted', 'questions', 'assistant', 'harvest', 'weeds', 'other'])
    expect(ids(groups[0]!.actions)).toEqual([newer.id, older.id])
    expect(ids(groups[1]!.actions)).toEqual([agentQ.id, squadQ.id])
    expect(groupActions([])).toEqual([])
  })
})
