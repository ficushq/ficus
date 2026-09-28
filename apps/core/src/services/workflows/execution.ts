import { flowWaitReference, isDeliveryApprovalWait } from './wait-policy'
import { deliveryInstructionsForRun } from './completion-prompt'
import { isWorkflowReviewer } from './reviewers'
import { flowMessage } from './handoff-prompt'
import { waitsForAttempt, isCurrentWaitAttempt, flowInboxTargets } from '../work-streams/wait-scope'
import { checkWorkflowScope } from './access'
import { createLogger } from '../../lib/infra/logger'
import { and, eq } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  deliveryPullRequests,
  type WorkflowAttempt,
  advanceWorkflowRun,
  reopenWorkflowRun,
  createWorkflowRun,
  workflowCommandSchema,
  type WorkflowSource,
  type WorkflowRun,
} from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  modelTiers,
  squads,
  workStreams,
  workStreamFlowRuns,
  workStreamFlowTransitions,
  workflowBindings,
  inbox,
  type DbTx,
} from '../../db'
import { deliverInboxMessagesToAgent } from '../inbox/inboxDelivery'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { InboxMessage } from '../../entities/InboxMessage'
import { WorkStream, WorkStreamOpenWaitsError } from '../../entities/WorkStream'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { hasPermission, type Identity } from '../rbac'
import { openWait, closeOpenWaits, listOpenWaits } from '../work-streams/waits'
import { resetContinuationCycle } from '../work-streams/continuation-state'
import { resolveStoredWorkflow, validateWorkflowParticipants, WorkflowError, workflowFingerprint } from './catalog'
import { codeHostingRegistry } from '../integrations/code-hosting'
import { recordDeliveryVerification } from '../work-streams/delivery-pull-requests'
import { recordChangeRequestBinding } from '../work-streams/change-request-binding'
import { resolveBranchChangeRequest } from '@ficus/shared'

const log = createLogger('workflows')

type Stream = typeof workStreams.$inferSelect
type Run = typeof workStreamFlowRuns.$inferSelect
export const actorKey = (identity: Identity) =>
  identity.type === 'user'
    ? `user:${identity.userId}`
    : identity.type === 'agent'
      ? `agent:${identity.agentId}`
      : identity.type === 'system'
        ? `system:${identity.systemTokenId}`
        : 'legacy'
export async function getFlow(id: string) {
  return (await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id)))[0] ?? null
}

async function snapshotParticipants(
  tx: DbTx,
  definition: WorkflowRun['definition'],
  previous: Run['participantSnapshots'] = {},
  previousDefinition?: WorkflowRun['definition']
) {
  await validateWorkflowParticipants(definition, tx)
  const result: Run['participantSnapshots'] = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key.startsWith('attempt:'))
  )
  for (const [id, participant] of Object.entries(definition.participants)) {
    const old = previous[id]
    if (
      old?.id === participant.agentTypeId &&
      workflowFingerprint(previousDefinition?.participants[id]) === workflowFingerprint(participant)
    ) {
      result[id] = old
      continue
    }
    const [row] = await tx.select().from(agentTypes).where(eq(agentTypes.id, participant.agentTypeId))
    if (!row || row.disabled) throw new WorkflowError('Agent type is unavailable')
    const tierSlug = participant.tier ?? row.tier
    const [tier] = tierSlug ? await tx.select().from(modelTiers).where(eq(modelTiers.slug, tierSlug)) : []
    if (participant.tier && (!tier || tier.disabled))
      throw new WorkflowError(`Model tier '${participant.tier}' does not exist or is disabled`)
    const model = participant.tier
      ? tier!.chain
      : row.model || (tier && !tier.disabled ? tier.chain : '') || process.env.DEFAULT_MODEL || ''
    if (!model || model.length > 500)
      throw new WorkflowError(`Agent type '${row.id}' needs a valid model chain of at most 500 characters`)
    // Freeze the role/settings and tier choice, not the mutable tier mapping.
    result[id] = participant.tier ? { ...row, model: '', tier: participant.tier } : { ...row, model, tier: null }
  }
  return result
}

export async function attachFlow(tx: DbTx, stream: Stream, source: WorkflowSource) {
  await checkWorkflowScope(source, stream.squadId, stream.requestingUserId, tx)
  const resolved = await resolveStoredWorkflow(source, tx)
  const participantSnapshots = await snapshotParticipants(tx, resolved.definition)
  const [run] = await tx
    .insert(workStreamFlowRuns)
    .values({
      workStreamId: stream.id,
      activated: true,
      source: resolved,
      participantSnapshots,
      state: createWorkflowRun(resolved.definition),
      createdBy: stream.creatorAgentId
        ? `agent:${stream.creatorAgentId}`
        : `user:${stream.requestingUserId ?? 'system'}`,
      createRequestId: crypto.randomUUID(),
      createRequestHash: workflowFingerprint(source),
    })
    .returning()
  await tx
    .update(workStreams)
    .set({ metadata: { ...(stream.metadata as object), completion: { mode: resolved.definition.completion.mode } } })
    .where(eq(workStreams.id, stream.id))
  return run!
}

/** Immediate self-handoffs are recorded in the attempt; other handoffs use durable inbox intents. */
type AssignmentCaller = { agentId: string; requestId: string }

function responseAssignments(id: string, run: Run, requestId: string, identity: Identity) {
  const assignments = run.state.attempts.flatMap((attempt) => {
    const delivery = attempt.responseAssignment
    return delivery?.requestId === requestId && identity.type === 'agent' && delivery.agentId === identity.agentId
      ? [
          {
            workStreamId: id,
            attemptId: attempt.id,
            stepId: attempt.stepId,
            version: delivery.version,
            content: delivery.content,
          },
        ]
      : []
  })
  return assignments.length ? { assignments } : {}
}

export async function dispatchFlow(
  tx: DbTx,
  stream: Stream,
  run: Run,
  afterCommit: Array<() => void>,
  caller?: AssignmentCaller
) {
  if (!run.activated || stream.pause || ['done', 'canceled'].includes(stream.status)) return
  const deliveryReference = flowWaitReference(stream.id, 'delivery', 0)
  if (run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval') {
    if (!(await listOpenWaits(tx, stream.id)).some((wait) => wait.referenceId === deliveryReference))
      await openWait(tx, {
        workStreamId: stream.id,
        type: 'manual',
        resolutionHandler: 'workflow',
        referenceId: deliveryReference,
        message: 'The work is complete and needs human delivery approval. Review the results, then complete delivery.',
      })
    return
  }
  await closeOpenWaits(tx, { workStreamId: stream.id, referenceId: deliveryReference }, 'cleared', {
    note: 'Delivery approval no longer applies to this flow.',
  })
  if (run.state.status === 'paused') {
    await tx.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, stream.id))
    const referenceId = flowWaitReference(stream.id, 'limit', run.version)
    if (!(await listOpenWaits(tx, stream.id)).some((w) => w.referenceId === referenceId))
      await openWait(tx, {
        workStreamId: stream.id,
        type: 'manual',
        resolutionHandler: 'workflow',
        referenceId,
        message: `Flow paused: ${JSON.stringify(run.state.pauseReason)}. An authorized flow revision is required.`,
      })
    return
  }
  if (run.state.status !== 'running' || stream.status !== 'active') return
  const previousAssignee = stream.assigneeAgentId
  for (const attempt of activeWorkflowAttempts(run.state)) {
    await dispatchFlowAttempt(tx, stream, run, attempt, afterCommit, caller)
    stream = (await tx.select().from(workStreams).where(eq(workStreams.id, stream.id)))[0]!
    run = (await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id)))[0]!
  }
  let primary: string | null = null
  for (const attempt of activeWorkflowAttempts(run.state)) {
    const agentId = run.attemptAgents[String(attempt.id)]
    if (agentId && (await waitsForAttempt(tx, stream.id, attempt.id)).length === 0) {
      primary = agentId
      break
    }
  }
  await tx.update(workStreams).set({ assigneeAgentId: primary }).where(eq(workStreams.id, stream.id))
  if (primary && primary !== previousAssignee) await resetContinuationCycle(tx, stream.id, primary)
}
async function dispatchFlowAttempt(
  tx: DbTx,
  stream: Stream,
  run: Run,
  attempt: WorkflowAttempt,
  afterCommit: Array<() => void>,
  caller?: AssignmentCaller
) {
  if (attempt.responseAssignment) return
  const step = attempt.step ?? run.state.definition.steps.find((entry) => entry.id === attempt.stepId)!
  if (step.kind === 'human-approval') {
    const referenceId = flowWaitReference(stream.id, 'human', attempt.id)
    if (!(await listOpenWaits(tx, stream.id)).some((w) => w.referenceId === referenceId))
      await openWait(tx, {
        workStreamId: stream.id,
        type: 'manual',
        resolutionHandler: 'workflow',
        flowAttemptId: attempt.id,
        referenceId,
        message: step.instructions,
      })
    await tx.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, stream.id))
    return
  }
  if ((await waitsForAttempt(tx, stream.id, attempt.id)).length > 0) return
  const [sent] = await tx
    .select({ id: inbox.id })
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `flow:${stream.id}:${attempt.id}`))
  if (sent) return
  const participant = attempt.participant ?? run.state.definition.participants[step.participant]!
  const agentSnapshot = run.participantSnapshots[`attempt:${attempt.id}`] ?? run.participantSnapshots[step.participant]!
  const snapshotKey = workflowFingerprint(agentSnapshot)
  const restart =
    run.state.attempts.findLast(
      (entry) =>
        entry.freshSession &&
        entry.step?.kind === 'agent' &&
        entry.step.participant === step.participant &&
        JSON.stringify(entry.branch) === JSON.stringify(attempt.branch)
    )?.id ?? 0
  const bindingKey = `${attempt.branch ? `branch-${attempt.branch.forkId}-${attempt.branch.branchId}:` : ''}${step.participant}:${snapshotKey}:${participant.session === 'fresh-per-attempt' ? attempt.id : `reuse-${restart}`}`
  let [binding] = await tx
    .select()
    .from(workflowBindings)
    .where(and(eq(workflowBindings.workStreamId, stream.id), eq(workflowBindings.bindingKey, bindingKey)))
  if (!binding) {
    if (!agentSnapshot) throw new WorkflowError('Missing participant snapshot')
    const [agent] = await tx
      .insert(agents)
      .values({
        agentTypeId: agentSnapshot.id,
        squadId: stream.squadId,
        persist: false,
        modelOverride: agentSnapshot.tier ? null : agentSnapshot.model,
        metadata: {
          name: `${step.participant} · ${stream.title.slice(0, 60)}`,
          resourceGeneration: crypto.randomUUID(),
        },
      })
      .returning()
    ;[binding] = await tx
      .insert(workflowBindings)
      .values({
        workStreamId: stream.id,
        participantId: step.participant,
        bindingKey,
        agentId: agent!.id,
        agentSnapshot,
      })
      .returning()
  }
  const attemptAgents = { ...run.attemptAgents, [attempt.id]: binding!.agentId }
  await tx.update(workStreamFlowRuns).set({ attemptAgents }).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  const crew = [...new Set([...(stream.agentIds ?? []), binding!.agentId])]
  await tx
    .update(workStreams)
    .set({ assigneeAgentId: binding!.agentId, agentIds: crew, updatedAt: new Date() })
    .where(eq(workStreams.id, stream.id))
  if (caller?.agentId === binding!.agentId) {
    // dispatchFlow reloads the run between parallel siblings; update that current
    // state, not an attempt object from the loop's original snapshot.
    run.state.attempts.find((entry) => entry.id === attempt.id)!.responseAssignment = {
      requestId: caller.requestId,
      agentId: binding!.agentId,
      version: run.version,
      content: flowMessage(stream, run, attempt),
    }
    await tx.update(workStreamFlowRuns).set({ state: run.state }).where(eq(workStreamFlowRuns.workStreamId, stream.id))
    return
  }
  await InboxMessage.persistSystemAgentOnceInTransaction(
    tx,
    {
      recipientId: binding!.agentId,
      subject: `Flow step: ${step.id}`,
      content: flowMessage(stream, run, attempt),
      metadata: { workStreamId: stream.id, squadId: stream.squadId, source: 'workflow', attemptId: attempt.id },
      wakeEligible: true,
      recordOnly: true,
    },
    `flow:${stream.id}:${attempt.id}`,
    afterCommit
  )
}

export async function ensureFlowDispatch(id: string): Promise<boolean> {
  const flow = await getFlow(id)
  if (!flow?.activated) return false
  const callbacks: Array<() => void> = []
  await db.transaction(async (tx) => {
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    const [run] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, id))
      .for('update')
    if (stream && run) await dispatchFlow(tx, stream, run, callbacks)
  })
  callbacks.forEach((callback) => callback())
  await deliverFlow(id)
  const { reconcileOutputDeliveries } = await import('../integrations/outputs/runtime')
  await reconcileOutputDeliveries(id)
  return true
}

export async function advanceFlow(id: string, input: unknown, requestId: string, identity: Identity) {
  const command = workflowCommandSchema.parse(input)
  const streamBefore = await WorkStream.mustFind(id)
  const canRevise = await hasPermission(identity, 'workstreams:revise-flow', streamBefore.squadId)
  const canRespond = await hasPermission(identity, 'workstreams:respond', streamBefore.squadId)
  const canReview = identity.type === 'user' && (await isWorkflowReviewer(identity.userId, streamBefore.squadId))
  const canUpdate = await hasPermission(identity, 'workstreams:update', streamBefore.squadId)
  // A human who may approve delivery (finishFlow) may also send it back.
  const canDecideDelivery = identity.type === 'user' && (canRespond || canUpdate)
  if (
    command.action === 'revise'
      ? !canRevise && !(identity.type === 'agent' && canRespond)
      : command.action === 'rework'
        ? !canRevise && !canDecideDelivery && !(identity.type === 'agent' && canRespond)
        : !canReview && !canRespond && !canUpdate
  )
    throw new WorkflowError('Forbidden', 403)
  const actor = actorKey(identity)
  const fingerprint = workflowFingerprint({ command, actor })
  const callbacks: Array<() => void> = []
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, streamBefore.squadId)).for('update')
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    const [run] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, id))
      .for('update')
    if (!stream || !run?.activated) throw new WorkflowError('Flow not found', 404)
    const [prior] = await tx
      .select()
      .from(workStreamFlowTransitions)
      .where(and(eq(workStreamFlowTransitions.workStreamId, id), eq(workStreamFlowTransitions.requestId, requestId)))
    if (prior) {
      if (prior.requestHash !== fingerprint) throw new WorkflowError('Request ID already used', 409)
      return {
        version: prior.version,
        stateStatus: prior.stateStatus,
        activeAttemptId: prior.activeAttemptId,
        ...responseAssignments(id, run, requestId, identity),
      }
    }
    if (stream.pause && command.action !== 'revise')
      throw new WorkflowError('Work stream is paused; resume before advancing', 409)
    if (['done', 'canceled'].includes(stream.status)) throw new WorkflowError('Stream is terminal', 409)
    if (command.expectedVersion !== run.version) throw new WorkflowError('Stale flow version', 409)
    const attempt = run.state.attempts.find((a) => a.id === command.attemptId)
    const step = attempt?.step ?? run.state.definition.steps.find((s) => s.id === attempt?.stepId)
    if (
      stream.status === 'queued' &&
      step?.kind === 'agent' &&
      command.action !== 'revise' &&
      command.action !== 'rework'
    )
      throw new WorkflowError('Resume queued work before advancing its active step', 409)
    if (
      command.action === 'revise' &&
      !canRevise &&
      (identity.type !== 'agent' ||
        run.state.definition.routing.mode !== 'adaptive' ||
        run.attemptAgents[String(command.attemptId)] !== identity.agentId)
    )
      throw new WorkflowError('Only the active participant of an adaptive flow can revise future work', 403)
    if (command.action === 'rework') {
      const decidingDelivery =
        canDecideDelivery && (await listOpenWaits(tx, id)).some((wait) => isDeliveryApprovalWait(id, wait))
      if (
        !canRevise &&
        !decidingDelivery &&
        (identity.type !== 'agent' || run.attemptAgents[String(command.attemptId)] !== identity.agentId)
      )
        throw new WorkflowError(
          'Only the delivery participant, a delivery approver, or a flow manager can request rework',
          403
        )
    } else if (command.action !== 'revise') {
      if (step?.kind === 'human-approval') {
        if (
          identity.type !== 'user' ||
          !canReview ||
          (step.approver === 'assigned-reviewers' &&
            stream.assignedReviewerIds.length > 0 &&
            !stream.assignedReviewerIds.includes(identity.userId))
        )
          throw new WorkflowError('This step requires its designated human approver', 403)
      } else if (identity.type === 'agent' && run.attemptAgents[String(command.attemptId)] !== identity.agentId)
        throw new WorkflowError('Only the active participant can advance this attempt', 403)
      else if (identity.type !== 'agent' && !(await hasPermission(identity, 'workstreams:revise-flow', stream.squadId)))
        throw new WorkflowError('Flow intervention requires management permission', 403)
    }
    if (command.action !== 'revise' && attempt) {
      const waits =
        command.action === 'rework'
          ? (await listOpenWaits(tx, id)).filter(
              (wait) => wait.flowAttemptId == null && !isDeliveryApprovalWait(id, wait)
            )
          : await waitsForAttempt(tx, id, attempt.id)
      if (
        waits.some(
          (wait) =>
            !(
              step?.kind === 'human-approval' &&
              wait.resolutionHandler === 'workflow' &&
              wait.referenceId === flowWaitReference(id, 'human', attempt.id)
            )
        )
      )
        throw new WorkflowError('Resolve the waits blocking this attempt before advancing', 409)
    }
    let state: WorkflowRun
    try {
      state = advanceWorkflowRun(run.state, command)
    } catch (error) {
      throw new WorkflowError((error as Error).message, 409)
    }
    if (command.action === 'rework') {
      for (const wait of await listOpenWaits(tx, id)) {
        if (isDeliveryApprovalWait(id, wait))
          await closeOpenWaits(tx, { workStreamId: id, waitId: wait.id }, 'sent_back', { note: command.feedback })
      }
    }
    if (command.action === 'revise' && !canRevise) {
      const previous = run.state.definition
      const weakens = previous.steps.some((entry) => {
        const next = state.definition.steps.find((step) => step.id === entry.id)
        return (
          !next ||
          next.kind !== entry.kind ||
          (entry.kind === 'agent' &&
            workflowFingerprint(state.definition.participants[entry.participant]) !==
              workflowFingerprint(previous.participants[entry.participant])) ||
          workflowFingerprint({ ...next, outcomes: entry.outcomes }) !== workflowFingerprint(entry)
        )
      })
      if (
        weakens ||
        command.active !== 'keep' ||
        state.definition.completion.mode !== previous.completion.mode ||
        (state.definition.limits.maxStepAttempts ?? Infinity) > (previous.limits.maxStepAttempts ?? Infinity) ||
        state.definition.limits.maxDelegations > previous.limits.maxDelegations ||
        (state.definition.limits.maxParallelAttempts ?? Infinity) > (previous.limits.maxParallelAttempts ?? Infinity) ||
        state.definition.routing.delegation !== previous.routing.delegation
      )
        throw new WorkflowError(
          'Changing existing steps, active work, limits, or delivery policy requires flow management permission',
          403
        )
    }
    const participantSnapshots = await snapshotParticipants(
      tx,
      state.definition,
      run.participantSnapshots,
      run.state.definition
    )
    if (command.action === 'revise') {
      for (const kept of activeWorkflowAttempts(run.state)) {
        if (kept.id === command.attemptId && command.active === 'restart') continue
        const keptStep = kept.step ?? run.state.definition.steps.find((entry) => entry.id === kept.stepId)
        if (keptStep?.kind === 'agent')
          participantSnapshots[`attempt:${kept.id}`] =
            run.participantSnapshots[`attempt:${kept.id}`] ?? run.participantSnapshots[keptStep.participant]!
      }
      for (const wait of await listOpenWaits(tx, id))
        if (
          wait.referenceId === flowWaitReference(id, 'limit', run.version) ||
          (command.active === 'restart' && attempt && wait.referenceId === flowWaitReference(id, 'human', attempt.id))
        )
          await closeOpenWaits(tx, { waitId: wait.id }, 'cleared', { note: command.reason })
      if (command.active === 'restart' && attempt) {
        const agentId = run.attemptAgents[String(attempt.id)]
        if (agentId)
          await tx
            .update(inbox)
            .set({ readAt: new Date() })
            .where(eq(inbox.idempotencyKey, `flow:${id}:${attempt.id}`))
      }
    } else if (step?.kind === 'human-approval')
      await closeOpenWaits(
        tx,
        { workStreamId: id, referenceId: flowWaitReference(id, 'human', attempt!.id) },
        'approved',
        {
          note: command.action === 'complete' ? command.evidence : 'Returned for rework',
        }
      )
    const activeIds = new Set(activeWorkflowAttempts(state).map((entry) => entry.id))
    for (const wait of await listOpenWaits(tx, id)) {
      if (wait.flowAttemptId != null && !activeIds.has(wait.flowAttemptId))
        await closeOpenWaits(tx, { waitId: wait.id }, 'cleared', {
          note: 'Flow attempt superseded; this wait no longer blocks work.',
        })
    }
    const updated = { ...run, state, participantSnapshots, version: state.version }
    await tx
      .update(workStreamFlowRuns)
      .set({ state, participantSnapshots, version: state.version, updatedAt: new Date() })
      .where(eq(workStreamFlowRuns.workStreamId, id))
    await tx
      .update(workStreams)
      .set({ metadata: { ...(stream.metadata as object), completion: { mode: state.definition.completion.mode } } })
      .where(eq(workStreams.id, id))
    await dispatchFlow(
      tx,
      stream,
      updated,
      callbacks,
      identity.type === 'agent' ? { agentId: identity.agentId, requestId } : undefined
    )
    const receipt = { version: state.version, stateStatus: state.status, activeAttemptId: state.activeAttemptId }
    await tx
      .insert(workStreamFlowTransitions)
      .values({ workStreamId: id, requestId, requestHash: fingerprint, command, actorKey: actor, ...receipt })
    const [dispatched] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
    return { ...receipt, ...responseAssignments(id, dispatched!, requestId, identity) }
  })
  callbacks.forEach((callback) => callback())
  if (command.action === 'rework') {
    const { promoteEligibleQueuedStreams } = await import('../work-streams/admission')
    await promoteEligibleQueuedStreams(streamBefore.squadId)
  }
  await deliverFlow(id)
  const { reconcileOutputDeliveries } = await import('../integrations/outputs/runtime')
  await reconcileOutputDeliveries(id)
  eventEmitter.emit('workStream.updated', { workStreamId: id, squadId: streamBefore.squadId })
  return result
}

/** Mandatory at the entity boundary, including callers outside HTTP routes. */
export async function guardFlowMutation(
  tx: DbTx,
  stream: Stream,
  input: Record<string, unknown>,
  approval = false,
  permit?: { version: number; metadataHash: string }
) {
  const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
  if (!run?.activated) return
  if (stream.pause && input.status === 'done') throw new WorkflowError('Resume paused work before completing it', 409)
  if (
    approval ||
    (input.assigneeAgentId !== undefined && input.status !== 'canceled') ||
    input.agentIds !== undefined ||
    input.completionMode !== undefined
  )
    throw new WorkflowError('Use the flow transition API to change flow ownership or gates', 409)
  if (input.metadata && typeof input.metadata === 'object' && 'completion' in input.metadata)
    throw new WorkflowError('Flow completion policy is controlled by its definition', 409)
  if (input.status === 'done' && run.state.status !== 'completion-ready')
    throw new WorkflowError('Required flow steps and return obligations must finish first', 409)
  if (
    input.status === 'done' &&
    (!permit || permit.version !== run.version || permit.metadataHash !== workflowFingerprint(stream.metadata))
  )
    throw new WorkflowError('Use flow completion to evaluate the configured delivery policy', 409)
  // The verified finish permit closes only the workflow's delivery approval wait,
  // in the same transaction as completion. Unrelated blockers still prevent finish.
  if (input.status === 'done' && permit)
    await closeOpenWaits(
      tx,
      { workStreamId: stream.id, referenceId: flowWaitReference(stream.id, 'delivery', 0) },
      'approved',
      { note: 'Human approved delivery.' }
    )
}

export async function finishFlow(id: string, version: number, identity: Identity) {
  let stream = await WorkStream.mustFind(id)
  if (
    !(await hasPermission(identity, 'workstreams:update', stream.squadId)) &&
    !(await hasPermission(identity, 'workstreams:respond', stream.squadId))
  )
    throw new WorkflowError('Forbidden', 403)
  const run = await getFlow(id)
  if (!run?.activated || run.version !== version || run.state.status !== 'completion-ready')
    throw new WorkflowError('Flow is not ready for completion or its version changed', 409)
  if (identity.type === 'agent' && !(stream.agentIds ?? []).includes(identity.agentId))
    throw new WorkflowError('Only a participant can finish this flow', 403)
  let deliveredHead: string | undefined
  const mode = run.state.definition.completion.mode
  let metadata = stream.metadata as Record<string, any>
  if (mode === 'review-approval' && identity.type !== 'user')
    throw new WorkflowError('A human must approve delivery', 403)
  if (['pr-merge', 'pr-auto-merge', 'direct-merge'].includes(mode)) {
    const binding = codeHostingRegistry.resolve(metadata)
    if (!binding) throw new WorkflowError(codeHostingRegistry.explainMissingBinding(metadata, id))
    let { reference, adapter } = binding
    if (mode === 'direct-merge') {
      const head = metadata.git?.commit,
        base = metadata.git?.baseBranch
      if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head) || typeof base !== 'string' || !base.trim())
        throw new WorkflowError('Direct merge requires codeHost.repository, git.commit (full SHA), and git.baseBranch')
      if (!(await adapter.containsCommit(reference, stream.squadId, base, head)))
        throw new WorkflowError('The deliverable commit must be included in the base branch', 409)
      deliveredHead = head
    } else {
      // Finish-time resolution: when the binding has no change request, ask the code host which
      // pull request the stream's branch carries (owner-namespace scoped, so forks never match)
      // and persist the answer. The manual bind remains an override, not a required step.
      if (!reference.changeRequest) {
        const branch = typeof metadata.git?.branch === 'string' ? metadata.git.branch.trim() : ''
        const resolution = resolveBranchChangeRequest({
          branch: branch || undefined,
          baseBranch:
            typeof metadata.git?.baseBranch === 'string' && metadata.git.baseBranch.trim()
              ? metadata.git.baseBranch.trim()
              : undefined,
          repository: reference.repository,
          candidates: branch ? await adapter.changeRequestsByHead(reference, stream.squadId, branch) : [],
        })
        if (resolution.status !== 'chosen')
          throw new WorkflowError(codeHostingRegistry.explainMissingChangeRequest(id, metadata, resolution))
        await recordChangeRequestBinding(id, reference, resolution.candidate)
        // Re-read so the finish permit hashes the stored metadata, exactly like merge evidence.
        stream = await WorkStream.mustFind(id)
        metadata = stream.metadata as Record<string, any>
        const resolved = codeHostingRegistry.resolve(metadata)
        if (!resolved) throw new WorkflowError(codeHostingRegistry.explainMissingBinding(metadata, id))
        ;({ reference, adapter } = resolved)
      }
      if (!reference.changeRequest) throw new WorkflowError('Delivery change request resolution produced no binding')
      const change = await adapter.changeRequest(reference, stream.squadId)
      // A null lookup is a distinct failure class from an unmerged change request: the binding
      // exists but cannot be verified at all, so the repair is connection/access, not merging.
      if (!change)
        throw new WorkflowError(
          `Could not verify delivery pull request ${reference.repository}#${reference.changeRequest.number} through the ${reference.integration} integration: it is missing, inaccessible to the squad's connection, or the connection is unavailable`,
          409
        )
      if (!change.merged) throw new WorkflowError('The change request must be merged before completion', 409)
      if (change.headSha && /^[a-f0-9]{40}$/.test(change.headSha)) deliveredHead = change.headSha
      if (
        (metadata.git?.branch && change.headBranch !== metadata.git.branch) ||
        (metadata.git?.baseBranch && change.baseBranch !== metadata.git.baseBranch)
      )
        throw new WorkflowError('Change request does not match this work stream branch', 409)
      // Additional designated delivery pull requests only add a merge requirement: branch identity
      // and the delivered head stay the primary change request's alone.
      const verified: Array<{ key: string; state: 'merged'; headSha?: string }> = []
      for (const resource of deliveryPullRequests(metadata)) {
        if (resource.source === 'delivery') {
          verified.push({ key: resource.key, state: 'merged', ...(change.headSha ? { headSha: change.headSha } : {}) })
          continue
        }
        // No adapter means no evidence, and no evidence means not merged.
        const additional = await codeHostingRegistry.adapterFor(resource.integration)?.changeRequest(
          {
            integration: resource.integration,
            repository: resource.repository,
            changeRequest: { number: resource.number },
            ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
          },
          stream.squadId
        )
        if (!additional)
          throw new WorkflowError(
            `Delivery pull request ${resource.repository}#${resource.number} could not be verified through the ${resource.integration} integration: it is missing, inaccessible to the squad's connection, or the connection is unavailable`,
            409
          )
        if (!additional.merged)
          throw new WorkflowError(
            `Delivery pull request ${resource.repository}#${resource.number} must be merged before completion`,
            409
          )
        verified.push({
          key: resource.key,
          state: 'merged',
          ...(additional.headSha ? { headSha: additional.headSha } : {}),
        })
      }
      // Record before the finish permit is computed, then re-read so the permit hashes stored metadata.
      await recordDeliveryVerification(id, verified)
      stream = await WorkStream.mustFind(id)
    }
  }
  try {
    await stream.update(
      { status: 'done' },
      {
        actorAgentId: identity.type === 'agent' ? identity.agentId : null,
        flowCompletion: { version, metadataHash: workflowFingerprint(stream.metadata), deliveredHead },
      }
    )
  } catch (error) {
    if (error instanceof WorkStreamOpenWaitsError) throw new WorkflowError(error.message, 409)
    throw error
  }
  return stream.toJson()
}

export async function reconcileFlows() {
  const { reconcileUnmatchedOutputs, reconcileParkedOutputDeliveries } = await import('../integrations/outputs/runtime')
  await reconcileUnmatchedOutputs()
  await reconcileParkedOutputDeliveries()
  const rows = await db
    .select({ id: workStreamFlowRuns.workStreamId })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .where(and(eq(workStreamFlowRuns.activated, true), eq(workStreams.status, 'active')))
  for (const row of rows) {
    try {
      await ensureFlowDispatch(row.id)
    } catch (error) {
      log.warn(`Flow dispatch deferred for ${row.id}`, error)
    }
  }
}

export async function flowAgentType(agentId: string): Promise<AgentType | null> {
  const [binding] = await db.select().from(workflowBindings).where(eq(workflowBindings.agentId, agentId))
  if (!binding) return null
  const [current] = await db.select().from(agentTypes).where(eq(agentTypes.id, binding.agentSnapshot.id))
  if (!current || current.disabled) throw new WorkflowError('Flow participant agent type was disabled')
  let model = binding.agentSnapshot.model
  if (binding.agentSnapshot.tier) {
    const [tier] = await db.select().from(modelTiers).where(eq(modelTiers.slug, binding.agentSnapshot.tier))
    if (!tier || tier.disabled)
      throw new WorkflowError(`Model tier '${binding.agentSnapshot.tier}' does not exist or is disabled`)
    if (!tier.chain || tier.chain.length > 500)
      throw new WorkflowError('Workflow model tier needs a valid chain of at most 500 characters')
    model = tier.chain
  }
  const agentSnapshot = {
    ...binding.agentSnapshot,
    // The runner keeps this resolved copy for its execution; persisted bindings retain the tier.
    model,
    tier: null,
    skills: (binding.agentSnapshot.skills ?? []).filter(
      (skill) => !['subagent-driven-development', 'executing-plans'].includes(skill)
    ),
    toolsAllow: current.toolsAllow
      ? binding.agentSnapshot.toolsAllow
        ? binding.agentSnapshot.toolsAllow.filter((tool) => current.toolsAllow!.includes(tool))
        : current.toolsAllow
      : binding.agentSnapshot.toolsAllow,
    toolsDeny: [...new Set([...(binding.agentSnapshot.toolsDeny ?? []), ...(current.toolsDeny ?? [])])],
  }
  return new AgentType(agentSnapshot)
}

export async function flowWorkerContext(agentId: string) {
  const [binding] = await db.select().from(workflowBindings).where(eq(workflowBindings.agentId, agentId))
  if (!binding) return null
  const run = await getFlow(binding.workStreamId)
  if (!run) return null
  const stream = await WorkStream.find(binding.workStreamId)
  return {
    workStreamId: binding.workStreamId,
    participantId: binding.participantId,
    state: run.state,
    deliveryInstructions: stream ? deliveryInstructionsForRun(stream, run.state, run.version) : undefined,
  }
}

export async function forbidUntrackedDelegation(agentId: string) {
  const [binding] = await db
    .select({ id: workflowBindings.agentId })
    .from(workflowBindings)
    .where(eq(workflowBindings.agentId, agentId))
  if (binding) throw new WorkflowError('Use the workflow delegate transition so the result and return are tracked')
}

/** Retry committed inbox intents without creating agents for queued or future work. */
async function deliverFlow(id: string) {
  const run = await getFlow(id)
  if (!run?.activated || run.state.status !== 'running') return
  for (const canceled of run.state.attempts.filter((entry) => entry.status === 'canceled')) {
    const oldId = run.attemptAgents[String(canceled.id)]
    if (!oldId) continue
    const old = await Agent.find(oldId)
    const execution = await old?.getActiveExecution()
    if (execution) {
      await execution.requestStopWithSignal()
      if (await old!.getActiveExecution()) return
    }
  }
  const stream = await WorkStream.mustFind(id)
  if (stream.status !== 'active' || stream.pause) return
  for (const attempt of activeWorkflowAttempts(run.state)) {
    const agentId = run.attemptAgents[String(attempt.id)]
    if (agentId && (await waitsForAttempt(db, id, attempt.id)).length === 0) await deliverInboxMessagesToAgent(agentId)
  }
}

export async function isCurrentFlowMessage(message: { id?: string; metadata: unknown; recipientId: string | null }) {
  const metadata = message.metadata as {
    source?: string
    workStreamId?: string
    attemptId?: number
    integrationDeliveryId?: string
  } | null
  if (metadata?.source === 'integration-output') {
    if (!metadata.integrationDeliveryId || !message.id || !message.recipientId) return false
    const { isCurrentIntegrationDelivery } = await import('../integrations/outputs/runtime')
    return isCurrentIntegrationDelivery(db, metadata.integrationDeliveryId, message.recipientId, message.id)
  }
  if (metadata?.source === 'work-stream-resume' && metadata.workStreamId) {
    const stream = await WorkStream.find(metadata.workStreamId)
    return !!stream && stream.status === 'active' && !stream.pause
  }
  if (metadata?.source === 'agent-question-answer' && message.id && message.recipientId) {
    for (const target of await flowInboxTargets(db, [message.id]))
      if (!(await isCurrentWaitAttempt(db, target.workStreamId, target.attemptId, message.recipientId))) return false
  }
  if (metadata?.source === 'workflow-wait-resolution')
    return (
      !!metadata.workStreamId &&
      !!metadata.attemptId &&
      !!message.recipientId &&
      isCurrentWaitAttempt(db, metadata.workStreamId, metadata.attemptId, message.recipientId)
    )
  if (metadata?.source !== 'workflow') return true
  if (
    metadata.workStreamId &&
    metadata.attemptId &&
    (await waitsForAttempt(db, metadata.workStreamId, metadata.attemptId)).length > 0
  )
    return false
  if (!metadata.workStreamId) return false
  const run = await getFlow(metadata.workStreamId)
  const stream = await WorkStream.find(metadata.workStreamId)
  return !!(
    run?.activated &&
    stream?.status === 'active' &&
    !stream.pause &&
    run.state.status === 'running' &&
    activeWorkflowAttempts(run.state).some((attempt) => attempt.id === metadata.attemptId) &&
    run.attemptAgents[String(metadata.attemptId)] === message.recipientId
  )
}

export async function reopenFlow(tx: DbTx, id: string) {
  const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id)).for('update')
  if (!run?.activated) return
  const state = reopenWorkflowRun(run.state)
  await tx
    .update(workStreamFlowRuns)
    .set({ state, version: state.version, updatedAt: new Date() })
    .where(eq(workStreamFlowRuns.workStreamId, id))
  await tx.update(workStreams).set({ assigneeAgentId: null }).where(eq(workStreams.id, id))
}

export async function guardFlowWaitResolution(tx: DbTx, id: string, waitId?: string) {
  const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
  if (!run?.activated) return
  const refs = new Set([
    flowWaitReference(id, 'delivery', 0),
    flowWaitReference(id, 'limit', run.version),
    ...activeWorkflowAttempts(run.state).map((attempt) => flowWaitReference(id, 'human', attempt.id)),
  ])
  const waits = await listOpenWaits(tx, id)
  if (waits.some((wait) => (!waitId || wait.id === waitId) && wait.referenceId && refs.has(wait.referenceId)))
    throw new WorkflowError('Use the workflow decision or revision to resolve this flow wait', 409)
}
