/**
 * Every surface that says who decides a workflow gate agrees, because they all use the shared
 * mayDecideWorkflowGate rule Core enforces: the row time and the detail header (workStreamPersonWait),
 * Progress (workflowProgress), the review screen (humanGateContext) and the peek card
 * (workStreamPeekFacts). Checked for the squad owner, an assigned reviewer, a reviewer who is not
 * assigned and a viewer with no rights, on a gate for any reviewer and one for assigned reviewers.
 */
import { describe, expect, test } from 'bun:test'
import {
  advanceWorkflowRun,
  createBlankWorkflow,
  createWorkflowRun,
  workflowDefinitionSchema,
  type WorkflowGateApprover,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { workStreamPeekFacts } from '../components/WorkStreamSummary'
import { workflowProgress } from './workflowProgress'
import { humanGateContext } from './workflowReview'
import { workStreamPersonWait, type WorkStreamViewer } from './workStreamRuntime'

/** execute (agent) → design-approval (human approval with this approver), waiting on the approval. */
function gatedRun(approver: WorkflowGateApprover) {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = { completed: { next: 'design-approval' } }
  definition.steps.push({
    id: 'design-approval',
    kind: 'human-approval',
    approver,
    instructions: 'Approve the design.',
    output: 'A decision.',
    outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'execute' } },
  })
  const state = advanceWorkflowRun(createWorkflowRun(workflowDefinitionSchema.parse(definition)), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Designed.',
    decisionBrief: {
      decision: 'Approve the design for the new settings page.',
      recommendation: 'Approve it, because the design covers every requirement.',
      approvalEffect: 'Approval finishes the work on this stream.',
      risks: 'There are no known risks beyond the usual review effort.',
    },
  })
  const gateWait: WorkStreamWait = {
    id: 'gate',
    workStreamId: 'ws-1',
    type: 'manual',
    flowAttemptId: 2,
    resolutionHandler: 'workflow',
    workflowHumanGate: true,
    workflowGateApprover: approver,
    referenceId: 'gate-reference',
    message: null,
    createdBy: 'system',
    createdByAgentId: null,
    createdByUserId: null,
    completesOnApproval: true,
    openedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    closedAt: null,
    resolution: null,
    resolutionNote: null,
  }
  const stream = {
    id: 'ws-1',
    squadId: 'squad-1',
    status: 'active',
    derivedState: 'in_review',
    assignedReviewerIds: ['assigned'],
    openWaits: [gateWait],
    metadata: {},
  } as unknown as WorkStream
  const run = { state, version: state.version, openWaits: [gateWait] } as unknown as WorkflowRunDetail
  return { stream, run }
}

const viewers: Record<string, WorkStreamViewer> = {
  // The squad owner holds every permission, review included.
  owner: { can: () => true, identity: { type: 'user', userId: 'owner' } },
  'assigned reviewer': {
    can: (permission) => permission === 'workstreams:review',
    identity: { type: 'user', userId: 'assigned' },
  },
  'unassigned reviewer': {
    can: (permission) => permission === 'workstreams:review',
    identity: { type: 'user', userId: 'unassigned' },
  },
  'viewer with no rights': { can: () => false, identity: { type: 'user', userId: 'reader' } },
}

/** What each surface tells this viewer about the open gate. */
function surfaces(approver: WorkflowGateApprover, viewer: WorkStreamViewer) {
  const { stream, run } = gatedRun(approver)
  const gate = run.state.attempts[1]!
  return {
    row: workStreamPersonWait(stream, viewer)?.label,
    progress: workflowProgress(run.state, {
      status: 'active',
      openWaits: run.openWaits!,
      attemptAgents: {},
      assignedReviewerIds: stream.assignedReviewerIds,
      viewer,
    }).steps.find((step) => step.id === 'design-approval')?.who,
    reviewScreen: humanGateContext(stream, run, gate, viewer)?.canDecide,
    peek: workStreamPeekFacts(stream, viewer).waitLabel,
  }
}

const yours = { row: 'Waiting on you', progress: 'You', reviewScreen: true, peek: 'Waiting on you: review' }
const notYours = (progress: string) => ({
  row: 'Waiting on review',
  progress,
  reviewScreen: false,
  peek: 'Waiting on review',
})

describe('a gate any reviewer decides (approver: reviewers), on a stream with an assigned reviewer', () => {
  test.each([
    ['owner', yours],
    ['assigned reviewer', yours],
    // The case the rows and header used to get wrong: not assigned, but the step takes any reviewer.
    ['unassigned reviewer', yours],
    ['viewer with no rights', notYours('Reviewer')],
  ])('%s', (name, expected) => {
    expect(surfaces('reviewers', viewers[name]!)).toEqual(expected)
  })
})

describe('a gate for the assigned reviewers (approver: assigned-reviewers)', () => {
  test.each([
    ['owner', notYours('Assigned reviewer')],
    ['assigned reviewer', yours],
    ['unassigned reviewer', notYours('Assigned reviewer')],
    ['viewer with no rights', notYours('Assigned reviewer')],
  ])('%s', (name, expected) => {
    expect(surfaces('assigned-reviewers', viewers[name]!)).toEqual(expected)
  })
})
