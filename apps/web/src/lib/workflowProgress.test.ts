import { describe, expect, it } from 'bun:test'
import type { WorkflowAttempt, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkStreamWait } from '@ficus/shared'
import {
  workflowListOrder,
  workflowProgress,
  workflowStepDisplayName,
  type WorkflowProgressContext,
} from './workflowProgress'

const agent = (id: string, participant: string, outcomes: WorkflowStep['outcomes'], name?: string): WorkflowStep =>
  ({
    id,
    kind: 'agent',
    participant,
    instructions: 'Do it.',
    output: 'Evidence.',
    outcomes,
    ...(name ? { name } : {}),
  }) as WorkflowStep

const approval = (id: string, outcomes: WorkflowStep['outcomes']): WorkflowStep =>
  ({
    id,
    kind: 'human-approval',
    approver: 'assigned-reviewers',
    instructions: 'Decide.',
    output: 'A decision.',
    outcomes,
  }) as WorkflowStep

function definition(steps: WorkflowStep[], entry = steps[0]!.id): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'Test flow',
    participants: {
      architect: { agentTypeId: 'architect', session: 'reuse-within-stream' },
      engineer: { agentTypeId: 'engineer', session: 'reuse-within-stream' },
      reviewer: { agentTypeId: 'reviewer', session: 'reuse-within-stream' },
    },
    entry,
    routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
    limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
    steps,
    completion: { mode: 'pr-auto-merge' },
  }
}

// The Planned Coding preset: design → implement → review, with rework edges back.
const planned = definition([
  agent('design', 'architect', { completed: { next: 'implement' } }),
  agent('implement', 'engineer', { completed: { next: 'review' }, 'redesign-needed': { returnTo: 'design' } }),
  agent('review', 'reviewer', {
    approved: { next: 'finish' },
    'changes-requested': { returnTo: 'implement' },
    'redesign-needed': { returnTo: 'design' },
  }),
])

function run(
  def: WorkflowDefinition,
  attempts: Array<Partial<WorkflowAttempt>>,
  extra: Partial<WorkflowRun> = {}
): WorkflowRun {
  return {
    schemaVersion: 1,
    version: 1,
    definition: def,
    status: 'running',
    activeAttemptId: null,
    attempts: attempts.map((attempt, index) => ({ id: index + 1, status: 'completed', ...attempt }) as WorkflowAttempt),
    returns: [],
    completedStepIds: [],
    ...extra,
  }
}

const context = (extra: Partial<WorkflowProgressContext> = {}): WorkflowProgressContext => ({
  status: 'active',
  openWaits: [],
  attemptAgents: {},
  ...extra,
})

const states = (progress: ReturnType<typeof workflowProgress>) =>
  progress.steps.map((step) => [step.id, step.state, step.label])

describe('workflowListOrder', () => {
  it('lists a chain in forward order and ignores rework edges', () => {
    expect(workflowListOrder(planned.steps, planned.entry)?.map((entry) => entry.id)).toEqual([
      'design',
      'implement',
      'review',
    ])
  })

  it('lists a loop back to an earlier step once', () => {
    const looped = definition([
      agent('implement', 'engineer', { completed: { next: 'review' } }),
      agent('review', 'reviewer', { approved: { next: 'finish' }, 'changes-requested': { next: 'implement' } }),
    ])
    expect(workflowListOrder(looped.steps, looped.entry)?.map((entry) => entry.id)).toEqual(['implement', 'review'])
  })

  it('keeps an early finish in the list: it ends the work, it does not branch it', () => {
    const gated = definition([
      approval('triage', { approved: { next: 'implement' }, rejected: { next: 'finish' } }),
      agent('implement', 'engineer', { completed: { next: 'finish' } }),
    ])
    expect(workflowListOrder(gated.steps, gated.entry)?.map((entry) => entry.id)).toEqual(['triage', 'implement'])
  })

  it('lists parallel branches together, marked, then continues at the join', () => {
    const forked = definition([
      agent('plan', 'architect', { completed: { parallel: ['web', 'api'], join: 'review' } }),
      agent('web', 'engineer', { completed: { next: 'review' } }),
      agent('api', 'engineer', { completed: { next: 'review' } }),
      agent('review', 'reviewer', { approved: { next: 'finish' } }),
    ])
    expect(workflowListOrder(forked.steps, forked.entry)).toEqual([
      { id: 'plan', parallel: false },
      { id: 'web', parallel: true },
      { id: 'api', parallel: true },
      { id: 'review', parallel: false },
    ])
  })

  it('refuses true alternatives: one step choosing between two unlisted steps', () => {
    const branching = definition([
      approval('route', { small: { next: 'quick-fix' }, large: { next: 'design' } }),
      agent('quick-fix', 'engineer', { completed: { next: 'finish' } }),
      agent('design', 'architect', { completed: { next: 'finish' } }),
    ])
    expect(workflowListOrder(branching.steps, branching.entry)).toBeNull()
  })
})

describe('workflowProgress', () => {
  it('shows done, active and upcoming steps with who does each', () => {
    const progress = workflowProgress(
      run(planned, [{ stepId: 'design' }, { stepId: 'implement', status: 'running', sourceAttemptIds: [1] }], {
        completedStepIds: ['design'],
      }),
      context({ attemptAgents: { '2': 'agent-engineer' } })
    )
    expect(progress.kind).toBe('list')
    expect(states(progress)).toEqual([
      ['design', 'done', 'Done'],
      ['implement', 'active', 'In progress'],
      ['review', 'upcoming', 'Upcoming'],
    ])
    expect(progress.steps.map((step) => step.who)).toEqual(['Architect', 'Engineer', 'Reviewer'])
    expect(progress.steps[1]!.agentId).toBe('agent-engineer')
  })

  it('marks a step sent back by review as returned for rework, and the reviewer as running again', () => {
    const progress = workflowProgress(
      run(
        planned,
        [
          { stepId: 'design' },
          { stepId: 'implement', sourceAttemptIds: [1] },
          { stepId: 'review', status: 'returned', sourceAttemptIds: [2] },
          { stepId: 'implement', status: 'running', sourceAttemptIds: [3] },
        ],
        { completedStepIds: ['design', 'implement'] }
      ),
      context()
    )
    expect(states(progress)).toEqual([
      ['design', 'done', 'Done'],
      ['implement', 'rework', 'Returned for rework'],
      ['review', 'upcoming', 'Sent back; runs again'],
    ])
  })

  it('says a running step waits when it has an open wait', () => {
    const wait = { id: 'w', type: 'question', flowAttemptId: 1 } as WorkStreamWait
    const progress = workflowProgress(
      run(planned, [{ stepId: 'design', status: 'running' }]),
      context({ openWaits: [wait] })
    )
    expect(states(progress)[0]).toEqual(['design', 'waiting', 'Waiting for input'])
  })

  it('says a human approval waits for review', () => {
    const gated = definition([
      agent('implement', 'engineer', { completed: { next: 'approve' } }),
      approval('approve', { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } }),
    ])
    const wait = { id: 'w', type: 'review', flowAttemptId: 2 } as WorkStreamWait
    const progress = workflowProgress(
      run(gated, [{ stepId: 'implement' }, { stepId: 'approve', status: 'running', sourceAttemptIds: [1] }], {
        completedStepIds: ['implement'],
      }),
      context({ openWaits: [wait], hasAssignedReviewers: true })
    )
    expect(states(progress)[1]).toEqual(['approve', 'waiting', 'Waiting for review'])
    expect(progress.steps[1]!.who).toBe('Assigned reviewer')
  })

  it('says steps that never ran were not run once the stream is done', () => {
    const progress = workflowProgress(
      run(planned, [{ stepId: 'design' }], { completedStepIds: ['design'] }),
      context({ status: 'done' })
    )
    expect(states(progress).map(([, state]) => state)).toEqual(['done', 'not-run', 'not-run'])
  })

  it('falls back to the current steps when the flow cannot be listed honestly', () => {
    const branching = definition([
      approval('route', { small: { next: 'quick-fix' }, large: { next: 'design' } }),
      agent('quick-fix', 'engineer', { completed: { next: 'finish' } }),
      agent('design', 'architect', { completed: { next: 'finish' } }),
    ])
    const progress = workflowProgress(
      run(branching, [{ stepId: 'route' }, { stepId: 'design', status: 'running', sourceAttemptIds: [1] }], {
        completedStepIds: ['route'],
      }),
      context()
    )
    expect(progress).toMatchObject({ kind: 'current', total: 3, done: 1 })
    expect(states(progress)).toEqual([['design', 'active', 'In progress']])
  })

  it('starts a fresh pass after a reopen', () => {
    const progress = workflowProgress(
      run(
        planned,
        [{ stepId: 'design' }, { stepId: 'implement' }, { stepId: 'review' }, { stepId: 'design', status: 'running' }],
        {
          attemptEpoch: 3,
        }
      ),
      context()
    )
    expect(states(progress).map(([, state]) => state)).toEqual(['active', 'upcoming', 'upcoming'])
  })
})

describe('workflowStepDisplayName', () => {
  it('prefers the display name, else sentence-cases the ID', () => {
    expect(workflowStepDisplayName({ id: 'design-approval' })).toBe('Design approval')
    expect(workflowStepDisplayName({ id: 'x', name: 'Your approval to release' })).toBe('Your approval to release')
  })
})
