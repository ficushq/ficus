import { afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
import { db, integrationEventPollingCursors, squads, workStreamFlowRuns, workStreams } from '../../db'
import { listPendingActions } from '../agents/actions'
import { loadDeliveryEvidence } from './delivery-state'

const squadIds: string[] = []
const cursorKeys: string[] = []

afterEach(async () => {
  if (cursorKeys.length)
    await db
      .delete(integrationEventPollingCursors)
      .where(inArray(integrationEventPollingCursors.resourceKey, cursorKeys))
  if (squadIds.length) {
    await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
    await db.delete(squads).where(inArray(squads.id, squadIds))
  }
  squadIds.length = 0
  cursorKeys.length = 0
})

async function squad(metadata: Record<string, unknown>) {
  const id = crypto.randomUUID()
  squadIds.push(id)
  await db.insert(squads).values({ id, name: `Delivery evidence ${id}`, purpose: 'test', metadata })
  return id
}

async function stream(squadId: string, connectionId: string, status: 'completion-ready' | 'running', number = 7) {
  const [row] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: `Delivery ${status}`,
      status: 'active',
      metadata: {
        codeHost: { integration: 'github', repository: 'acme/widgets', connectionId, changeRequest: { number } },
      },
    })
    .returning()
  const definition = createBlankWorkflow()
  definition.completion = { mode: 'pr-merge', followChanges: true }
  await db.insert(workStreamFlowRuns).values({
    workStreamId: row!.id,
    activated: true,
    state: { ...createWorkflowRun(definition), status },
    source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'fixture',
    createdBy: 'test',
  })
  return row!.id
}

/** A polling cursor as the poller keeps it: the snapshot plus its own, much larger, state. */
async function cursor(
  squadId: string,
  connectionId: string,
  number = 7,
  gates = { reviewDecision: 'approved', mergeState: 'clean', checksState: 'success' }
) {
  const resourceKey = `${squadId}:${connectionId}:acme/widgets#${number}`
  cursorKeys.push(resourceKey)
  await db.insert(integrationEventPollingCursors).values({
    providerKey: 'github',
    resourceKey,
    cursor: {
      deliveryPresentation: {
        version: 1,
        squadId,
        connectionId,
        repository: 'acme/widgets',
        number,
        observedAt: new Date().toISOString(),
        draft: false,
        pendingHumanReview: false,
        state: 'open',
        ...gates,
        headSha: 'a'.repeat(40),
      },
      pullRequest: { body: 'x'.repeat(200_000) },
      etags: { '/repos/acme/widgets/pulls/7': 'W/"abc"' },
    },
  })
}

// Every work-stream list and the Action Center read this. It used to pull whole squad
// metadata, every listed run's flow state and whole polling cursors: megabytes per call.
test('delivery evidence covers only completion-ready runs, with the policy flag and the cursor snapshot', async () => {
  const connectionId = crypto.randomUUID()
  const merging = await squad({ policies: { allowAutoMerge: true }, toolingFollowups: 'y'.repeat(100_000) })
  const manual = await squad({ policies: { allowAutoMerge: 'true' } })
  const unset = await squad({})
  const ready = await stream(merging, connectionId, 'completion-ready')
  const running = await stream(merging, connectionId, 'running', 8)
  const readyManual = await stream(manual, connectionId, 'completion-ready')
  const readyUnset = await stream(unset, connectionId, 'completion-ready')
  await cursor(merging, connectionId)
  await cursor(merging, connectionId, 8)

  const evidence = await loadDeliveryEvidence(db, [ready, running, readyManual, readyUnset])
  expect(evidence.map((run) => run.id).sort()).toEqual([ready, readyManual, readyUnset].sort())
  const of = (id: string) => evidence.find((run) => run.id === id)!

  // Only a JSON `true` turns auto-merge on.
  expect(of(ready).policies).toEqual({ allowAutoMerge: true })
  expect(of(readyManual).policies).toEqual({ allowAutoMerge: false })
  expect(of(readyUnset).policies).toEqual({ allowAutoMerge: false })
  expect(of(ready).state.status).toBe('completion-ready')

  // The squad's cursor snapshots arrive as events; another squad's do not.
  const snapshots = of(ready).events.filter((event) => event.output === 'pull_request.snapshot')
  expect(snapshots.map((event) => (event.data.pullRequest as { number: number }).number).sort()).toEqual([7, 8])
  expect(snapshots[0]!.data).toMatchObject({
    repository: 'acme/widgets',
    pullRequestState: 'open',
    reviewDecision: 'approved',
    checksState: 'success',
    mergeState: 'clean',
  })
  expect(of(readyManual).events).toEqual([])

  expect(await loadDeliveryEvidence(db, [running])).toEqual([])
  expect(await loadDeliveryEvidence(db, [])).toEqual([])
})

test('the Action Center lists a pull request awaiting review from the slimmed reads', async () => {
  const connectionId = crypto.randomUUID()
  const squadId = await squad({ toolingFollowups: 'y'.repeat(100_000) })
  const ready = await stream(squadId, connectionId, 'completion-ready')
  await stream(squadId, connectionId, 'running', 8)
  await cursor(squadId, connectionId, 7, { reviewDecision: 'required', mergeState: 'blocked', checksState: 'pending' })

  const actions = (await listPendingActions({ includeDeliveryGates: true })).filter(
    (action) => action.type === 'workstream-delivery' && action.squadId === squadId
  )
  expect(actions).toHaveLength(1)
  expect(actions[0]).toMatchObject({
    id: `workstream-delivery:${ready}:review`,
    squadName: `Delivery evidence ${squadId}`,
    data: {
      workStreamId: ready,
      workStreamTitle: expect.stringContaining('Delivery completion-ready'),
      deliveryKind: 'review',
      pullRequests: [{ repository: 'acme/widgets', number: 7 }],
    },
  })
  // A paused stream is not a person's to merge yet.
  await db
    .update(workStreams)
    .set({ pause: { reason: 'test' } as never })
    .where(eq(workStreams.id, ready))
  expect(
    (await listPendingActions({ includeDeliveryGates: true })).filter((action) => action.squadId === squadId)
  ).toEqual([])
})
