import { createBlankWorkflow } from './workflow-editing'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  resolveWorkflow,
  applyWorkflowCustomizations,
  type WorkflowCustomization,
  workflowStepSchema,
  workflowParticipantSchema,
  workflowDefinitionSchema,
  workflowPresetSchema,
  type WorkflowDefinition,
  type WorkflowPresetRevision,
} from './workflows'

const root = resolve(import.meta.dir, '../../..')

async function preset(id: string) {
  return workflowPresetSchema.parse(Bun.YAML.parse(await Bun.file(`${root}/config/workflows/${id}.yaml`).text()))
}

async function engineering(): Promise<WorkflowDefinition> {
  return (await preset('engineering')).definition
}

async function catalog(): Promise<WorkflowPresetRevision> {
  return { id: 'engineering', revision: 'revision-one', definition: await engineering(), disabled: false }
}

describe('declarative workflows', () => {
  test.each([
    'solo',
    'builder-reviewer',
    'engineering',
    'engineering-design-approval',
    'solo-coding',
    'reviewed-coding',
    'research-brief',
    'code-review',
    'security-review',
  ])('validates the %s declarative preset', async (id) => {
    const value = await preset(id)
    expect(value.id).toBe(id)
    expect(workflowDefinitionSchema.parse(value.definition)).toEqual(value.definition)
  })

  test('solo has one participant, no delegation, and domain-independent completion', async () => {
    const definition = (await preset('solo')).definition
    expect(Object.keys(definition.participants)).toEqual(['worker'])
    expect(definition.steps).toHaveLength(1)
    expect(definition.routing.delegation).toBe('disabled')
    expect(definition.completion.mode).toBe('deliverable')
  })

  test('participants own an agent type without a separate profile field', () => {
    const definition = createBlankWorkflow()
    expect(definition.participants.worker).toEqual({ agentTypeId: 'general', session: 'reuse-within-stream' })
    const retired = { ...definition, participants: { worker: { profile: 'general', session: 'reuse-within-stream' } } }
    expect(workflowDefinitionSchema.safeParse(retired).success).toBe(false)
  })

  test('participant agent-type references preserve existing agent-type IDs rather than imposing flow ID syntax', async () => {
    const definition = await engineering()
    definition.participants.reviewer!.agentTypeId = 'Security_Reviewer.v2'
    expect(workflowDefinitionSchema.parse(definition).participants.reviewer!.agentTypeId).toBe('Security_Reviewer.v2')
  })

  test('reviewer-requested redesign passes through implementation before returning to review', async () => {
    const definition = await engineering()
    expect(definition.steps[2]!.outcomes['changes-requested']).toEqual({
      returnTo: 'implement',
    })
    expect(definition.steps[2]!.outcomes['redesign-needed']).toEqual({
      returnTo: 'design',
    })
    expect(definition.steps[0]!.outcomes.completed).toEqual({ next: 'implement' })
    expect(definition.steps[1]!.outcomes.completed).toEqual({ next: 'review' })
    expect(definition.completion.mode).toBe('pr-merge')
  })

  test('two architect participants can use different tiers and sessions', async () => {
    const definition = await engineering()
    definition.participants['second-architect'] = {
      agentTypeId: 'architect',
      tier: 'exhaustive',
      session: 'fresh-per-attempt',
    }
    definition.participants.architect!.tier = 'deep'
    definition.steps[0]!.outcomes.completed = { next: 'critique' }
    definition.steps.push({
      id: 'critique',
      kind: 'agent',
      participant: 'second-architect',
      instructions: 'Challenge the first design.',
      output: 'Design critique.',

      outcomes: { completed: { next: 'implement' } },
    })
    const parsed = workflowDefinitionSchema.parse(definition)
    expect(parsed.participants.architect!.tier).not.toBe(parsed.participants['second-architect']!.tier)
    // The same two stages can deliberately reuse the first session instead.
    const critique = definition.steps[3]!
    if (critique.kind !== 'agent') throw new Error('Expected agent step')
    critique.participant = 'architect'
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
  })

  test('human approval is a distinct step without an agent participant', async () => {
    const definition = (await preset('solo')).definition
    definition.steps[0]!.outcomes.completed = { next: 'accept' }
    definition.steps.push({
      id: 'accept',
      kind: 'human-approval',
      approver: 'assigned-reviewers',
      instructions: 'Accept the report.',
      output: 'Human acceptance.',

      outcomes: {
        approved: { next: 'finish' },
        'changes-requested': { returnTo: 'execute', afterRework: 'return-to-requester' },
      },
    })
    expect(workflowDefinitionSchema.parse(definition).steps[1]!.kind).toBe('human-approval')
    expect(
      workflowDefinitionSchema.safeParse({
        ...definition,
        steps: [definition.steps[0], { ...definition.steps[1], participant: 'worker' }],
      }).success
    ).toBe(false)
  })

  const invalidCases: [string, (definition: WorkflowDefinition) => unknown][] = [
    ['unknown schema version', (d) => ({ ...d, schemaVersion: 2 })],
    ['unknown root fields', (d) => ({ ...d, silentlySkipReviews: true })],
    ['unknown nested fields', (d) => ({ ...d, routing: { ...d.routing, allowAnything: true } })],
    ['missing entry', (d) => ({ ...d, entry: 'missing' })],
    ['duplicate step IDs', (d) => ({ ...d, steps: [...d.steps, d.steps[0]] })],
    ['reserved step ID', (d) => ({ ...d, entry: 'finish', steps: [{ ...d.steps[0], id: 'finish' }] })],
    ['missing participant', (d) => ({ ...d, participants: {} })],
    [
      'unknown next step',
      (d) => ({ ...d, steps: [{ ...d.steps[0], outcomes: { completed: { next: 'missing' } } }, ...d.steps.slice(1)] }),
    ],
    [
      'ambiguous transition',
      (d) => ({
        ...d,
        steps: [
          {
            ...d.steps[0],
            outcomes: { completed: { next: 'implement', returnTo: 'design', afterRework: 'return-to-requester' } },
          },
          ...d.steps.slice(1),
        ],
      }),
    ],
    [
      'rework targeting itself',
      (d) => ({
        ...d,
        steps: [{ ...d.steps[0], outcomes: { completed: { returnTo: 'design' } } }, ...d.steps.slice(1)],
      }),
    ],
    [
      'unknown rework destination',
      (d) => ({
        ...d,
        steps: [
          ...d.steps.slice(0, 2),
          {
            ...d.steps[2],
            outcomes: {
              approved: { next: 'finish' },
              revise: { returnTo: 'missing', afterRework: 'return-to-requester' },
            },
          },
        ],
      }),
    ],
    [
      'unknown after-rework mode',
      (d) => ({
        ...d,
        steps: [
          ...d.steps.slice(0, 2),
          {
            ...d.steps[2],
            outcomes: { approved: { next: 'finish' }, revise: { returnTo: 'design', afterRework: 'missing' } },
          },
        ],
      }),
    ],
    ['unreachable required check', (d) => ({ ...d, steps: [...d.steps, { ...d.steps[0], id: 'orphan' }] })],
    [
      'forward cycle hidden behind a finish outcome',
      (d) => ({
        ...d,
        steps: [
          ...d.steps.slice(0, 2),
          { ...d.steps[2], outcomes: { approved: { next: 'finish' }, loop: { next: 'design' } } },
        ],
      }),
    ],
    [
      'no path to finish',
      (d) => ({
        ...d,
        steps: [
          ...d.steps.slice(0, 2),
          { ...d.steps[2], outcomes: { revise: { returnTo: 'design', afterRework: 'return-to-requester' } } },
        ],
      }),
    ],
    ['unbounded attempts', (d) => ({ ...d, limits: { ...d.limits, maxStepAttempts: Infinity } })],
    ['zero attempts', (d) => ({ ...d, limits: { ...d.limits, maxStepAttempts: 0 } })],
    ['fractional attempts', (d) => ({ ...d, limits: { ...d.limits, maxStepAttempts: 1.5 } })],
    [
      'delegation allowed with zero limit',
      (d) => ({ ...d, routing: { ...d.routing, delegation: 'allowed' }, limits: { ...d.limits, maxDelegations: 0 } }),
    ],
    [
      'guided mode with implicit returns',
      (d) => ({ ...d, routing: { mode: 'guided', returnTo: 'earlier-steps', delegation: 'disabled' } }),
    ],
    ['silent completion on limit', (d) => ({ ...d, limits: { ...d.limits, onLimit: 'finish' } })],
  ]

  test.each(invalidCases)('rejects %s', async (_name, change) => {
    expect(workflowDefinitionSchema.safeParse(change(await engineering())).success).toBe(false)
  })

  test('rejects prototype-shaped participant keys', async () => {
    const definition = await engineering()
    const malicious = JSON.parse('{"__proto__":{"agentTypeId":"general","session":"reuse-within-stream"}}')
    expect(workflowDefinitionSchema.safeParse({ ...definition, participants: malicious }).success).toBe(false)
  })
})

describe('workflow resolution', () => {
  test('inline and saved definitions resolve identically, without sharing mutable inputs', async () => {
    const record = await catalog()
    const fromPreset = resolveWorkflow({ kind: 'preset', id: record.id }, record)
    const fromInline = resolveWorkflow({ kind: 'inline', definition: record.definition })
    expect(fromPreset.definition).toEqual(fromInline.definition)
    expect(fromPreset.source).toEqual({ kind: 'preset', id: record.id, revision: record.revision, customizations: [] })
    record.definition.participants.engineer!.agentTypeId = 'general'
    expect(fromPreset.definition.participants.engineer!.agentTypeId).toBe('engineer')
    expect(fromInline.definition.participants.engineer!.agentTypeId).toBe('engineer')
  })

  test('customizes stable participant IDs without changing the catalog', async () => {
    const record = await catalog()
    const resolved = resolveWorkflow(
      {
        kind: 'preset',
        id: record.id,
        revision: record.revision,
        customizations: [
          {
            op: 'put-participant',
            id: 'engineer',
            participant: { agentTypeId: 'engineer', tier: 'deep', session: 'reuse-within-stream' },
          },
        ],
      },
      record
    )
    expect(resolved.definition.participants.engineer!.tier).toBe('deep')
    expect(record.definition.participants.engineer!.tier).toBeUndefined()
    expect(resolveWorkflow({ kind: 'inline', definition: resolved.definition }).definition).toEqual(resolved.definition)
  })

  test('validates a whole customization transaction after rewiring its steps', async () => {
    const record = await catalog()
    const specialist = { ...record.definition.steps[2]!, id: 'security', outcomes: { approved: { next: 'review' } } }
    const resolved = resolveWorkflow(
      {
        kind: 'preset',
        id: record.id,
        customizations: [
          { op: 'put-step', step: { ...record.definition.steps[1], outcomes: { completed: { next: 'security' } } } },
          { op: 'put-step', step: specialist },
        ],
      },
      record
    )
    expect(resolved.definition.steps).toHaveLength(4)
    expect(record.definition.steps).toHaveLength(3)
  })

  test('a failed customization cannot partially mutate the preset', async () => {
    const record = await catalog()
    const before = structuredClone(record)
    expect(() =>
      resolveWorkflow(
        {
          kind: 'preset',
          id: record.id,
          customizations: [
            {
              op: 'put-participant',
              id: 'engineer',
              participant: { agentTypeId: 'general', session: 'fresh-per-attempt' },
            },
            { op: 'remove-step', id: 'review' },
          ],
        },
        record
      )
    ).toThrow()
    expect(record).toEqual(before)
  })

  test('rejects missing, mismatched, disabled, and stale preset references', async () => {
    const record = await catalog()
    expect(() => resolveWorkflow({ kind: 'preset', id: record.id })).toThrow('not found')
    expect(() => resolveWorkflow({ kind: 'preset', id: 'other' }, record)).toThrow('not found')
    expect(() => resolveWorkflow({ kind: 'preset', id: record.id }, { ...record, disabled: true })).toThrow('disabled')
    expect(() => resolveWorkflow({ kind: 'preset', id: record.id, revision: 'stale' }, record)).toThrow('changed')
  })

  test('rejects mixing inline and preset inputs and unknown customization operations', async () => {
    const record = await catalog()
    expect(() => resolveWorkflow({ kind: 'inline', definition: record.definition, id: record.id })).toThrow()
    expect(() =>
      resolveWorkflow({ kind: 'preset', id: record.id, customizations: [{ op: 'skip-all-reviews' }] }, record)
    ).toThrow()
  })
})

test('engineering recommendations resolve to ready-to-use styles and never provision permanent workers', async () => {
  const squad = Bun.YAML.parse(await Bun.file(`${root}/config/squad-presets/engineering.yaml`).text()) as any
  expect(squad.defaultAgents).toEqual([])
  expect(squad.workflows.default.id).toBe('solo-coding')
  expect(squad.workflows.choices.map((choice: any) => choice.source.id)).toEqual([
    'solo-coding',
    'reviewed-coding',
    'engineering',
    'code-review',
    'security-review',
  ])
  for (const choice of squad.workflows.choices) {
    const { definition } = await preset(choice.source.id)
    expect(definition.routing.delegation).toBe('disabled')
    expect(choice.when.length).toBeGreaterThan(0)
    for (const participant of Object.values(definition.participants))
      expect(await Bun.file(`${root}/config/agent-types/${participant.agentTypeId}.yaml`).exists()).toBe(true)
  }
  expect((await preset('solo-coding')).definition.completion).toEqual({ mode: 'pr-merge', followChanges: true })
  // Reviewed presets send change events (CI, pushes, review comments) straight to the engineer;
  // delivery events (merged, closed) still reach the reviewer that finishes the stream.
  for (const id of ['reviewed-coding', 'engineering', 'engineering-design-approval']) {
    const { definition } = await preset(id)
    expect(definition.completion).toEqual({
      mode: 'pr-merge',
      followChanges: true,
      changeEventsTo: { step: 'implement' },
    })
    expect(definition.steps.find((step) => step.id === 'implement')?.outcomes).toMatchObject({
      completed: { next: 'review' },
    })
  }
  for (const id of ['solo-coding', 'reviewed-coding', 'engineering'])
    expect((await preset(id)).definition.subscriptions).toBeUndefined()
  for (const id of ['research-brief', 'security-review', 'code-review'])
    expect((await preset(id)).definition.completion.mode).toBe('deliverable')
})

test('code hosting event recipients must name an existing agent step', () => {
  const flow = createBlankWorkflow()
  flow.completion = { ...flow.completion, followChanges: true, changeEventsTo: { step: flow.entry } }
  expect(workflowDefinitionSchema.safeParse(flow).success).toBe(true)
  flow.completion.changeEventsTo = { step: 'missing' }
  expect(workflowDefinitionSchema.safeParse(flow).success).toBe(false)
  flow.completion.changeEventsTo = { step: 'approval' }
  flow.steps.push({
    id: 'approval',
    kind: 'human-approval',
    approver: 'assigned-reviewers',
    instructions: 'Review.',
    output: 'A decision.',

    outcomes: { approved: { next: 'finish' } },
  })
  const result = workflowDefinitionSchema.safeParse(flow)
  expect(result.success).toBe(false)
  if (!result.success)
    expect(result.error.issues.some((issue) => issue.path.join('.') === 'completion.changeEventsTo')).toBe(true)
})

test('early saved rework and reviewer metadata reopen as a graph-following draft without hidden fields', async () => {
  const definition = await engineering()
  const legacy = structuredClone(definition) as any
  legacy.steps[2].independentFrom = ['architect']
  legacy.steps[2].outcomes['changes-requested'] = { returnTo: 'implement', resumeAt: 'review' }
  const parsed = workflowDefinitionSchema.parse(legacy)
  expect(parsed.steps[2]!.outcomes['changes-requested']).toEqual({ returnTo: 'implement' })
  expect('independentFrom' in parsed.steps[2]!).toBe(false)
  expect(parsed.steps.map((step) => step.id)).toEqual(definition.steps.map((step) => step.id))
})

test('step display names survive validation without changing connection IDs', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.name = 'Audience research'
  const parsed = workflowDefinitionSchema.parse(definition)
  expect(parsed.steps[0]!.name).toBe('Audience research')
  expect(parsed.steps[0]!.id).toBe('execute')
  expect(parsed.entry).toBe('execute')
  expect(parsed.steps[0]!.outcomes).toEqual(definition.steps[0]!.outcomes)
  definition.steps[0]!.name = 'a'.repeat(201)
  expect(workflowDefinitionSchema.safeParse(definition).success).toBe(false)
})

test('human approvals default to assigned reviewers while preserving an explicit any-reviewer policy', () => {
  const step = {
    id: 'review',
    kind: 'human-approval',
    instructions: 'Review the result',
    output: 'Decision',
    outcomes: { approved: { next: 'finish' } },
  }
  expect(workflowStepSchema.parse(step)).toMatchObject({ approver: 'assigned-reviewers' })
  expect(workflowStepSchema.parse({ ...step, approver: 'reviewers' })).toMatchObject({ approver: 'reviewers' })
})

test('shipped presets follow the visible graph after rework rather than skipping intermediate steps', async () => {
  let paths = 0
  for (const id of [
    'solo',
    'solo-coding',
    'builder-reviewer',
    'reviewed-coding',
    'engineering',
    'engineering-design-approval',
    'research-brief',
    'code-review',
    'security-review',
  ]) {
    const { definition } = await preset(id)
    for (const step of definition.steps)
      for (const outcome of Object.values(step.outcomes)) {
        if ('returnTo' in outcome) {
          paths++
          expect(outcome.afterRework ?? 'follow-graph').toBe('follow-graph')
          const target = definition.steps.find((candidate) => candidate.id === outcome.returnTo)!
          expect(target).toBeDefined()
          // Each correction returns to its requester along the ordinary successful path.
          const seen = new Set<string>()
          let current = target
          while (current.id !== step.id && !seen.has(current.id)) {
            seen.add(current.id)
            const completed = current.outcomes.completed
            if (!completed || !('next' in completed)) break
            const next = definition.steps.find((candidate) => candidate.id === completed.next)
            if (!next) break
            current = next
          }
          expect(current.id).toBe(step.id)
        }
      }
  }
  expect(paths).toBe(9)
})

describe('atomic final step order', () => {
  const research = ['audience', 'competition', 'channels']
  const agent = (id: string, outcomes: unknown) => ({
    id,
    kind: 'agent',
    participant: 'worker',
    instructions: `Do ${id}.`,
    output: `${id} results.`,
    outcomes,
  })
  const steps = [
    agent('plan', { ready: { parallel: research, join: 'assets' } }),
    ...research.map((id) => agent(id, { completed: { next: 'assets' } })),
    agent('assets', { completed: { next: 'approval' } }),
    {
      id: 'approval',
      kind: 'human-approval',
      instructions: 'Review assets.',
      output: 'Decision.',
      outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'assets' } },
    },
  ]
  const ids = steps.map((step) => step.id)

  test.each(['before additions', 'before removal', 'after removal'])(
    'replaces the initial step with research, join, and approval ordered %s',
    (position) => {
      const base = createBlankWorkflow()
      const before = structuredClone(base)
      const operations = steps.map((step) => ({ op: 'put-step', step })) as WorkflowCustomization[]
      operations.push({ op: 'set-entry', entry: 'plan' })
      const order: WorkflowCustomization = { op: 'set-step-order', ids }
      if (position === 'before additions') operations.unshift(order)
      if (position === 'before removal') operations.push(order)
      operations.push({ op: 'remove-step', id: 'execute' })
      if (position === 'after removal') operations.push(order)
      const result = applyWorkflowCustomizations(base, operations)
      expect(result.steps.map((step) => step.id)).toEqual(ids)
      expect(result.entry).toBe('plan')
      expect(result.steps[0]!.outcomes.ready).toEqual({ parallel: research, join: 'assets' })
      expect(result.steps.at(-1)!.kind).toBe('human-approval')
      expect(result.steps.at(-1)!.outcomes['changes-requested']).toEqual({ returnTo: 'assets' })
      expect(base).toEqual(before)
    }
  )

  test.each([
    { order: ['missing'], detail: 'Missing: execute. Unknown: missing.' },
    { order: ['execute', 'execute'], detail: 'Duplicates: execute.' },
  ])('invalid final order reports IDs and preserves the source: $detail', ({ order, detail }) => {
    const base = createBlankWorkflow()
    const before = structuredClone(base)
    expect(() =>
      applyWorkflowCustomizations(base, [
        { op: 'set-name', name: 'Rejected name' },
        { op: 'set-step-order', ids: order },
      ])
    ).toThrow(detail)
    expect(base).toEqual(before)
  })

  test('the last requested order describes the final step set', () => {
    const result = applyWorkflowCustomizations(createBlankWorkflow(), [
      { op: 'set-step-order', ids: ['replaced-order'] },
      { op: 'set-step-order', ids: ['execute'] },
    ])
    expect(result.steps.map((step) => step.id)).toEqual(['execute'])
  })
})

test('participant tier overrides round-trip and reject ambiguous or malformed settings', () => {
  const base = { agentTypeId: 'engineer', session: 'reuse-within-stream' as const }
  for (const tier of ['deep', 'exhaustive']) {
    const participant = workflowParticipantSchema.parse({ ...base, tier })
    const definition = createBlankWorkflow()
    definition.participants.worker = participant
    expect(workflowDefinitionSchema.parse(definition).participants.worker).toEqual({ ...base, tier })
  }
  expect(workflowParticipantSchema.safeParse({ ...base, tier: 'provider:model' }).success).toBe(false)
  expect(workflowParticipantSchema.safeParse({ ...base, tier: 'deep', model: 'provider:model' }).success).toBe(false)
  expect(workflowParticipantSchema.safeParse({ ...base, model: 'provider:model' }).success).toBe(false)
})

test('Engineering with design approval gates implementation on a human design approval', async () => {
  const { definition } = await preset('engineering-design-approval')
  expect(definition.name).toBe('Engineering with design approval')
  expect(definition.entry).toBe('design')
  expect(definition.steps.map((step) => step.id)).toEqual(['design', 'design-approval', 'implement', 'review'])
  const [design, approval, implement, review] = definition.steps
  expect(design).toMatchObject({ kind: 'agent', participant: 'architect' })
  expect(design!.outcomes).toEqual({ completed: { next: 'design-approval' } })
  expect(approval).toMatchObject({ kind: 'human-approval', approver: 'reviewers' })
  expect(approval!.outcomes).toEqual({
    approved: { next: 'implement' },
    'changes-requested': { returnTo: 'design' },
  })
  expect(implement).toMatchObject({ kind: 'agent', participant: 'engineer' })
  expect(implement!.outcomes).toEqual({ completed: { next: 'review' } })
  expect(review).toMatchObject({ kind: 'agent', participant: 'reviewer' })
  expect(review!.outcomes).toEqual({ approved: { next: 'finish' }, 'changes-requested': { returnTo: 'implement' } })
  expect(definition.routing.delegation).toBe('disabled')
  expect(definition.limits.maxStepAttempts).toBeUndefined()
  expect(definition.completion).toEqual({
    mode: 'pr-merge',
    followChanges: true,
    changeEventsTo: { step: 'implement' },
  })
  expect(definition.subscriptions).toBeUndefined()
})

test('Code Review has one reviewer and finishes with a report while following attached code-host events', async () => {
  const { definition } = await preset('code-review')
  expect(definition.participants).toEqual({ reviewer: { agentTypeId: 'reviewer', session: 'reuse-within-stream' } })
  expect(definition.steps).toHaveLength(1)
  expect(definition.entry).toBe('review')
  expect(definition.steps[0]).toMatchObject({ kind: 'agent', participant: 'reviewer' })
  expect(definition.steps[0]!.outcomes).toEqual({ completed: { next: 'finish' } })
  expect(definition.routing.delegation).toBe('disabled')
  expect(definition.completion).toEqual({ mode: 'deliverable', followChanges: true })
})

test('shipped workflow roles describe the work and every participant is used', async () => {
  const roles: Record<string, string[]> = {
    solo: ['worker'],
    'builder-reviewer': ['builder', 'reviewer'],
    'solo-coding': ['engineer'],
    'reviewed-coding': ['engineer', 'reviewer'],
    engineering: ['architect', 'engineer', 'reviewer'],
    'engineering-design-approval': ['architect', 'engineer', 'reviewer'],
    'research-brief': ['researcher', 'reviewer'],
    'security-review': ['assessor', 'reviewer'],
    'code-review': ['reviewer'],
  }
  for (const [id, participants] of Object.entries(roles)) {
    const { definition } = await preset(id)
    expect(Object.keys(definition.participants)).toEqual(participants)
    expect(new Set(definition.steps.filter((step) => step.kind === 'agent').map((step) => step.participant))).toEqual(
      new Set(participants)
    )
  }
})

test('the code-host- and tracked- id prefixes stay reserved even when change following is off', () => {
  const flow = createBlankWorkflow()
  flow.completion = { ...flow.completion, followChanges: false }
  const subscription = (id: string) => ({
    id,
    source: { integration: 'github', output: 'issue.assigned', version: 1 },
    match: { repository: { value: 'acme/widgets' } },
    deliver: { to: 'active' as const, whenInactive: 'retain' as const },
  })
  const messages = {
    'code-host-x': 'The code-host- prefix is reserved for automatic change subscriptions',
    'tracked-x': 'The tracked- prefix is reserved for automatic tracked-resource subscriptions',
  }
  // The runtime reads any code-host-*/tracked-* id as an automatic subscription
  // regardless of followChanges, so the namespace cannot be conditionally open.
  for (const [id, message] of Object.entries(messages)) {
    const result = workflowDefinitionSchema.safeParse({ ...flow, subscriptions: [subscription(id)] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain(message)
  }
  expect(workflowDefinitionSchema.safeParse({ ...flow, subscriptions: [subscription('mine')] }).success).toBe(true)
})
