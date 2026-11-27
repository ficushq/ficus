import { describe, expect, it } from 'bun:test'
import type { WorkflowAttempt, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkStreamWait } from '@ficus/shared'
import { workflowDefinitionSchema } from '@ficus/shared'
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

const approval = (
  id: string,
  outcomes: WorkflowStep['outcomes'],
  approver: 'assigned-reviewers' | 'reviewers' = 'assigned-reviewers'
): WorkflowStep =>
  ({
    id,
    kind: 'human-approval',
    approver,
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
    // A flow loops back only through a rework edge: a forward `next` to an earlier step is a cycle
    // the definition schema rejects.
    const looped = definition([
      agent('implement', 'engineer', { completed: { next: 'review' } }),
      agent('review', 'reviewer', { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } }),
    ])
    expect(workflowDefinitionSchema.safeParse(looped).error).toBeUndefined()
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
      context({ openWaits: [wait], assignedReviewerIds: ['user-ana'] })
    )
    expect(states(progress)[1]).toEqual(['approve', 'waiting', 'Waiting for review'])
    // The reviewers' names are not known yet.
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

describe('workflowProgress: steps that run again', () => {
  // design → implement → review → security, where security can send work back to implement.
  const audited = definition([
    agent('design', 'architect', { completed: { next: 'implement' } }),
    agent('implement', 'engineer', { completed: { next: 'review' } }),
    agent('review', 'reviewer', { approved: { next: 'security' }, 'changes-requested': { returnTo: 'implement' } }),
    agent('security', 'reviewer', { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } }),
  ])
  const passed = [
    { stepId: 'design' },
    { stepId: 'implement', sourceAttemptIds: [1] },
    { stepId: 'review', sourceAttemptIds: [2] },
    { stepId: 'security', status: 'returned' as const, sourceAttemptIds: [3] },
    { stepId: 'implement', status: 'running' as const, sourceAttemptIds: [4] },
  ]

  it('says a completed step between the rework and the step that sent it back runs again', () => {
    const progress = workflowProgress(
      run(audited, passed, { completedStepIds: ['design', 'implement', 'review'] }),
      context()
    )
    expect(states(progress)).toEqual([
      ['design', 'done', 'Done'],
      ['implement', 'rework', 'Returned for rework'],
      ['review', 'upcoming', 'Runs again'],
      ['security', 'upcoming', 'Sent back; runs again'],
    ])
  })

  it('keeps the steps in between done when the correction goes straight back to the requester', () => {
    const progress = workflowProgress(
      run(audited, passed, {
        completedStepIds: ['design', 'implement', 'review'],
        returns: [
          {
            id: 1,
            requestedByAttemptId: 4,
            targetStepId: 'implement',
            resumeAt: 'security',
            direct: true,
            parentId: null,
            feedback: 'Fix the token check.',
            status: 'open',
          },
        ],
      }),
      context()
    )
    expect(states(progress)).toEqual([
      ['design', 'done', 'Done'],
      ['implement', 'rework', 'Returned for rework'],
      ['review', 'done', 'Done'],
      ['security', 'upcoming', 'Sent back; runs again'],
    ])
  })

  it('follows nested direct returns back to the outermost requester, skipping the steps between', () => {
    // security sent work straight back to implement; implement then sent it straight back to design.
    const progress = workflowProgress(
      run(
        audited,
        [
          { stepId: 'design' },
          { stepId: 'implement', sourceAttemptIds: [1] },
          { stepId: 'review', sourceAttemptIds: [2] },
          { stepId: 'security', status: 'returned', sourceAttemptIds: [3] },
          { stepId: 'implement', status: 'returned', sourceAttemptIds: [4] },
          { stepId: 'design', status: 'running', sourceAttemptIds: [5] },
        ],
        {
          completedStepIds: ['design', 'implement', 'review'],
          returns: [
            {
              id: 1,
              requestedByAttemptId: 4,
              targetStepId: 'implement',
              resumeAt: 'security',
              direct: true,
              parentId: null,
              feedback: 'Fix the token check.',
              status: 'open',
            },
            {
              id: 2,
              requestedByAttemptId: 5,
              targetStepId: 'design',
              resumeAt: 'implement',
              direct: true,
              parentId: 1,
              feedback: 'The token design cannot support this.',
              status: 'open',
            },
          ],
        }
      ),
      context()
    )
    expect(states(progress)).toEqual([
      ['design', 'rework', 'Returned for rework'],
      ['implement', 'upcoming', 'Sent back; runs again'],
      ['review', 'done', 'Done'],
      ['security', 'upcoming', 'Sent back; runs again'],
    ])
  })

  it('shows a canceled stream as it stopped: done steps stay done, the running one stopped, the rest not run', () => {
    const progress = workflowProgress(
      run(audited, passed, { completedStepIds: ['design', 'implement', 'review'] }),
      context({ status: 'canceled' })
    )
    expect(states(progress)).toEqual([
      ['design', 'done', 'Done'],
      ['implement', 'not-run', 'Stopped'],
      ['review', 'done', 'Done'],
      ['security', 'not-run', 'Not run'],
    ])
  })
})

describe('workflowProgress: who decides an approval', () => {
  const gated = (approver: 'assigned-reviewers' | 'reviewers') =>
    definition([
      agent('implement', 'engineer', { completed: { next: 'approve' } }),
      approval('approve', { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } }, approver),
    ])
  const waiting = (approver: 'assigned-reviewers' | 'reviewers' = 'assigned-reviewers') =>
    run(gated(approver), [{ stepId: 'implement' }, { stepId: 'approve', status: 'running', sourceAttemptIds: [1] }], {
      completedStepIds: ['implement'],
    })
  const viewer = (userId: string, permissions = ['workstreams:review']) => ({
    can: (permission: string) => permissions.includes(permission),
    identity: { type: 'user', userId },
  })
  // The squad's reviewer list labels people as "Display Name (email)", or a bare email without a name.
  const reviewers = [
    { id: 'user-ana', name: 'Ana Lima (ana.lima@example.com)' },
    { id: 'user-ben', name: 'Ben Okafor (ben.okafor@example.com)' },
    { id: 'user-cy', name: 'cy@example.com' },
    { id: 'user-dee', name: 'Dee (Design) Park (dee@example.com)' },
  ]
  const who = (flow: WorkflowRun, extra: Partial<WorkflowProgressContext>) =>
    workflowProgress(flow, context(extra)).steps.find((step) => step.id === 'approve')!.who

  it('says "You" to an assigned reviewer with review permission, and names the reviewers to anyone else', () => {
    const assigned = { assignedReviewerIds: ['user-ana', 'user-ben'], reviewers }
    // Another assigned reviewer can decide too, so they are named beside "You".
    expect(who(waiting(), { ...assigned, viewer: viewer('user-ana') })).toBe('You or Ben Okafor')
    expect(who(waiting(), { assignedReviewerIds: ['user-ana'], reviewers, viewer: viewer('user-ana') })).toBe('You')
    expect(who(waiting(), { ...assigned, viewer: viewer('user-cy') })).toBe('Ana Lima or Ben Okafor')
    // Assigned, but without review permission: Core would refuse the decision.
    expect(who(waiting(), { ...assigned, viewer: viewer('user-ana', ['workstreams:update']) })).toBe(
      'Ana Lima or Ben Okafor'
    )
    // Permissions still loading never claim the viewer.
    expect(who(waiting(), assigned)).toBe('Ana Lima or Ben Okafor')
  })

  it('says "You" to any reviewer when nobody is assigned or the step takes any reviewer', () => {
    expect(who(waiting(), { viewer: viewer('user-cy'), reviewers })).toBe('You')
    expect(who(waiting('reviewers'), { assignedReviewerIds: ['user-ana'], viewer: viewer('user-cy'), reviewers })).toBe(
      'You'
    )
    expect(who(waiting('reviewers'), { assignedReviewerIds: ['user-ana'], reviewers })).toBe('Reviewer')
  })

  it('names the only person who can review when anyone with review permission decides', () => {
    expect(who(waiting(), { reviewers: [reviewers[0]!] })).toBe('Ana Lima')
    // Without a display name, the part of the email before the @.
    expect(who(waiting(), { reviewers: [reviewers[2]!] })).toBe('cy')
    expect(who(waiting(), { reviewers })).toBe('Reviewer')
    expect(who(waiting(), {})).toBe('Reviewer')
  })

  it('lists up to three assigned reviewers by name and counts the rest', () => {
    const ids = (count: number) => reviewers.slice(0, count).map((person) => person.id)
    expect(who(waiting(), { assignedReviewerIds: ids(1), reviewers })).toBe('Ana Lima')
    expect(who(waiting(), { assignedReviewerIds: ids(3), reviewers })).toBe('Ana Lima, Ben Okafor or cy')
    expect(who(waiting(), { assignedReviewerIds: ids(4), reviewers })).toBe('Ana Lima, Ben Okafor or 2 others')
    expect(who(waiting(), { assignedReviewerIds: ['user-dee'], reviewers })).toBe('Dee (Design) Park')
    // A reviewer who has lost review permission is no longer listed by the squad: count, do not name.
    expect(who(waiting(), { assignedReviewerIds: ['user-ana', 'user-gone'], reviewers })).toBe('Ana Lima or 1 other')
    expect(who(waiting(), { assignedReviewerIds: ['user-gone'], reviewers })).toBe('Assigned reviewer')
  })

  it('does not say "You" for an approval already decided: Ficus does not record who decided it', () => {
    const decided = run(gated('assigned-reviewers'), [{ stepId: 'implement' }, { stepId: 'approve' }], {
      completedStepIds: ['implement', 'approve'],
    })
    expect(who(decided, { assignedReviewerIds: ['user-ana'], reviewers, viewer: viewer('user-ana') })).toBe('Ana Lima')
    expect(who(decided, { viewer: viewer('user-ana'), reviewers })).toBe('Reviewer')
  })
})

describe('workflowStepDisplayName', () => {
  it('prefers the display name, else sentence-cases the ID', () => {
    expect(workflowStepDisplayName({ id: 'design-approval' })).toBe('Design approval')
    expect(workflowStepDisplayName({ id: 'x', name: 'Your approval to release' })).toBe('Your approval to release')
  })
})
