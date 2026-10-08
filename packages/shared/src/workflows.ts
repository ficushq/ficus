import { z } from 'zod'
import { integrationSubscriptionSchema, integrationDataPathSchema } from './integration-outputs'
import { decisionQuestionsSchema } from './decisions'
import { decisionConditionIssue, decisionConditionSchema } from './decision-conditions'

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use a lowercase identifier with optional hyphens')
  .refine((id) => !['finish', 'constructor', 'prototype'].includes(id), 'Reserved identifier')
const text = z.string().trim().min(1).max(64_000)
const destination = z.union([identifier, z.literal('finish')])

export const workflowParticipantSchema = z
  .object({
    // Existing agent-type IDs need not follow the flow's local ID convention.
    agentTypeId: z.string().trim().min(1).max(100),
    tier: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    session: z.enum(['reuse-within-stream', 'fresh-per-attempt']),
  })
  .strict()

export const workflowTransitionSchema = z.union([
  z.object({ next: destination }).strict(),
  z.object({ parallel: z.array(identifier).min(2).max(16), join: destination.default('finish') }).strict(),
  z.preprocess(
    (value) => {
      // Drafts saved by the early editor used a separate resume destination.
      // Reopening them keeps their correction edge and uses the visible graph.
      if (value && typeof value === 'object' && 'returnTo' in value && 'resumeAt' in value) {
        const { resumeAt: _resumeAt, ...transition } = value
        return transition
      }
      return value
    },
    z
      .object({
        returnTo: identifier.describe('Step that performs the requested revisions, for example create-assets.'),
        afterRework: z
          .enum(['follow-graph', 'return-to-requester'])
          .optional()
          .describe(
            'Default: follow-graph runs the normal outgoing arrows after revisions. return-to-requester sends the corrected result straight back to the step requesting changes, bypassing the correction step’s forward arrows.'
          ),
      })
      .strict()
  ),
])

const outcomes = z
  .record(identifier, workflowTransitionSchema)
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Use 1–16 outcomes')
const stepFields = {
  id: identifier,
  name: z.string().trim().min(1).max(200).optional(),
  instructions: text,
  output: text,
  outcomes,
}

/** What a decision step shows its decision model, from the work stream and the run so far. */
export const WORKFLOW_DECISION_INPUTS = ['title', 'description', 'handoff', 'incoming-results'] as const
export type WorkflowDecisionInput = (typeof WORKFLOW_DECISION_INPUTS)[number]
export const WORKFLOW_DECISION_INPUT_INFO: Record<WorkflowDecisionInput, { label: string; description: string }> = {
  title: { label: 'Title', description: "The work stream's title." },
  description: { label: 'Description', description: "The work stream's original brief." },
  handoff: { label: "Owner's handoff", description: "The owner's handoff message, when there is one." },
  'incoming-results': {
    label: 'Incoming results',
    description: 'The results or feedback of the steps that handed off to this one.',
  },
}
export const DEFAULT_WORKFLOW_DECISION_INPUT: WorkflowDecisionInput[] = ['title', 'description', 'incoming-results']

export const workflowDecisionRouteSchema = z.object({ when: decisionConditionSchema, outcome: identifier }).strict()
export type WorkflowDecisionRoute = z.infer<typeof workflowDecisionRouteSchema>

export const workflowStepSchema = z.union([
  z
    .object({
      ...stepFields,
      kind: z.literal('agent').default('agent'),
      participant: identifier,
    })
    .strict(),
  z
    .object({
      ...stepFields,
      kind: z.literal('human-approval'),
      approver: z.enum(['assigned-reviewers', 'reviewers']).default('assigned-reviewers'),
    })
    .strict(),
  /**
   * No agent works on a decision step: Core asks a decision model its questions about the
   * selected input and follows the first route whose condition matches. Without a match it
   * follows `otherwise`; without an answer (unconfigured, unavailable or refused) it follows
   * `unavailable`. Either one omitted waits for a person to choose, like a human approval.
   */
  z
    .object({
      id: stepFields.id,
      name: stepFields.name,
      instructions: stepFields.instructions,
      kind: z.literal('decision'),
      input: z
        .array(z.enum(WORKFLOW_DECISION_INPUTS))
        .min(1, 'Choose what the decision looks at')
        .max(WORKFLOW_DECISION_INPUTS.length)
        .refine((input) => new Set(input).size === input.length, 'List each input once')
        .default(DEFAULT_WORKFLOW_DECISION_INPUT),
      questions: decisionQuestionsSchema,
      routes: z.array(workflowDecisionRouteSchema).max(32, 'Use at most 32 routes').default([]),
      otherwise: identifier.optional(),
      unavailable: identifier.optional(),
      outcomes,
    })
    .strict(),
])
export type WorkflowDecisionStep = Extract<z.infer<typeof workflowStepSchema>, { kind: 'decision' }>

/** Problems a decision step's routes have with its own questions and outcomes, for the editor and validation. */
export function workflowDecisionStepIssues(
  step: Pick<WorkflowDecisionStep, 'questions' | 'routes' | 'otherwise' | 'unavailable' | 'outcomes'>
): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = []
  const outcome = (path: (string | number)[], name: string | undefined, label: string) => {
    if (name !== undefined && !Object.hasOwn(step.outcomes, name))
      issues.push({ path, message: `${label} uses unknown outcome '${name}'; add it to the step's outcomes` })
  }
  for (const [index, route] of step.routes.entries()) {
    const issue = decisionConditionIssue(route.when, step.questions)
    if (issue) issues.push({ path: ['routes', index, 'when'], message: `Route ${index + 1}: ${issue}` })
    outcome(['routes', index, 'outcome'], route.outcome, `Route ${index + 1}`)
  }
  outcome(['otherwise'], step.otherwise, 'Otherwise')
  outcome(['unavailable'], step.unavailable, 'Unavailable')
  return issues
}

export const workflowRoutingSchema = z
  .object({
    mode: z.enum(['guided', 'flexible', 'adaptive']),
    returnTo: z.enum(['declared-only', 'earlier-steps']),
    delegation: z.enum(['disabled', 'allowed']),
  })
  .strict()

export const workflowLimitsSchema = z
  .object({
    maxStepAttempts: z.number().int().min(1).max(100).optional(),
    maxDelegations: z.number().int().min(0).max(100),
    maxParallelAttempts: z.number().int().min(1).max(32).optional(),
    onLimit: z.literal('request-owner-input'),
  })
  .strict()

// This is a flow definition contract, not an expansion of the legacy stream API.
// Deliverable completion must remain unavailable there until runtime gates exist.
export const workflowCompletionSchema = z
  .object({
    mode: z.enum(['deliverable', 'pr-merge', 'pr-auto-merge', 'direct-merge', 'review-approval']),
    followChanges: z.boolean().optional(),
    changeEventsTo: z.union([z.literal('delivery-owner'), z.object({ step: identifier }).strict()]).optional(),
  })
  .strict()

/** Keep early saved workflows/drafts readable after removing redundant step metadata. */
export function normalizeWorkflowStep(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'human-approval' &&
    'approver' in value &&
    (value.approver === 'squad-admin' || value.approver === 'requesting-user')
  ) {
    value = { ...value, approver: 'reviewers' }
  }
  if (value && typeof value === 'object' && ('independentFrom' in value || 'required' in value)) {
    const { independentFrom: _independentFrom, required: _required, ...step } = value as Record<string, unknown>
    return step
  }
  return value
}

const definitionShape = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(200),
    participants: z
      .record(identifier, workflowParticipantSchema)
      .refine((value) => Object.keys(value).length <= 64, 'Use at most 64 participants'),
    entry: identifier,
    routing: workflowRoutingSchema,
    limits: workflowLimitsSchema,
    steps: z.array(z.preprocess(normalizeWorkflowStep, workflowStepSchema)).min(1).max(128),
    completion: workflowCompletionSchema,
    subscriptions: z.array(integrationSubscriptionSchema).max(32).optional(),
  })
  .strict()

/** Structural schema for incomplete editor drafts, before normalization and graph validation. */
export const workflowDefinitionShapeSchema = definitionShape

export type WorkflowParticipant = z.infer<typeof workflowParticipantSchema>
export type WorkflowTransition = z.infer<typeof workflowTransitionSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowDefinition = z.infer<typeof definitionShape>

/** The forward graph describes normal progression; rework is a separate edge. */
function forwardEdges(step: WorkflowStep): string[] {
  return Object.values(step.outcomes).flatMap((outcome) =>
    'next' in outcome ? [outcome.next] : 'parallel' in outcome ? outcome.parallel : []
  )
}

function reachable(start: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const pending = [start]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    pending.push(...(edges.get(id) ?? []))
  }
  return seen
}

/** Infer the first step every forward path reaches. Alternative outcomes must not cause premature joins. */
export function inferWorkflowJoin(definition: WorkflowDefinition, branches: string[]): string | undefined {
  if (branches.length < 2 || new Set(branches).size !== branches.length) return undefined
  const steps = new Map(definition.steps.map((step) => [step.id, step]))
  const memo = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  const after = (id: string): Set<string> => {
    if (memo.has(id)) return memo.get(id)!
    if (id === 'finish') return new Set(['finish'])
    if (visiting.has(id) || !steps.has(id)) return new Set()
    visiting.add(id)
    const successors = forwardEdges(steps.get(id)!)
    const paths = successors.map(after)
    const common = paths.length
      ? new Set([...paths[0]!].filter((candidate) => paths.every((path) => path.has(candidate))))
      : new Set<string>()
    common.add(id)
    visiting.delete(id)
    memo.set(id, common)
    return common
  }
  const paths = branches.map(after)
  const candidates = [...paths[0]!].filter((id) => paths.every((path) => path.has(id)))
  // The nearest common successor contains the later successors in its own forward paths.
  return candidates.sort((a, b) => after(b).size - after(a).size || a.localeCompare(b))[0]
}

/** Keep the runtime's explicit synchronization boundary in sync with the visible connections. */
export function normalizeWorkflowJoins(definition: WorkflowDefinition): WorkflowDefinition {
  const normalized = structuredClone(definition)
  for (const step of normalized.steps)
    for (const target of Object.values(step.outcomes)) {
      if ('parallel' in target) {
        const join = inferWorkflowJoin(definition, target.parallel)
        if (join) target.join = join
      }
    }
  return normalized
}

export const workflowDefinitionSchema = definitionShape
  .transform(normalizeWorkflowJoins)
  .superRefine((definition, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message })
    const steps = new Map<string, WorkflowStep>()
    for (const [index, step] of definition.steps.entries()) {
      if (steps.has(step.id)) issue(['steps', index, 'id'], `Duplicate step '${step.id}'`)
      steps.set(step.id, step)
    }
    const codeHostTarget = definition.completion.changeEventsTo
    if (typeof codeHostTarget === 'object' && steps.get(codeHostTarget.step)?.kind !== 'agent')
      issue(['completion', 'changeEventsTo'], 'Code hosting events must target an existing agent step')
    const subscriptionIds = new Set<string>()
    for (const [index, subscription] of (definition.subscriptions ?? []).entries()) {
      const path = ['subscriptions', index]
      // Unconditional: the runtime classifies by id prefix alone (a code-host-* id is
      // delivery feedback whatever the flow declares), so the namespace is always reserved.
      if (subscription.id.startsWith('code-host-'))
        issue([...path, 'id'], 'The code-host- prefix is reserved for automatic change subscriptions')
      if (subscription.id.startsWith('tracked-'))
        issue([...path, 'id'], 'The tracked- prefix is reserved for automatic tracked-resource subscriptions')
      if (subscriptionIds.has(subscription.id)) issue([...path, 'id'], 'Duplicate subscription ID')
      subscriptionIds.add(subscription.id)
      const target = subscription.deliver.to
      if (typeof target === 'object') {
        if ('participant' in target && !Object.hasOwn(definition.participants, target.participant))
          issue([...path, 'deliver', 'to'], 'Unknown participant')
        if ('step' in target && steps.get(target.step)?.kind !== 'agent')
          issue([...path, 'deliver', 'to'], 'Target must be an agent step')
      }
    }
    if (!steps.has(definition.entry)) issue(['entry'], `Unknown entry step '${definition.entry}'`)
    if (definition.routing.mode === 'guided' && definition.routing.returnTo !== 'declared-only')
      issue(['routing', 'returnTo'], 'Guided flows only allow declared return paths')
    if (definition.routing.mode === 'guided' && definition.routing.delegation !== 'disabled')
      issue(['routing', 'delegation'], 'Guided flows do not allow ad hoc delegation')
    if (definition.routing.delegation === 'allowed' && definition.limits.maxDelegations === 0)
      issue(['limits', 'maxDelegations'], 'Allowed delegation requires a positive limit')

    const edges = new Map(definition.steps.map((step) => [step.id, forwardEdges(step)]))
    const allEdges = new Map(
      definition.steps.map((step) => [
        step.id,
        Object.values(step.outcomes).flatMap((outcome) =>
          'next' in outcome
            ? [outcome.next]
            : 'parallel' in outcome
              ? [...outcome.parallel, outcome.join]
              : [outcome.returnTo]
        ),
      ])
    )
    const fromEntry = reachable(definition.entry, allEdges)
    for (const [index, step] of definition.steps.entries()) {
      const path = ['steps', index] as (string | number)[]
      if (!fromEntry.has(step.id)) issue(path, `Step '${step.id}' is unreachable from the entry`)
      if (step.kind === 'agent') {
        if (!Object.hasOwn(definition.participants, step.participant))
          issue([...path, 'participant'], `Unknown participant '${step.participant}'`)
      }
      if (step.kind === 'decision')
        for (const problem of workflowDecisionStepIssues(step)) issue([...path, ...problem.path], problem.message)
      for (const [outcomeName, outcome] of Object.entries(step.outcomes)) {
        const transitionPath = [...path, 'outcomes', outcomeName]
        if ('next' in outcome) {
          if (outcome.next !== 'finish' && !steps.has(outcome.next))
            issue([...transitionPath, 'next'], `Unknown next step '${outcome.next}'`)
        } else if ('parallel' in outcome) {
          if (new Set(outcome.parallel).size !== outcome.parallel.length)
            issue(transitionPath, 'Parallel branches must be distinct')
          for (const id of [...outcome.parallel, outcome.join])
            if (id !== 'finish' && !steps.has(id)) issue(transitionPath, `Unknown parallel destination '${id}'`)
          const seen = new Set<string>()
          for (const branch of outcome.parallel) {
            const region = new Set<string>()
            const pending = [branch]
            let joined = false
            while (pending.length) {
              const id = pending.pop()!
              if (id === outcome.join) {
                joined = true
                continue
              }
              if (id === 'finish') {
                issue(transitionPath, `Branch '${branch}' can finish before join '${outcome.join}'`)
                continue
              }
              if (region.has(id)) continue
              region.add(id)
              if (seen.has(id)) issue(transitionPath, `Parallel branches overlap at '${id}' before their join`)
              pending.push(...(edges.get(id) ?? []))
            }
            if (!joined) issue(transitionPath, `Branch '${branch}' must reach join '${outcome.join}'`)
            for (const id of region) seen.add(id)
          }
        } else {
          if (outcome.returnTo === step.id) issue(transitionPath, 'Choose another step to do the revisions')
          if (!steps.has(outcome.returnTo))
            issue([...transitionPath, 'returnTo'], `Unknown rework step '${outcome.returnTo}'`)
          else if (steps.get(outcome.returnTo)!.kind === 'decision')
            issue([...transitionPath, 'returnTo'], `Decision step '${outcome.returnTo}' cannot do revisions`)
        }
      }
      if (!reachable(step.id, allEdges).has('finish')) issue(path, `Step '${step.id}' has no path to finish`)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (id === 'finish' || visited.has(id)) return
      if (visiting.has(id)) {
        issue(['steps'], `Forward cycle at '${id}'; use an explicit return transition for rework`)
        return
      }
      visiting.add(id)
      for (const target of edges.get(id) ?? []) visit(target)
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of steps.keys()) visit(id)
  })

export const workflowScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instance') }).strict(),
  z.object({ kind: z.literal('squad'), squadId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }).strict(),
])
export type WorkflowScope = z.infer<typeof workflowScopeSchema>

export const workflowPresetSchema = z
  .object({
    id: identifier,
    description: z.string().max(4000).optional(),
    scope: workflowScopeSchema.optional(),
    definition: workflowDefinitionSchema,
  })
  .strict()

export type WorkflowPreset = z.infer<typeof workflowPresetSchema>

export const workflowCustomizationSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('set-subscriptions'), subscriptions: z.array(integrationSubscriptionSchema).max(32) })
    .strict(),
  z.object({ op: z.literal('put-participant'), id: identifier, participant: workflowParticipantSchema }).strict(),
  z.object({ op: z.literal('remove-participant'), id: identifier }).strict(),
  z.object({ op: z.literal('put-step'), step: workflowStepSchema }).strict(),
  z.object({ op: z.literal('remove-step'), id: identifier }).strict(),
  z
    .object({
      op: z.literal('update-step'),
      id: identifier,
      changes: z.union([
        workflowStepSchema.options[0].omit({ id: true, kind: true }).partial(),
        workflowStepSchema.options[1].omit({ id: true, kind: true }).partial(),
        workflowStepSchema.options[2].omit({ id: true, kind: true }).partial(),
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal('set-outcome'),
      id: identifier,
      outcome: identifier,
      transition: workflowTransitionSchema,
    })
    .strict(),
  z.object({ op: z.literal('remove-outcome'), id: identifier, outcome: identifier }).strict(),
  z.object({ op: z.literal('set-entry'), entry: identifier }).strict(),
  z.object({ op: z.literal('set-name'), name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ op: z.literal('set-step-order'), ids: z.array(identifier).min(1).max(128) }).strict(),
  z.object({ op: z.literal('set-routing'), routing: workflowRoutingSchema }).strict(),
  z.object({ op: z.literal('set-limits'), limits: workflowLimitsSchema }).strict(),
  z.object({ op: z.literal('set-completion'), completion: workflowCompletionSchema }).strict(),
])

export const workflowSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), definition: workflowDefinitionSchema }).strict(),
  z
    .object({
      kind: z.literal('preset'),
      id: identifier,
      revision: z.string().min(1).max(200).optional(),
      customizations: z.array(workflowCustomizationSchema).max(512).default([]),
    })
    .strict(),
])

export type WorkflowCustomization = z.infer<typeof workflowCustomizationSchema>
export type WorkflowSource = z.infer<typeof workflowSourceSchema>

/** Caller must load an authorized catalog record; this pure compiler grants no access. */
export interface WorkflowPresetRevision {
  id: string
  revision: string
  definition: WorkflowDefinition
  disabled: boolean
}

export interface ResolvedWorkflow {
  schemaVersion: 1
  definition: WorkflowDefinition
  source: { kind: 'inline' } | { kind: 'preset'; id: string; revision: string; customizations: WorkflowCustomization[] }
}

/** Resolve into independent JSON data. Agent-type/tool authorization and execution are separate. */
export function resolveWorkflow(input: unknown, preset?: WorkflowPresetRevision): ResolvedWorkflow {
  const source = workflowSourceSchema.parse(input)
  if (source.kind === 'inline') return { schemaVersion: 1, definition: source.definition, source: { kind: 'inline' } }
  if (!preset || preset.id !== source.id) throw new Error(`Workflow '${source.id}' not found`)
  if (preset.disabled) throw new Error(`Workflow '${source.id}' is disabled`)
  if (!preset.revision) throw new Error('Preset revision is required')
  if (source.revision !== undefined && source.revision !== preset.revision)
    throw new Error(`Workflow '${source.id}' changed; reload the preset before customizing it`)

  return {
    schemaVersion: 1,
    definition: applyWorkflowCustomizations(workflowDefinitionSchema.parse(preset.definition), source.customizations),
    source: { kind: 'preset', id: preset.id, revision: preset.revision, customizations: source.customizations },
  }
}

/** Apply one atomic edit batch. Validate the final graph so related operations can be submitted together. */
export function applyWorkflowCustomizations(base: WorkflowDefinition, operations: unknown): WorkflowDefinition {
  const changes = z.array(workflowCustomizationSchema).max(512).parse(operations)
  const definition = structuredClone(base)
  let finalStepOrder: string[] | undefined
  for (const change of changes) {
    switch (change.op) {
      case 'set-subscriptions':
        definition.subscriptions = change.subscriptions
        break
      case 'put-participant':
        definition.participants[change.id] = change.participant
        break
      case 'remove-participant':
        if (!Object.hasOwn(definition.participants, change.id)) throw new Error(`Unknown participant '${change.id}'`)
        delete definition.participants[change.id]
        break
      case 'put-step': {
        const index = definition.steps.findIndex((step) => step.id === change.step.id)
        if (index === -1) definition.steps.push(change.step)
        else definition.steps[index] = change.step
        break
      }
      case 'update-step': {
        const index = definition.steps.findIndex((step) => step.id === change.id)
        if (index === -1) throw new Error(`Unknown step '${change.id}'`)
        definition.steps[index] = { ...definition.steps[index]!, ...change.changes } as WorkflowStep
        break
      }
      case 'set-outcome':
      case 'remove-outcome': {
        const step = definition.steps.find((step) => step.id === change.id)
        if (!step) throw new Error(`Unknown step '${change.id}'`)
        if (change.op === 'set-outcome') step.outcomes[change.outcome] = change.transition
        else {
          if (!Object.hasOwn(step.outcomes, change.outcome)) throw new Error(`Unknown outcome '${change.outcome}'`)
          delete step.outcomes[change.outcome]
        }
        break
      }
      case 'remove-step': {
        const index = definition.steps.findIndex((step) => step.id === change.id)
        if (index === -1) throw new Error(`Unknown step '${change.id}'`)
        definition.steps.splice(index, 1)
        break
      }
      case 'set-entry':
        definition.entry = change.entry
        break
      case 'set-name':
        definition.name = change.name
        break
      case 'set-step-order': {
        finalStepOrder = change.ids
        break
      }
      case 'set-routing':
        definition.routing = change.routing
        break
      case 'set-limits':
        definition.limits = change.limits
        break
      case 'set-completion':
        definition.completion = change.completion
        break
    }
  }
  if (finalStepOrder) {
    const steps = new Map(definition.steps.map((step) => [step.id, step]))
    const requested = new Set(finalStepOrder)
    const missing = [...steps.keys()].filter((id) => !requested.has(id))
    const unknown = [...requested].filter((id) => !steps.has(id))
    const seen = new Set<string>()
    const duplicated = new Set<string>()
    for (const id of finalStepOrder) {
      if (seen.has(id)) duplicated.add(id)
      seen.add(id)
    }
    const duplicates = [...duplicated]
    if (missing.length || unknown.length || duplicates.length) {
      const details = [
        missing.length && `Missing: ${missing.join(', ')}.`,
        unknown.length && `Unknown: ${unknown.join(', ')}.`,
        duplicates.length && `Duplicates: ${duplicates.join(', ')}.`,
      ].filter(Boolean)
      throw new Error(`Step order must include every step exactly once in the final graph. ${details.join(' ')}`)
    }
    definition.steps = finalStepOrder.map((id) => steps.get(id)!)
  }
  return workflowDefinitionSchema.parse(definition)
}

/** Explicit squad policy for creating work from an integration output. */
export const workflowEventTriggerSchema = z
  .object({
    id: identifier,
    source: integrationSubscriptionSchema.shape.source,
    match: z
      .record(
        integrationDataPathSchema,
        z.object({ value: z.union([z.string().max(2000), z.number().finite(), z.boolean()]) }).strict()
      )
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Use 1–16 matches'),
    create: z
      .object({
        workflow: workflowSourceSchema,
        titlePrefix: z.string().max(100).default(''),
        additionalContext: z.string().trim().max(10000).optional(),
        metadata: z
          .record(integrationDataPathSchema, z.object({ event: integrationDataPathSchema }).strict())
          .refine(
            (value) =>
              Object.keys(value).length <= 16 &&
              Object.keys(value).every(
                (path) => !['completion', 'sources', 'sourceWarnings', 'tracked'].includes(path.split('.')[0]!)
              ),
            'Use at most 16 non-reserved metadata bindings'
          ),
      })
      .strict(),
  })
  .strict()
export type WorkflowEventTrigger = z.infer<typeof workflowEventTriggerSchema>
