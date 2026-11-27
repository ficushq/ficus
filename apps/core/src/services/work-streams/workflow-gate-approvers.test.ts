import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import { squads, workStreamFlowRuns, workStreams, workStreamWaits } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import {
  createBlankWorkflow,
  createWorkflowRun,
  resolveWorkflow,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
} from '@ficus/shared'
import { flowWaitReference } from '../workflows/wait-policy'
import { loadWorkflowGateApprovers, workflowGateStepsSql, type WorkStreamWaitRow } from './waits'

describe('workflow gate approvers', () => {
  let testPrefix: string
  let squad: Squad

  beforeEach(async () => {
    testPrefix = `wsgate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'gate approver tests' })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  /** A blank flow plus the named gate steps, with one running attempt per extra step (IDs 2, 3, ...). */
  function gatedRun(steps: WorkflowDefinition['steps']) {
    const definition = createBlankWorkflow()
    const ids = steps.map((step) => step.id)
    definition.steps[0]!.outcomes = {
      completed: ids.length === 1 ? { next: ids[0]! } : { parallel: ids, join: 'finish' },
    }
    definition.steps.push(...steps)
    const parsed = workflowDefinitionSchema.parse(definition)
    const state = createWorkflowRun(parsed)
    const { step: _agentStep, ...first } = state.attempts[0]!
    steps.forEach((step, index) => state.attempts.push({ ...first, id: index + 2, stepId: step.id, status: 'running' }))
    return { definition: parsed, state }
  }

  async function streamWithRun(title: string, run?: { definition: WorkflowDefinition; state: WorkflowRun }) {
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} ${title}` })
    if (run)
      await db.insert(workStreamFlowRuns).values({
        workStreamId: ws.id,
        activated: true,
        state: run.state,
        source: resolveWorkflow({ kind: 'inline', definition: run.definition }),
        createRequestId: crypto.randomUUID(),
        createRequestHash: 'test',
        createdBy: 'test',
      })
    return ws
  }

  async function gateWaits(workStreamId: string, attemptIds: number[]): Promise<WorkStreamWaitRow[]> {
    return db
      .insert(workStreamWaits)
      .values(
        attemptIds.map((attemptId) => ({
          workStreamId,
          type: 'manual' as const,
          resolutionHandler: 'workflow' as const,
          flowAttemptId: attemptId,
          referenceId: flowWaitReference(workStreamId, 'human', attemptId),
          createdBy: 'system' as const,
        }))
      )
      .returning()
  }

  const approval = (id: string, approver: 'reviewers' | 'assigned-reviewers'): WorkflowStep => ({
    id,
    kind: 'human-approval',
    approver,
    instructions: 'Decide.',
    output: 'A decision.',
    outcomes: { approved: { next: 'finish' } },
  })

  it("reads each gate's step as the run reads it: snapshot first, then the definition", async () => {
    const run = gatedRun([
      approval('open-approval', 'reviewers'),
      approval('assigned-approval', 'assigned-reviewers'),
      approval('revised-approval', 'assigned-reviewers'),
      approval('ghost-approval', 'assigned-reviewers'),
    ])
    // A revision changed this step's approver after its attempt started; the attempt keeps its snapshot.
    run.state.attempts[3]!.step = approval('revised-approval', 'reviewers')
    // The step this attempt runs is no longer in the definition.
    run.state.attempts[4]!.stepId = 'removed-step'
    // A decision step waiting on a person is decided by anyone with review permission.
    run.state.definition.steps.push({
      ...approval('decide', 'assigned-reviewers'),
      kind: 'decision',
    } as unknown as WorkflowStep)
    run.state.attempts.push({ ...run.state.attempts[1]!, id: 6, stepId: 'decide' })
    const ws = await streamWithRun('gate steps', run)
    const gates = await gateWaits(ws.id, [2, 3, 4, 5, 6, 99])
    const [question] = await db
      .insert(workStreamWaits)
      .values({ workStreamId: ws.id, type: 'question', flowAttemptId: 2, createdBy: 'agent' })
      .returning()
    const noRunStream = await streamWithRun('no run')
    const [orphan] = await gateWaits(noRunStream.id, [2])

    const approvers = await loadWorkflowGateApprovers([...gates, question!, orphan!])
    const byAttempt = Object.fromEntries(gates.map((gate) => [gate.flowAttemptId, approvers.get(gate.id)]))
    expect(byAttempt).toEqual({
      2: 'reviewers',
      3: 'assigned-reviewers',
      4: 'reviewers',
      5: undefined,
      6: 'reviewers',
      99: undefined,
    })
    // Not a gate wait, no run, an unknown step or an unknown attempt: no approver.
    expect(approvers.has(question!.id)).toBe(false)
    expect(approvers.has(orphan!.id)).toBe(false)
    expect(await loadWorkflowGateApprovers([question!])).toEqual(new Map())
  })

  it('returns only the step fields, not the run state, however large the run has grown', async () => {
    const run = gatedRun([approval('scope-approval', 'assigned-reviewers')])
    const [template] = run.state.attempts
    // A long-lived run: thousands of completed attempts carrying sizeable evidence.
    for (let id = 3; id < 3003; id++)
      run.state.attempts.push({ ...template!, id, status: 'completed', evidence: `${id} `.repeat(200) })
    const ws = await streamWithRun('large run', run)
    const [gate] = await gateWaits(ws.id, [2])

    const stateBytes = JSON.stringify(run.state).length
    expect(stateBytes).toBeGreaterThan(1_000_000)
    const rows = await db.execute(workflowGateStepsSql([gate!.id]))
    expect([...rows]).toEqual([{ wait_id: gate!.id, kind: 'human-approval', approver: 'assigned-reviewers' }])
    expect(JSON.stringify([...rows]).length).toBeLessThan(200)
    expect(await loadWorkflowGateApprovers([gate!])).toEqual(new Map([[gate!.id, 'assigned-reviewers']]))

    // The plan projects only the wait ID and the step's two fields, never the state column itself.
    const [explained] = await db.execute(sql`EXPLAIN (VERBOSE, FORMAT JSON) ${workflowGateStepsSql([gate!.id])}`)
    const output: string[] = (explained!['QUERY PLAN'] as any)[0].Plan.Output
    expect(output).toHaveLength(3)
    expect(output.some((column) => /^\(?run\.state\)?$/.test(column))).toBe(false)

    // What the old lookup shipped to Core for the same wait: the whole run state.
    const [oldRow] = await db
      .select({ state: workStreamFlowRuns.state })
      .from(workStreamFlowRuns)
      .where(inArray(workStreamFlowRuns.workStreamId, [ws.id]))
    expect(JSON.stringify(oldRow!.state).length).toBeGreaterThan(1_000_000)
  })
})
