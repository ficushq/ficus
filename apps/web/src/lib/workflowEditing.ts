import { FLOW_START_ID } from './workflowGraph'
import {
  workflowDefinitionSchema,
  workflowParticipantSchema,
  workflowStepSchema,
  type WorkflowDefinition,
} from '@ficus/shared'

/** Copy shared settings for one step without changing other assignments or graph references. */
export function separateWorkflowParticipant(definition: WorkflowDefinition, stepId: string) {
  const draft = structuredClone(definition)
  const step = draft.steps.find((item) => item.id === stepId)
  if (!step || step.kind !== 'agent') throw new Error('Select an agent step.')
  const participant = draft.participants[step.participant]
  if (!participant) throw new Error('This step has no participant settings to copy.')
  if (Object.keys(draft.participants).length >= 64) throw new Error('A workflow can have up to 64 participants.')
  const base = `${step.id.slice(0, 85)}-agent`
  let id = base
  for (let suffix = 2; Object.hasOwn(draft.participants, id); suffix++) id = `${base}-${suffix}`
  draft.participants[id] = structuredClone(participant)
  step.participant = id
  return { definition: draft, participant: id }
}

/** Graph history excludes catalog metadata; revisions still track every edit. */
export function workflowHistoryKey(definition: WorkflowDefinition) {
  return JSON.stringify({ ...definition, name: undefined })
}

export function insertWorkflowStep(definition: WorkflowDefinition, selected: string | undefined, human = false) {
  const draft = structuredClone(definition)
  let index = 1
  const prefix = human ? 'approval' : 'step'
  while (
    draft.steps.some((step) => step.id === `${prefix}-${index}`) ||
    Object.hasOwn(draft.participants, `${prefix}-${index}`)
  )
    index++
  const id = `${prefix}-${index}`
  const previous = draft.steps.find((step) => step.id === selected) ?? draft.steps.at(-1)
  const onward = Object.entries(previous?.outcomes ?? {}).find(([, target]) => 'next' in target)
  const next = onward ? structuredClone(onward[1]) : { next: 'finish' as const }
  if (onward && previous) previous.outcomes[onward[0]] = { next: id }
  if (!human)
    draft.participants[id] = workflowParticipantSchema.parse({
      agentTypeId: 'general',
      session: 'reuse-within-stream',
    })
  if (!previous) draft.entry = id
  draft.steps.push(
    workflowStepSchema.parse({
      id,
      name: human ? `Approval ${index}` : `Step ${index}`,
      ...(human ? { kind: 'human-approval', approver: 'assigned-reviewers' } : { kind: 'agent', participant: id }),
      instructions: human
        ? 'Review the result and approve or request changes.'
        : 'Complete this step and verify the result.',
      output: human ? 'Approval decision and feedback.' : 'Result and evidence.',
      outcomes: { completed: next },
    })
  )
  return { definition: draft, selected: id }
}

export function changedWorkflowSteps(before: WorkflowDefinition, after: WorkflowDefinition) {
  return after.steps
    .filter((step) => {
      const old = before.steps.find((entry) => entry.id === step.id)
      return (
        JSON.stringify(old) !== JSON.stringify(step) ||
        (step.kind === 'agent' &&
          JSON.stringify(before.participants[step.participant]) !==
            JSON.stringify(after.participants[step.participant]))
      )
    })
    .map((step) => step.id)
}

/** Rename the step identity and every typed reference; participant identities remain independent. */
export function renameWorkflowStep(definition: WorkflowDefinition, previous: string, next: string) {
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(next) || ['finish', 'constructor', 'prototype'].includes(next))
    throw new Error('Use a lowercase step ID with optional hyphens.')
  if (next !== previous && definition.steps.some((step) => step.id === next))
    throw new Error('A step already uses that ID.')
  const draft = structuredClone(definition)
  if (draft.entry === previous) draft.entry = next
  if (typeof draft.completion.changeEventsTo === 'object' && draft.completion.changeEventsTo.step === previous)
    draft.completion.changeEventsTo.step = next
  for (const step of draft.steps) {
    if (step.id === previous) step.id = next
    for (const target of Object.values(step.outcomes)) {
      if ('next' in target && target.next === previous) target.next = next
      if ('parallel' in target) {
        target.parallel = target.parallel.map((id) => (id === previous ? next : id))
        if (target.join === previous) target.join = next
      }
      if ('returnTo' in target) {
        if (target.returnTo === previous) target.returnTo = next
      }
    }
  }
  for (const subscription of draft.subscriptions ?? []) {
    const to = subscription.deliver.to
    if (typeof to === 'object' && 'step' in to && to.step === previous) to.step = next
  }
  return draft
}

/** Rewire one handle without discarding return obligations or sibling branches. */
/** Connectivity, not card position, determines whether a wire goes back to earlier work. */
function forwardReachable(definition: WorkflowDefinition, from: string, to: string) {
  const pending = [from]
  const seen = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const step = definition.steps.find((entry) => entry.id === id)
    for (const transition of Object.values(step?.outcomes ?? {})) {
      if ('next' in transition) pending.push(transition.next)
      else if ('parallel' in transition) pending.push(...transition.parallel)
    }
  }
  return false
}

export function connectWorkflowOutcome(
  definition: WorkflowDefinition,
  from: string,
  outcome: string,
  to: string,
  branch?: number | 'join',
  replace = false
) {
  if (from === 'code-host:delivery') {
    if (to !== 'finish' && definition.steps.find((step) => step.id === to)?.kind !== 'agent')
      throw new Error('Send code hosting events to an agent step, or Finish for the delivery owner.')
    return {
      ...definition,
      completion: {
        ...definition.completion,
        followChanges: true,
        changeEventsTo: to === 'finish' ? ('delivery-owner' as const) : { step: to },
      },
    }
  }
  if (from === FLOW_START_ID) {
    if (!definition.steps.some((step) => step.id === to))
      throw new Error('Start must connect to an agent step or approval.')
    return { ...definition, entry: to }
  }
  if (from === to) throw new Error('Connect to a different step. Use a return path for rework.')
  if (to !== 'finish' && !definition.steps.some((step) => step.id === to)) throw new Error('Choose an existing step.')
  const draft = structuredClone(definition)
  const target = draft.steps.find((step) => step.id === from)?.outcomes[outcome]
  if (!target) throw new Error('That outcome changed. Select it again.')
  const rework =
    to !== 'finish' &&
    (forwardReachable(definition, to, from) || ('returnTo' in target && !forwardReachable(definition, from, to)))
  if (rework) {
    if ('parallel' in target)
      throw new Error('Use a separate outcome to request revisions; parallel branches move forward together.')
    draft.steps.find((step) => step.id === from)!.outcomes[outcome] = {
      returnTo: to,
      afterRework: 'returnTo' in target ? (target.afterRework ?? 'follow-graph') : 'follow-graph',
    }
    return draft
  }
  if ('next' in target) {
    if (target.next === to) return draft
    // Delivery is the placeholder on a new outcome; drawing its first wire replaces it.
    if (replace || target.next === 'finish' || to === 'finish') target.next = to
    else
      draft.steps.find((step) => step.id === from)!.outcomes[outcome] = { parallel: [target.next, to], join: 'finish' }
  } else if ('returnTo' in target) {
    draft.steps.find((step) => step.id === from)!.outcomes[outcome] = { next: to }
  } else {
    if (to === 'finish') throw new Error('Parallel branches and joins need a step, not delivery.')
    if (branch === 'join') {
      if (target.parallel.includes(to)) throw new Error('The join must be separate from its branches.')
      target.join = to
    } else if (typeof branch === 'number' && branch >= 0 && branch < target.parallel.length) {
      if (to === target.join)
        throw new Error('Connect this branch to a step that does work before the join, not directly to the join.')
      if (target.parallel.some((id, index) => index !== branch && id === to))
        throw new Error(
          'Each parallel branch needs a different starting step. This step is already connected to another branch.'
        )
      target.parallel[branch] = to
    } else if (branch === undefined) {
      if (target.parallel.includes(to)) throw new Error('This step is already a branch of this outcome.')
      if (target.parallel.length >= 16) throw new Error('An outcome can start up to 16 parallel branches.')
      target.parallel.push(to)
    } else throw new Error('Choose a branch to reconnect.')
  }
  return draft
}

/** Remove a step without inventing a route through an ambiguous branch or return. */
export function removeWorkflowStep(definition: WorkflowDefinition, id: string) {
  const draft = structuredClone(definition)
  const removed = draft.steps.find((step) => step.id === id)
  if (!removed) return draft
  const outcomes = Object.values(removed.outcomes)
  const onward =
    outcomes.length === 1 && outcomes[0] && 'next' in outcomes[0] && outcomes[0].next !== id
      ? outcomes[0].next
      : undefined
  draft.steps = draft.steps.filter((step) => step.id !== id)
  if (typeof draft.completion.changeEventsTo === 'object' && draft.completion.changeEventsTo.step === id) {
    delete draft.completion.changeEventsTo
    draft.completion.followChanges = false
  }
  if (draft.entry === id) draft.entry = onward && onward !== 'finish' ? onward : (draft.steps[0]?.id ?? '')
  for (const step of draft.steps) {
    for (const [name, target] of Object.entries(step.outcomes)) {
      if ('next' in target && target.next === id) {
        if (onward && onward !== step.id) target.next = onward
        else delete step.outcomes[name]
      } else if ('parallel' in target) {
        target.parallel = target.parallel.filter((branch) => branch !== id)
        if (target.parallel.length === 1) step.outcomes[name] = { next: target.parallel[0]! }
        else if (!target.parallel.length) delete step.outcomes[name]
        else if (target.join === id) target.join = onward && onward !== step.id ? onward : 'finish'
      } else if ('returnTo' in target && target.returnTo === id) delete step.outcomes[name]
    }
  }
  // Participants can be shared by other steps or reused later. Keep their configuration.
  return draft
}

/** Canvas shortcuts must not consume native editing keys, including inside embedded assistants. */
export function isWorkflowTextTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-flow-shortcuts="off"]'
    )
  )
}

/** Remove exactly one selected wire; a branch wire does not own its siblings. */
export function removeWorkflowConnection(
  definition: WorkflowDefinition,
  from: string,
  outcome: string,
  branch?: number
) {
  const draft = structuredClone(definition)
  const step = draft.steps.find((step) => step.id === from)
  const target = step?.outcomes[outcome]
  if (!step || !target) return draft
  if (typeof branch === 'number' && 'parallel' in target) {
    if (branch >= 0 && branch < target.parallel.length) {
      target.parallel.splice(branch, 1)
      if (target.parallel.length === 1) step.outcomes[outcome] = { next: target.parallel[0]! }
      else if (!target.parallel.length) delete step.outcomes[outcome]
    }
  } else delete step.outcomes[outcome]
  return draft
}

export interface WorkflowDraftNotice {
  message: string
  hint?: string
}

export function workflowDraftWarning(definition: WorkflowDefinition): WorkflowDraftNotice | undefined {
  if (!definition.steps.length)
    return { message: 'This workflow has no steps.', hint: 'Add an agent step or approval to start this workflow.' }
  for (const step of definition.steps) {
    if (!Object.keys(step.outcomes).length)
      return {
        message: `“${step.id}” has no outgoing connection.`,
        hint: 'Connect an outcome to the next step or Finish, or undo the deletion.',
      }
    for (const [name, target] of Object.entries(step.outcomes)) {
      if ('parallel' in target && target.parallel.length < 2)
        return {
          message: `“${step.id}” → “${name}” needs at least two parallel branches.`,
          hint: 'Add another branch, change its action to Continue, or undo the deletion.',
        }
    }
  }
  const validation = workflowDefinitionSchema.safeParse(definition)
  if (validation.success) return undefined
  const issue = validation.error.issues[0]!
  const branch = issue.message.match(/^Branch '(.+)' must reach join '(.+)'$/)
  if (branch)
    return {
      message: `The “${branch[1]}” branch no longer reaches “${branch[2]}”.`,
      hint: `Reconnect the branch to “${branch[2]}”, or undo the change.`,
    }
  const step =
    issue.path[0] === 'steps' && typeof issue.path[1] === 'number' ? definition.steps[issue.path[1]] : undefined
  if (step && issue.message === `Step '${step.id}' is unreachable from the entry`)
    return {
      message: `“${step.id}” is unreachable from the start.`,
      hint: 'Connect it to a reachable step, remove it, or undo the change.',
    }
  return {
    message: `${step && !issue.message.includes(step.id) ? `“${step.id}”: ` : ''}${issue.message.replace(/[.!]+$/, '')}.`,
    hint: 'Fix this before saving, or undo the change.',
  }
}
