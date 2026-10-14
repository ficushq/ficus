import { and, eq } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  advanceWorkflowRun,
  describeWorkflowDecision,
  effectiveWorkflowStep,
  routeWorkflowDecision,
  workflowIncomingAttempts,
  type DecisionRequest,
  type WorkflowAttempt,
  type WorkflowCommand,
  type WorkflowDecisionRecord,
  type WorkflowDecisionReply,
  type WorkflowDecisionStep,
  type WorkflowRun,
} from '@ficus/shared'
import { db, squads, workStreams, workStreamFlowRuns, workStreamFlowTransitions } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { decide, type DecideOptions } from '../decisions/service'
import { closeOpenWaits, listOpenWaits } from '../work-streams/waits'
import { waitsForAttempt } from '../work-streams/wait-scope'
import { workflowFingerprint } from './catalog'
import { deliveryInstructionsForRun } from './completion-prompt'

/*
 * Decision steps: no agent works on them. When a run reaches one, the worker asks the
 * `workflow-steps` decision providers its questions (outside any transaction), then applies the
 * routed outcome in one transaction fenced on the attempt still running undecided, with the
 * same locks and transition receipt as an agent's advance. The receipt's request ID is derived
 * from the attempt, so a retry, a restart or a second evaluator can never advance it twice.
 * Without a usable answer and no fallback outcome, the attempt records why and waits for a
 * person through the human-approval wait (execution.ts dispatches it).
 */

const log = createLogger('workflow-decisions')

/** The decision actor in transition receipts; never an authorization identity. */
export const DECISION_ACTOR_KEY = 'workflow:decision-model'

export type DecideFn = (
  purpose: 'workflow-steps',
  request: DecisionRequest,
  options: DecideOptions
) => Promise<WorkflowDecisionReply>

export interface DecisionStepOptions {
  /** Tests inject a stub; production asks the configured decision providers. */
  decide?: DecideFn
}

type Stream = typeof workStreams.$inferSelect

/** One transition receipt per decision attempt: a deterministic UUID, like flow wait references. */
export function decisionRequestId(workStreamId: string, attemptId: number): string {
  const hash = workflowFingerprint({ workStreamId, attemptId, kind: 'decision-step' })
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** What the model sees: only the inputs the step selects, as data. */
export function decisionStepRequest(
  stream: Pick<Stream, 'title' | 'description' | 'handoffMessage'>,
  state: WorkflowRun,
  attempt: WorkflowAttempt,
  step: WorkflowDecisionStep
): DecisionRequest {
  const input: Record<string, unknown> = {}
  for (const source of step.input) {
    if (source === 'title') input.title = stream.title
    else if (source === 'description') input.description = stream.description ?? ''
    else if (source === 'handoff') input.handoff = stream.handoffMessage ?? ''
    else
      input.incomingResults = workflowIncomingAttempts(state, attempt)
        .filter((entry) => entry.evidence || entry.feedback)
        .map((entry) => ({
          step: entry.stepId,
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
          result: entry.evidence ?? entry.feedback,
        }))
  }
  return { state: input, questions: step.questions }
}

function decisionStep(state: WorkflowRun, attempt: WorkflowAttempt): WorkflowDecisionStep | undefined {
  const step = effectiveWorkflowStep(state, attempt)
  return step.kind === 'decision' ? step : undefined
}

/** Running decision attempts that still need a decision and are not blocked by another wait. */
async function pendingDecisions(id: string) {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, id))
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
  if (!stream || !run?.activated || stream.pause || stream.status !== 'active' || run.state.status !== 'running')
    return []
  const pending: Array<{ attempt: WorkflowAttempt; step: WorkflowDecisionStep; request: DecisionRequest }> = []
  for (const attempt of activeWorkflowAttempts(run.state)) {
    const step = decisionStep(run.state, attempt)
    if (!step || attempt.decision) continue
    if ((await waitsForAttempt(db, id, attempt.id)).length > 0) continue
    pending.push({ attempt, step, request: decisionStepRequest(stream, run.state, attempt, step) })
  }
  return pending
}

/**
 * Apply a decision to its attempt, at most once. Returns whether this call changed the run: false
 * when the attempt was already decided, superseded, paused or blocked meanwhile.
 */
export async function applyDecision(id: string, attemptId: number, reply: WorkflowDecisionReply): Promise<boolean> {
  const callbacks: Array<() => void> = []
  const { dispatchFlow } = await import('./execution')
  const applied = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ squadId: workStreams.squadId }).from(workStreams).where(eq(workStreams.id, id))
    if (!owner) return null
    // Same lock order as advanceFlow: squad, stream, run.
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, owner.squadId)).for('update')
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id)).for('update')
    const [run] = await tx
      .select()
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, id))
      .for('update')
    if (!stream || !run?.activated || stream.pause || stream.status !== 'active' || run.state.status !== 'running')
      return null
    const attempt = activeWorkflowAttempts(run.state).find((entry) => entry.id === attemptId)
    const step = attempt && decisionStep(run.state, attempt)
    if (!attempt || !step || attempt.decision) return null
    if ((await waitsForAttempt(tx, id, attemptId)).length > 0) return null
    const requestId = decisionRequestId(id, attemptId)
    const [prior] = await tx
      .select({ version: workStreamFlowTransitions.version })
      .from(workStreamFlowTransitions)
      .where(and(eq(workStreamFlowTransitions.workStreamId, id), eq(workStreamFlowTransitions.requestId, requestId)))
    if (prior) return null

    let record = routeWorkflowDecision(step, reply)
    const waitForPerson = (reason?: string): WorkflowDecisionRecord => {
      if (reason) log.warn('Decision step falls back to a person', { workStreamId: id, attemptId, reason })
      const { outcome: _outcome, ...rest } = record
      return { ...rest, awaitingPerson: true }
    }
    // A live revision may have removed the routed outcome since the attempt started.
    if (record.outcome && !Object.hasOwn(step.outcomes, record.outcome))
      record = waitForPerson(`outcome '${record.outcome}' no longer exists`)

    let state: WorkflowRun | undefined
    let command: WorkflowCommand | undefined
    if (record.outcome) {
      command = {
        action: 'complete',
        expectedVersion: run.version,
        attemptId,
        outcome: record.outcome,
        evidence: describeWorkflowDecision(step, record),
        resume: false,
      }
      try {
        state = advanceWorkflowRun(run.state, command)
      } catch (error) {
        record = waitForPerson((error as Error).message)
        state = undefined
      }
    }
    if (!state) {
      // No version change: the attempt keeps running and its human wait opens on dispatch.
      const waiting = structuredClone(run.state)
      waiting.attempts.find((entry) => entry.id === attemptId)!.decision = record
      await tx
        .update(workStreamFlowRuns)
        .set({ state: waiting, updatedAt: new Date() })
        .where(eq(workStreamFlowRuns.workStreamId, id))
      await dispatchFlow(tx, stream, { ...run, state: waiting }, callbacks)
      return { stream, state: waiting, version: run.version }
    }
    state.attempts.find((entry) => entry.id === attemptId)!.decision = record
    await tx
      .update(workStreamFlowRuns)
      .set({ state, version: state.version, updatedAt: new Date() })
      .where(eq(workStreamFlowRuns.workStreamId, id))
    const activeIds = new Set(activeWorkflowAttempts(state).map((entry) => entry.id))
    for (const wait of await listOpenWaits(tx, id))
      if (wait.flowAttemptId != null && !activeIds.has(wait.flowAttemptId))
        await closeOpenWaits(tx, { waitId: wait.id }, 'cleared', {
          note: 'Flow attempt superseded; this wait no longer blocks work.',
        })
    await dispatchFlow(tx, stream, { ...run, state, version: state.version }, callbacks)
    await tx.insert(workStreamFlowTransitions).values({
      workStreamId: id,
      requestId,
      requestHash: workflowFingerprint({ command, actor: DECISION_ACTOR_KEY }),
      command: command!,
      actorKey: DECISION_ACTOR_KEY,
      version: state.version,
      stateStatus: state.status,
      activeAttemptId: state.activeAttemptId,
    })
    return { stream, state, version: state.version }
  })
  callbacks.forEach((callback) => callback())
  if (!applied) return false
  await finishDecidedDeliverable(id, applied.state, applied.version)
  const { deliverFlow } = await import('./execution')
  await deliverFlow(id)
  const { reconcileOutputDeliveries } = await import('../integrations/outputs/runtime')
  await reconcileOutputDeliveries(id)
  eventEmitter.emit('workStream.updated', { workStreamId: id, squadId: applied.stream.squadId })
  return true
}

/**
 * A deliverable flow that a decision finishes has no agent left to call finish, so finish it
 * like the advance route does for the person or agent whose outcome made it completion-ready.
 */
async function finishDecidedDeliverable(id: string, state: WorkflowRun, version: number) {
  if (state.status !== 'completion-ready' || state.definition.completion.mode !== 'deliverable') return
  const stream = await WorkStream.mustFind(id)
  if (!deliveryInstructionsForRun(stream, state, version)) return
  try {
    await stream.update(
      { status: 'done' },
      { actorAgentId: null, flowCompletion: { version, metadataHash: workflowFingerprint(stream.metadata) } }
    )
  } catch (error) {
    log.warn('A decided deliverable flow could not finish automatically', { workStreamId: id, error })
  }
}

/** Ask, then apply, every decision the run is waiting on, following chains of decision steps. */
async function evaluate(id: string, options: DecisionStepOptions): Promise<number> {
  const ask: DecideFn = options.decide ?? decide
  let decided = 0
  // Each round decides at least one attempt; decision steps cannot loop without an agent step between.
  for (let round = 0; round < 64; round++) {
    const pending = await pendingDecisions(id)
    if (!pending.length) break
    let progressed = false
    for (const { attempt, step, request } of pending) {
      let reply: WorkflowDecisionReply
      try {
        reply = await ask('workflow-steps', request, {
          source: { kind: 'workflow-step', workStreamId: id, stepId: step.id, attemptId: String(attempt.id) },
        })
      } catch (error) {
        // A malformed request or an internal failure is no answer, not a reason to retry forever.
        reply = {
          ok: false,
          reason: 'unavailable',
          errors: [{ providerId: 'core', error: error instanceof Error ? error.message : String(error) }],
        }
      }
      if (await applyDecision(id, attempt.id, reply)) {
        decided++
        progressed = true
      }
    }
    if (!progressed) break
  }
  return decided
}

const running = new Map<string, Promise<number>>()
const again = new Set<string>()

/**
 * Evaluate a work stream's pending decision steps. Calls for the same stream coalesce: one runs,
 * and a call during it schedules exactly one more pass, so no event is lost and no attempt is
 * asked twice in this process. Other processes are fenced by applyDecision.
 */
export async function evaluateFlowDecisions(id: string, options: DecisionStepOptions = {}): Promise<number> {
  const current = running.get(id)
  if (current) {
    again.add(id)
    return current
  }
  const pass = (async () => {
    let decided = 0
    try {
      do {
        again.delete(id)
        decided += await evaluate(id, options)
      } while (again.has(id))
    } finally {
      running.delete(id)
    }
    return decided
  })()
  running.set(id, pass)
  return pass
}

let registered = false

/** Worker: evaluate decision steps as soon as a run changes, not only on the periodic reconcile. */
export function registerDecisionStepHandlers(): void {
  if (registered) return
  registered = true
  const onChange = ({ workStreamId }: { workStreamId: string }) => {
    evaluateFlowDecisions(workStreamId).catch((error) =>
      log.warn('Decision step evaluation deferred', { workStreamId, error })
    )
  }
  eventEmitter.on('workStream.created', onChange)
  eventEmitter.on('workStream.updated', onChange)
  eventEmitter.on('workStream.reopened', onChange)
}
