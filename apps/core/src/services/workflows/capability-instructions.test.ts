import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  advanceWorkflowRun,
  createBlankWorkflow,
  createWorkflowRun,
  workflowCommandSchema,
  workflowPresetSchema,
  type WorkflowRun,
} from '@ficus/shared'
import { flowCapabilityInstructions } from './capability-instructions'

test('Solo assignments explicitly disable delegation and require management for live revisions', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  const message = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(message).toContain('Delegation: disabled')
  expect(message).toContain('flow-management permission is required')
  expect(message).not.toContain('"action": "delegate"')
  expect(message).toContain('completed: delivery policy')
})

test('adaptive assignments explain their remaining budget and include a valid versioned delegation command', () => {
  const definition = createBlankWorkflow()
  definition.routing = { mode: 'adaptive', returnTo: 'earlier-steps', delegation: 'allowed' }
  definition.limits.maxDelegations = 3
  const run = createWorkflowRun(definition)
  run.delegationCount = 1
  const message = flowCapabilityInstructions(run, run.attempts[0]!, 7)
  expect(message).toContain('2 of 3 specialist assignments remain')
  expect(message).toContain('active=keep')
  expect(message).toContain('do not increase limits')
  expect(message).not.toContain('COMMAND.json')
  expect(message).toContain('--content')
  expect(message).toContain("ficus workstream advance STREAM_ID --stdin <<'FICUS_COMMAND'")
  const example = JSON.parse(message.match(/<<'FICUS_COMMAND'\n([\s\S]*?)\nFICUS_COMMAND/)![1]!)
  expect(workflowCommandSchema.parse(example)).toMatchObject({ action: 'delegate', expectedVersion: 7, attemptId: 1 })
  run.delegationCount = 3
  const exhausted = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(exhausted).toContain('Delegation: budget exhausted')
  expect(exhausted).not.toContain('"action": "delegate"')
})

test('handoff guidance uses the current attempt snapshot when future routing has been revised', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  run.definition.steps[0]!.outcomes = { revised: { next: 'future' } }
  const message = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(message).toContain('completed: delivery policy')
  expect(message).not.toContain('revised: future')
})

test('additional returns follow graph predecessors rather than definition array order', () => {
  const definition = createBlankWorkflow()
  const current = definition.steps[0]!
  definition.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
  definition.steps.push({ ...structuredClone(current), id: 'prepare', outcomes: { completed: { next: current.id } } })
  definition.entry = 'prepare'
  const initial = createWorkflowRun(definition)
  const run = advanceWorkflowRun(initial, {
    expectedVersion: initial.version,
    attemptId: initial.activeAttemptId,
    action: 'complete',
    outcome: 'completed',
    evidence: 'Preparation verified',
  })
  const attempt = run.attempts.find((attempt) => attempt.id === run.activeAttemptId)!
  expect(flowCapabilityInstructions(run, attempt)).toContain('Additional return targets: prepare.')
})

test('keep revisions explain effective outcomes while preserving the original brief', () => {
  const initial = createWorkflowRun(createBlankWorkflow())
  const run = advanceWorkflowRun(initial, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'keep',
    reason: 'New verdict',
    operations: [
      {
        op: 'put-step',
        step: {
          ...initial.definition.steps[0]!,
          instructions: 'Future brief',
          outcomes: { waived: { next: 'finish' } },
        },
      },
    ],
  })
  const message = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(message).toContain('waived: delivery policy')
  expect(message).not.toContain('completed: delivery policy')
})

test('human-directed outcomes identify the producer-owned brief; agent-only outcomes do not', () => {
  const definition = createBlankWorkflow()
  const solo = createWorkflowRun(definition)
  expect(flowCapabilityInstructions(solo, solo.attempts[0]!)).not.toContain('a human decides next')
  expect(flowCapabilityInstructions(solo, solo.attempts[0]!)).not.toContain('action amend')
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    instructions: 'Review the design.',
    output: 'Decision.',
    outcomes: { approved: { next: 'finish' } },
    approver: 'reviewers',
  })
  const run = createWorkflowRun(definition)
  const text = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(text).toContain('a human decides next')
  expect(text).toContain('decisionBrief')
  expect(text).toContain('changesSinceLastReview')
  expect(text).toContain('producing agent')
  expect(text).toContain(
    'While that gate is open, the reviewer may chat with you from the review screen; refine your result only with action amend, and recommend Changes requested for anything bigger.'
  )
})

test('flexible explicit human returns explain authoring and include a schema-valid return example', () => {
  const definition = createBlankWorkflow()
  definition.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
  definition.entry = 'gate'
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    approver: 'reviewers',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'execute' } },
  })
  const run = advanceWorkflowRun(createWorkflowRun(definition), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'yes',
    evidence: '',
  })
  const attempt = run.attempts.at(-1)!
  const text = flowCapabilityInstructions(run, attempt)
  expect(text).toContain("For action=return to 'gate', a human decides next")
  expect(text).toContain('changesSinceLastReview is required')
  const example = workflowCommandSchema.parse(
    JSON.parse(text.match(/<<'FICUS_COMMAND'\n([\s\S]*?)\nFICUS_COMMAND/)![1]!)
  )
  expect(example.action).toBe('return')
  expect('targetStepId' in example && example.targetStepId).toBe('gate')
  expect(() => advanceWorkflowRun(run, example)).not.toThrow()
})

describe('delivery participant in the step handoff', () => {
  const root = resolve(import.meta.dir, '../../../../..')
  const preset = async (id: string) =>
    workflowPresetSchema.parse(Bun.YAML.parse(await Bun.file(`${root}/config/workflows/${id}.yaml`).text())).definition
  const complete = (run: WorkflowRun, outcome: string) =>
    advanceWorkflowRun(run, {
      expectedVersion: run.version,
      attemptId: run.activeAttemptId,
      action: 'complete',
      outcome,
      evidence: 'Done',
    })
  const running = (run: WorkflowRun) => run.attempts.find((attempt) => attempt.id === run.activeAttemptId)!

  test('in a With Review flow the reviewer is told it delivers on approval and the builder is not', async () => {
    const definition = await preset('builder-reviewer')
    definition.completion = { mode: 'pr-auto-merge', followChanges: true }
    const build = createWorkflowRun(definition)
    const builder = flowCapabilityInstructions(build, running(build))
    expect(builder).not.toContain('delivery participant for this stream')
    const review = complete(build, 'completed')
    const reviewer = flowCapabilityInstructions(review, running(review))
    expect(reviewer).toContain(
      "Delivery: if you complete with outcome 'approved', no later agent step runs before this flow reaches completion-ready, so you are the delivery participant for this stream (delivery policy: pr-auto-merge)."
    )
    expect(reviewer).toContain('including the delivery pull request’s merge and close events')
    expect(reviewer).toContain('finish the stream yourself; do not wait for another agent to deliver it')
    // A return outcome never makes the reviewer the delivery participant.
    expect(reviewer).not.toContain("'changes-requested'")
  })

  test('a Solo step delivers when it completes', () => {
    const run = createWorkflowRun(createBlankWorkflow())
    expect(flowCapabilityInstructions(run, run.attempts[0]!)).toContain(
      "Delivery: if you complete with outcome 'completed', no later agent step runs before this flow reaches completion-ready, so you are the delivery participant for this stream (delivery policy: deliverable)."
    )
  })

  test('only a later agent step takes delivery away; a human gate or a named change-event step does not', async () => {
    const definition = await preset('engineering-design-approval')
    const design = createWorkflowRun(definition)
    // The design step is followed by a human gate and then implementation by another agent.
    expect(flowCapabilityInstructions(design, running(design))).not.toContain('Delivery: if you complete')
    const gated = createBlankWorkflow()
    gated.steps[0]!.outcomes = { completed: { next: 'approve' } }
    gated.steps.push({
      id: 'approve',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Check it.',
      output: 'A verdict.',
      outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: gated.steps[0]!.id } },
    })
    const run = createWorkflowRun(gated)
    expect(flowCapabilityInstructions(run, running(run))).toContain(
      "Delivery: if you complete with outcome 'completed', no later agent step runs"
    )
    const reviewed = await preset('reviewed-coding')
    const review = complete(createWorkflowRun(reviewed), 'completed')
    const text = flowCapabilityInstructions(review, running(review))
    expect(text).toContain("Delivery: if you complete with outcome 'approved'")
    expect(text).toContain('Change events (CI results, reviews, comments) go to step implement instead')
  })

  test('review-approval leaves the finish to a human', () => {
    const definition = createBlankWorkflow()
    definition.completion = { mode: 'review-approval' }
    const run = createWorkflowRun(definition)
    const text = flowCapabilityInstructions(run, run.attempts[0]!)
    expect(text).toContain('a human approves and finishes delivery')
    expect(text).not.toContain('finish the stream yourself')
  })

  // Step IDs, kinds, participants and routing as shipped before the delivery wording was added.
  const shipped: Record<string, string> = {
    'builder-reviewer':
      'build:agent:builder:completed>review|review:agent:reviewer:approved>finish,changes-requested<build',
    'code-review': 'review:agent:reviewer:completed>finish',
    'engineering-design-approval':
      'design:agent:architect:completed>design-approval|design-approval:human-approval:-:approved>implement,changes-requested<design|implement:agent:engineer:completed>review|review:agent:reviewer:approved>finish,changes-requested<implement',
    engineering:
      'design:agent:architect:completed>implement|implement:agent:engineer:completed>review,redesign-needed<design|review:agent:reviewer:approved>finish,changes-requested<implement,redesign-needed<design',
    'research-brief':
      'research:agent:researcher:completed>review|review:agent:reviewer:approved>finish,changes-requested<research',
    'reviewed-coding':
      'implement:agent:engineer:completed>review|review:agent:reviewer:approved>finish,changes-requested<implement',
    'security-review':
      'assess:agent:assessor:completed>review|review:agent:reviewer:approved>finish,changes-requested<assess',
    'solo-coding': 'implement:agent:engineer:completed>finish',
    solo: 'execute:agent:worker:completed>finish',
  }
  test('Solo Coding defaults its engineer to the deep model tier and changes nothing else about it', async () => {
    expect((await preset('solo-coding')).participants).toEqual({
      engineer: { agentTypeId: 'engineer', tier: 'deep', session: 'reuse-within-stream' },
    })
  })

  test.each(Object.keys(shipped))('the %s preset says its final step delivers, with routing unchanged', async (id) => {
    const definition = await preset(id)
    const shape = definition.steps
      .map(
        (step) =>
          `${step.id}:${step.kind ?? 'agent'}:${step.kind === 'agent' || !step.kind ? step.participant : '-'}:${Object.entries(
            step.outcomes
          )
            .map(([name, target]) =>
              'next' in target ? `${name}>${target.next}` : 'returnTo' in target ? `${name}<${target.returnTo}` : name
            )
            .join(',')}`
      )
      .join('|')
    expect(shape).toBe(shipped[id]!)
    const final = definition.steps.filter((step) =>
      Object.values(step.outcomes).some((t) => 'next' in t && t.next === 'finish')
    )
    expect(final.length).toBeGreaterThan(0)
    for (const step of final) {
      expect(step.kind ?? 'agent').toBe('agent')
      expect(step.instructions).toContain('delivery participant')
      expect(step.instructions).toContain('finish the stream yourself')
    }
    for (const step of definition.steps.filter((step) => !final.includes(step)))
      expect(step.instructions).not.toContain('delivery participant')
  })
})
