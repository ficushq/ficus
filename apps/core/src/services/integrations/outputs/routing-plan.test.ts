import { expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
import {
  db,
  squads,
  agents,
  agentTypes,
  workStreams,
  workStreamFlowRuns,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationOutputTriggerRuns,
  inbox,
} from '../../../db'
import * as planning from './routing-plan'
import { eventRuleTrigger } from './default-routing'

async function fixture() {
  const squadId = crypto.randomUUID(),
    managerId = crypto.randomUUID(),
    typeId = crypto.randomUUID(),
    connectionId = crypto.randomUUID()
  const streams: string[] = [],
    events: string[] = []
  await db.insert(agentTypes).values({ id: typeId, name: typeId, systemPrompt: 'Test', model: 'test' })
  await db.insert(squads).values({
    id: squadId,
    name: 'Routing plan',
    purpose: 'Test',
    metadata: {
      integrationRules: {
        github: [
          {
            id: 'first',
            enabled: true,
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            filters: { audience: 'any' },
            predicates: [],
            action: { type: 'notify-manager' },
          },
          {
            id: 'second',
            enabled: true,
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            filters: { audience: 'any' },
            predicates: [],
            action: { type: 'notify-consultant' },
          },
        ],
      },
    },
  })
  await db.insert(agents).values({ id: managerId, name: 'Manager', squadId, agentTypeId: typeId, status: 'idle' })
  await db.update(squads).set({ managerAgentId: managerId }).where(eq(squads.id, squadId))
  return {
    squadId,
    managerId,
    connectionId,
    async event(projection?: string) {
      const [row] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: crypto.randomUUID(),
          authority: { kind: 'connection', squadId, connectionId },
          fact: {
            output: 'pull_request.comment',
            version: 1,
            eventKey: crypto.randomUUID(),
            resourceKey: 'acme/project#3',
            occurredAt: new Date().toISOString(),
            data: {
              repository: 'acme/project',
              pullRequest: { number: 3 },
              actor: 'outside',
              actorType: 'User',
              ...(projection ? { projection } : {}),
            },
            subject: 'HELD_SUBJECT',
            body: 'HELD_SENTINEL',
          },
        })
        .returning()
      events.push(row!.id)
      return row!
    },
    async stream(flow = false, status: 'active' | 'queued' | 'done' | 'canceled' = 'active', pause = false) {
      const id = crypto.randomUUID()
      await db.insert(workStreams).values({
        id,
        squadId,
        title: 'Test',
        status,
        ...(pause
          ? {
              pause: {
                id: crypto.randomUUID(),
                reason: 'Test',
                pausedAt: new Date().toISOString(),
                parkAt: null,
                agentIds: [],
              },
            }
          : {}),
        assigneeAgentId: managerId,
        metadata: {
          tracked: [
            { integration: 'github', repository: 'acme/project', kind: 'pull_request', number: 3, connectionId },
          ],
        },
      })
      streams.push(id)
      if (flow) {
        const definition = createBlankWorkflow()
        definition.subscriptions = [
          {
            id: 'feedback',
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            match: { repository: { value: 'acme/project' }, 'pullRequest.number': { value: 3 } },
            deliver: { to: 'active', whenInactive: 'retain' },
          },
        ]
        await db.insert(workStreamFlowRuns).values({
          workStreamId: id,
          version: 1,
          activated: true,
          state: createWorkflowRun(definition),
          attemptAgents: {},
          createRequestId: crypto.randomUUID(),
          createRequestHash: 'a'.repeat(64),
          createdBy: 'test',
          source: { schemaVersion: 1, definition, source: { kind: 'inline' } },
        })
      }
      return id
    },
    async effects() {
      return {
        inbox: (await db.select().from(inbox).where(eq(inbox.recipientId, managerId))).length,
        deliveries: (
          await db
            .select()
            .from(integrationOutputDeliveries)
            .where(inArray(integrationOutputDeliveries.eventId, events))
        ).length,
        triggers: (
          await db.select().from(integrationOutputTriggerRuns).where(eq(integrationOutputTriggerRuns.squadId, squadId))
        ).length,
        consultants: (
          await db
            .select()
            .from(agents)
            .where(and(eq(agents.squadId, squadId), eq(agents.agentTypeId, 'consultant')))
        ).length,
        streams: (await db.select().from(workStreams).where(eq(workStreams.squadId, squadId))).length,
      }
    },
    async close() {
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, events))
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    },
  }
}

test('planning preserves first matching squad rule with no inbox, consultant, stream, trigger or delivery effects', async () => {
  expect(planning.planOutputRouting).toBeDefined()
  const h = await fixture()
  try {
    const event = await h.event()
    const before = await h.effects()
    const plan = await planning.planOutputRouting(event, async () => true)
    expect(plan.routes).toContainEqual({ kind: 'notify-manager', id: 'first', recipientId: h.managerId })
    expect(JSON.stringify(plan)).not.toContain('HELD')
    expect(await h.effects()).toEqual(before)
    expect(plan.relevant).toBe(true)
  } finally {
    await h.close()
  }
})

test('tracked pre-flow route owns default audience; paused/parked subscriptions remain relevant without effects', async () => {
  const h = await fixture()
  try {
    const preflow = await h.stream()
    const queued = await h.stream(true, 'queued')
    const paused = await h.stream(true, 'active', true)
    await h.stream(true, 'done')
    await h.stream(true, 'canceled')
    const event = await h.event()
    const before = await h.effects()
    const plan = await planning.planOutputRouting(event, async () => true)
    expect(plan.routes).toContainEqual({
      kind: 'pre-flow',
      id: preflow,
      workStreamId: preflow,
      recipientId: h.managerId,
    })
    expect(
      plan.routes
        .filter((route) => route.kind === 'subscription')
        .map((route) => route.workStreamId)
        .sort()
    ).toEqual([queued, paused].sort())
    expect(plan.routes.some((route) => route.kind === 'notify-manager')).toBe(false)
    expect(await h.effects()).toEqual(before)
  } finally {
    await h.close()
  }
})

test('authorization failure, self-echo and no audience produce no relevant plan', async () => {
  const h = await fixture()
  try {
    const event = await h.event()
    expect((await planning.planOutputRouting(event, async () => false)).relevant).toBe(false)
    event.fact.data.actor = 'outside'
    expect((await planning.planOutputRouting(event, async () => true, { login: 'outside' })).relevant).toBe(false)
    await db.update(squads).set({ managerAgentId: null, metadata: {} }).where(eq(squads.id, h.squadId))
    expect((await planning.planOutputRouting(event, async () => true)).relevant).toBe(false)
  } finally {
    await h.close()
  }
})

test('status projection cannot execute content rules, start-work or arbitrary bindings', async () => {
  const h = await fixture()
  try {
    const event = await h.event('status')
    const metadata = {
      integrationRules: {
        github: [
          {
            id: 'start',
            enabled: true,
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            filters: { audience: 'any' },
            predicates: [],
            action: { type: 'start-workstream', metadata: { injected: { event: 'workflow' } } },
          },
        ],
      },
    }
    await db.update(squads).set({ metadata }).where(eq(squads.id, h.squadId))
    expect(eventRuleTrigger(metadata, event, '')).toBeUndefined()
    expect((await planning.planOutputRouting(event, async () => true)).routes).toEqual([])
  } finally {
    await h.close()
  }
})

test('ignored/disabled first rules have no fallback audience', async () => {
  const h = await fixture()
  try {
    const event = await h.event()
    for (const rules of [
      [
        {
          id: 'ignore',
          enabled: true,
          source: { integration: 'github', output: 'pull_request.comment', version: 1 },
          filters: { audience: 'any' },
          action: { type: 'ignore' },
        },
      ],
      [],
    ]) {
      await db
        .update(squads)
        .set({ metadata: { integrationRules: { github: rules } } })
        .where(eq(squads.id, h.squadId))
      expect((await planning.planOutputRouting(event, async () => true)).relevant).toBe(false)
    }
  } finally {
    await h.close()
  }
})

test('query-only branch discovery requires an actual future subscription audience and never writes a binding', async () => {
  const h = await fixture()
  try {
    await db
      .update(squads)
      .set({ metadata: { integrationRules: { github: [] } } })
      .where(eq(squads.id, h.squadId))
    const streamId = await h.stream(true)
    const metadata = {
      codeHost: { integration: 'github', repository: 'acme/project', connectionId: h.connectionId },
      git: { branch: 'work/feedback', baseBranch: 'main' },
    }
    await db.update(workStreams).set({ metadata }).where(eq(workStreams.id, streamId))
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
    const state = run!.state
    state.definition.completion = { ...state.definition.completion, mode: 'pr-merge', followChanges: false }
    state.definition.subscriptions = []
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, streamId))
    const event = await h.event()
    Object.assign(event.fact.data, {
      headBranch: 'work/feedback',
      headRepository: 'acme/project',
      baseBranch: 'main',
      pullRequestState: 'open',
    })
    expect((await planning.planOutputRouting(event, async () => true)).relevant).toBe(false)
    state.definition.completion.followChanges = true
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, streamId))
    const plan = await planning.planOutputRouting(event, async () => true)
    expect(plan.routes.some((route) => route.kind === 'delivery-branch' && route.workStreamId === streamId)).toBe(true)
    expect((await db.select().from(workStreams).where(eq(workStreams.id, streamId)))[0]!.metadata).toEqual(metadata)
    expect(await h.effects()).toMatchObject({ inbox: 0, deliveries: 0, triggers: 0, consultants: 0, streams: 1 })
  } finally {
    await h.close()
  }
})

test('an explicit flow subscription owns routing even without a tracked-resource match', async () => {
  const h = await fixture()
  try {
    const streamId = await h.stream(true)
    await db.update(workStreams).set({ metadata: {} }).where(eq(workStreams.id, streamId))
    const plan = await planning.planOutputRouting(await h.event(), async () => true)
    expect(plan.routes.some((route) => route.kind === 'subscription' && route.workStreamId === streamId)).toBe(true)
    expect(plan.routes.some((route) => route.kind === 'notify-manager')).toBe(false)
  } finally {
    await h.close()
  }
})

test('a settled resource trigger receipt is not a new creation audience', async () => {
  const h = await fixture()
  try {
    const event = await h.event()
    const metadata = {
      integrationRules: {
        github: [
          {
            id: 'start',
            enabled: true,
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            filters: { audience: 'any' },
            action: { type: 'start-workstream' },
          },
        ],
      },
    }
    await db.update(squads).set({ metadata }).where(eq(squads.id, h.squadId))
    expect(
      (await planning.planOutputRouting(event, async () => true)).routes.some(
        (route) => route.kind === 'start-workstream'
      )
    ).toBe(true)
    await db.insert(integrationOutputTriggerRuns).values({
      squadId: h.squadId,
      triggerId: 'start',
      sourceKey: 'github:any-account',
      resourceKey: event.fact.resourceKey,
      eventId: event.id,
    })
    const plan = await planning.planOutputRouting(event, async () => true)
    expect(plan.relevant).toBe(false)
    expect(await h.effects()).toMatchObject({ inbox: 0, deliveries: 0, triggers: 1, consultants: 0, streams: 0 })
  } finally {
    await h.close()
  }
})
