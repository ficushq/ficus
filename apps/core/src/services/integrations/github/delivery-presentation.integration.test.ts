import { githubOutputAdapter } from '../outputs/github'
import { listGitHubPrWorkStreamCandidates } from './database-watch-source'
import { notifyDeliverySnapshotChanged } from './delivery-presentation-store'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  createBlankWorkflow,
  createWorkflowRun,
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  buildWorkInterestSnapshot,
  codeHostDeliveryLabel,
} from '@ficus/shared'
import {
  db,
  squads,
  workStreams,
  workStreamFlowRuns,
  integrationEventPollingCursors,
  integrationOutputEvents,
  integrationOutputDeliveries,
} from '../../../db'
import { WorkStream } from '../../../entities/WorkStream'
import { computeDerivedStates } from '../../work-streams/derived-state'
import { DbEventPollingCursorStore } from '../db-event-polling-cursor-store'
import { createGitHubPlugin } from './plugin'
import { GitHubPrWatchPolicy } from './watch-policy'
import type { EventPollingCapability } from '../types'
import { listPendingActions } from '../../agents/actions'
import { agents, agentTypes, inbox } from '../../../db'
import { Agent } from '../../../entities/Agent'
import { advanceFlow, attachFlow, dispatchFlow, getFlow } from '../../workflows/execution'

const squadId = crypto.randomUUID()
const connectionId = crypto.randomUUID()
const key = `${squadId}:${connectionId}:acme/widgets#7`
let restoreFetch: (() => void) | undefined
afterEach(async () => {
  restoreFetch?.()
  restoreFetch = undefined
  await db.delete(integrationOutputEvents).where(eq(integrationOutputEvents.sourceKey, key))
  await db.delete(integrationEventPollingCursors).where(eq(integrationEventPollingCursors.resourceKey, key))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

test('database delivery watch -> plugin parser -> durable cursor -> serialized attention supports baseline and same-head changes without activity replay', async () => {
  await db.insert(squads).values({ id: squadId, name: 'Delivery snapshot test', purpose: 'test' })
  const [row] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'Delivery',
      status: 'active',
      metadata: {
        codeHost: { integration: 'github', repository: 'acme/widgets', connectionId, changeRequest: { number: 7 } },
      },
    })
    .returning()
  const definition = createBlankWorkflow()
  definition.completion = { mode: 'pr-merge', followChanges: true }
  await db.insert(workStreamFlowRuns).values({
    workStreamId: row!.id,
    activated: true,
    state: { ...createWorkflowRun(definition), status: 'completion-ready' },
    source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'fixture',
    createdBy: 'test',
  })
  expect(
    (await listGitHubPrWorkStreamCandidates()).find((candidate) => candidate.squadId === squadId)?.deliveryPresentation
  ).toBe(true)
  let decision = 'REVIEW_REQUIRED',
    checks = 'SUCCESS',
    merge = 'BLOCKED'
  const head = 'a'.repeat(40)
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname
    const body =
      path === '/graphql'
        ? {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: head,
                  headRefName: 'work',
                  baseRefName: 'main',
                  state: 'OPEN',
                  isDraft: false,
                  mergeStateStatus: merge,
                  reviewDecision: decision,
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] },
                },
              },
            },
          }
        : path.endsWith('/pulls/7')
          ? {
              id: 7,
              number: 7,
              state: 'open',
              merged: false,
              head: { sha: head },
              base: { repo: { full_name: 'acme/widgets' } },
              requested_reviewers: [],
              requested_teams: [],
            }
          : path.endsWith('/issues/7')
            ? { number: 7 }
            : []
    return new Response(JSON.stringify(body), {
      headers: { date: new Date().toUTCString(), 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  restoreFetch = () => fetchMock.mockRestore()
  // Use the same database source, watch conversion, and plugin parse boundary as the runner.
  const policy = new GitHubPrWatchPolicy({
    listWorkStreams: listGitHubPrWorkStreamCandidates,
    resolveConnection: async (id, selected) =>
      id === squadId && selected === connectionId ? { id: connectionId } : undefined,
    lastRealDeliveries: async () => new Map(),
  })
  const watches = await policy.listWatches()
  const watch = watches.find((candidate) => candidate.resourceKey === key)!.connection
  expect(watch.configuration).toMatchObject({ deliveryPresentation: true })
  const poller = createGitHubPlugin(
    { currentUser: async () => ({ version: 1, userId: 42, login: 'fixture' }) },
    async () => 'fixture'
  ).runtime.provider.capabilities.event_polling! as EventPollingCapability
  const older = new Date(Date.now() - 60_000)
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request',
    payload: {
      action: 'opened',
      repository: { full_name: 'acme/widgets' },
      pull_request: {
        id: 7,
        number: 7,
        state: 'open',
        draft: false,
        head: { sha: head },
        mergeable_state: 'clean',
        updated_at: older.toISOString(),
      },
    },
  })
  expect(fact).toBeDefined()
  const [routed] = await db
    .insert(integrationOutputEvents)
    .values({
      integration: 'github',
      sourceKey: key,
      eventKey: fact!.eventKey,
      fact: fact!,
      createdAt: older,
      authority: { kind: 'connection', connectionId, squadId },
    })
    .returning()
  await db.insert(integrationOutputDeliveries).values({
    eventId: routed!.id,
    workStreamId: row!.id,
    subscriptionId: 'fixture',
    status: 'delivered',
    subscription: {
      id: 'fixture',
      source: { integration: 'github', output: 'pull_request.updated', version: 1 },
      match: {},
      deliver: { to: 'active', whenInactive: 'retain' },
    },
  })
  const store = new DbEventPollingCursorStore()
  let notifications = 0
  const stop = eventEmitter.on('workStream.updated', (event) => {
    if (event.workStreamId === row!.id) notifications++
  })
  try {
    for (const [review, check, mergeState, expected, attention, bucket, reason, label] of [
      ['APPROVED', 'PENDING', 'UNKNOWN', 'delivery_external', false, 'externalWait', 'ci-pending', 'Awaiting CI'],
      ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'delivery_external', false, 'externalWait', undefined, null],
      ['REVIEW_REQUIRED', 'PENDING', 'UNKNOWN', 'delivery_review', true, 'needsYou', undefined, null],
      [
        'CHANGES_REQUESTED',
        'SUCCESS',
        'BLOCKED',
        'delivery_failure',
        false,
        'blocked',
        'changes-requested',
        'Changes requested',
      ],
      // Dismissing a rejecting review restores the required-review gate without
      // synthesizing a review event or advancing the workflow.
      ['REVIEW_REQUIRED', 'SUCCESS', 'BLOCKED', 'delivery_review', true, 'needsYou', undefined, null],
      ['APPROVED', 'PENDING', 'BLOCKED', 'delivery_external', false, 'externalWait', 'ci-pending', 'Awaiting CI'],
      ['APPROVED', 'SUCCESS', 'CLEAN', 'delivery_merge', true, 'needsYou', undefined, null],
      ['APPROVED', 'FAILURE', 'UNSTABLE', 'delivery_failure', false, 'blocked', 'ci-failed', 'CI failed'],
      ['APPROVED', 'SUCCESS', 'CLEAN', 'delivery_merge', true, 'needsYou', undefined, null],
    ] as const) {
      decision = review
      checks = check
      merge = mergeState
      const claim = await store.claim('github', key, new Date(), 60_000)
      expect(claim).not.toBeNull()
      const polled = await poller.poll(watch, claim!.cursor)
      expect(polled.events).toEqual([])
      await store.save('github', key, claim!.leaseToken, polled.nextCursor, new Date(0))
      const before = notifications
      await notifyDeliverySnapshotChanged(
        { providerKey: 'github', resourceKey: key, active: true, connection: watch },
        claim!.cursor,
        polled.nextCursor
      )
      expect(notifications).toBe(before + 1)
      await notifyDeliverySnapshotChanged(
        { providerKey: 'github', resourceKey: key, active: true, connection: watch },
        polled.nextCursor,
        polled.nextCursor
      )
      expect(notifications).toBe(before + 1)
      const stream = await WorkStream.mustFind(row!.id)
      const json = { ...stream.toJson(), ...(await computeDerivedStates([stream])).get(stream.id) }
      expect(selectWorkStreamPresentationState(json)).toBe(expected)
      const wire = JSON.parse(JSON.stringify(json))
      expect(wire.delivery?.explanation?.codeHostReason).toBe(reason)
      expect(codeHostDeliveryLabel(wire.delivery)).toBe(label)
      expect(buildWorkInterestSnapshot([json]).top[0]?.delivery).toEqual(json.delivery)
      expect(workStreamNeedsHumanAttention(json)).toBe(attention)
      expect(buildWorkInterestSnapshot([json]).liveActivity.top[0]?.bucket).toBe(bucket)
    }
    await db.delete(integrationOutputEvents).where(eq(integrationOutputEvents.sourceKey, key))
    const [cached] = await db
      .select()
      .from(integrationEventPollingCursors)
      .where(eq(integrationEventPollingCursors.resourceKey, key))
    const current = cached!.cursor as Record<string, any>
    await db
      .update(integrationEventPollingCursors)
      .set({ cursor: {} })
      .where(eq(integrationEventPollingCursors.resourceKey, key))
    const beforeClear = notifications
    await notifyDeliverySnapshotChanged(
      { providerKey: 'github', resourceKey: key, active: true, connection: watch },
      current,
      {}
    )
    expect(notifications).toBe(beforeClear + 1)
    for (const overrides of [
      { observedAt: new Date(Date.now() - 600_000).toISOString() },
      { connectionId: crypto.randomUUID() },
      { squadId: crypto.randomUUID() },
    ]) {
      await db
        .update(integrationEventPollingCursors)
        .set({ cursor: { ...current, deliveryPresentation: { ...current.deliveryPresentation, ...overrides } } })
        .where(eq(integrationEventPollingCursors.resourceKey, key))
      const stream = await WorkStream.mustFind(row!.id)
      expect((await computeDerivedStates([stream])).get(stream.id)?.delivery).toEqual({
        kind: 'external',
        explanation: { pullRequests: [{ number: 7, state: 'open' }] },
      })
    }
    // An expired observation that last proved a required human review keeps the
    // stream in Needs you (and the web pending actions) until newer evidence clears it.
    await db
      .update(integrationEventPollingCursors)
      .set({
        cursor: {
          ...current,
          deliveryPresentation: {
            ...current.deliveryPresentation,
            observedAt: new Date(Date.now() - 600_000).toISOString(),
            reviewDecision: 'required',
            mergeState: 'blocked',
            checksState: 'pending',
          },
        },
      })
      .where(eq(integrationEventPollingCursors.resourceKey, key))
    const stream = await WorkStream.mustFind(row!.id)
    const json = { ...stream.toJson(), ...(await computeDerivedStates([stream])).get(stream.id) }
    expect(json.delivery).toEqual({ kind: 'review' })
    expect(workStreamNeedsHumanAttention(json)).toBe(true)
    expect(buildWorkInterestSnapshot([json]).liveActivity.top[0]?.bucket).toBe('needsYou')
    const gate = (await listPendingActions({ includeDeliveryGates: true })).find(
      (action) => action.id === `workstream-delivery:${row!.id}:review`
    )
    expect(gate).toMatchObject({
      type: 'workstream-delivery',
      squadId,
      canRespond: false,
      data: {
        workStreamId: row!.id,
        deliveryKind: 'review',
        pullRequests: [{ repository: 'acme/widgets', number: 7 }],
        focus: { kind: 'workstream', workStreamId: row!.id },
      },
    })
  } finally {
    stop()
  }
})

test('a polled snapshot turning clean wakes the completion-ready delivery participant once', async () => {
  // Synthetic fixture: an auto-merge squad, an exact-head approval already routed, and only the
  // poller can see mergeability turn clean (GitHub sends no webhook for it).
  const agentTypeId = `delivery-wake-${crypto.randomUUID()}`
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Delivery wake fixture',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
  await db.insert(squads).values({
    id: squadId,
    name: 'Delivery wake test',
    purpose: 'test',
    metadata: { policies: { allowAutoMerge: true } },
  })
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const head = 'c'.repeat(40)
  let merge = 'BLOCKED'
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname
    const body =
      path === '/graphql'
        ? {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: head,
                  headRefName: 'work',
                  baseRefName: 'main',
                  state: 'OPEN',
                  isDraft: false,
                  mergeStateStatus: merge,
                  reviewDecision: 'APPROVED',
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
                },
              },
            },
          }
        : path.endsWith('/pulls/7')
          ? {
              id: 7,
              number: 7,
              state: 'open',
              merged: false,
              head: { sha: head },
              base: { repo: { full_name: 'acme/widgets' } },
              requested_reviewers: [],
              requested_teams: [],
            }
          : path.endsWith('/issues/7')
            ? { number: 7 }
            : []
    return new Response(JSON.stringify(body), {
      headers: { date: new Date().toUTCString(), 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  restoreFetch = () => fetchMock.mockRestore()
  try {
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = agentTypeId
    definition.completion = { mode: 'pr-auto-merge', followChanges: true }
    const id = await db.transaction(async (tx) => {
      const [stream] = await tx
        .insert(workStreams)
        .values({
          squadId,
          title: 'Delivery wake',
          status: 'active',
          metadata: {
            codeHost: { integration: 'github', repository: 'acme/widgets', connectionId, changeRequest: { number: 7 } },
          },
        })
        .returning()
      const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
      await dispatchFlow(tx, stream!, run, [])
      return stream!.id
    })
    const started = (await getFlow(id))!
    await advanceFlow(
      id,
      { action: 'complete', expectedVersion: started.version, attemptId: 1, outcome: 'completed', evidence: 'PR open' },
      crypto.randomUUID(),
      { type: 'legacy' }
    )
    const ready = (await getFlow(id))!
    expect(ready.state.status).toBe('completion-ready')
    const participant = ready.attemptAgents['1']!

    const [approval] = githubOutputAdapter.normalize({
      type: 'pull_request_review',
      payload: {
        action: 'submitted',
        repository: { full_name: 'acme/widgets' },
        sender: { id: 9, login: 'fixture-reviewer', type: 'User' },
        pull_request: { id: 7, number: 7, state: 'open', head: { sha: head }, auto_merge: null },
        review: {
          id: 70,
          state: 'approved',
          commit_id: head,
          author_association: 'OWNER',
          body: '',
          user: { id: 9, login: 'fixture-reviewer', type: 'User' },
          submitted_at: new Date(Date.now() - 120_000).toISOString(),
        },
      },
    })
    const [routed] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: key,
        eventKey: approval!.eventKey,
        fact: approval!,
        authority: { kind: 'connection', connectionId, squadId },
      })
      .returning()
    await db.insert(integrationOutputDeliveries).values({
      eventId: routed!.id,
      workStreamId: id,
      subscriptionId: 'code-host-reviewed',
      status: 'delivered',
      subscription: {
        id: 'code-host-reviewed',
        source: { integration: 'github', output: 'pull_request.reviewed', version: 1 },
        match: {},
        deliver: { to: 'delivery-owner', whenInactive: 'retain' },
      },
    })

    const policy = new GitHubPrWatchPolicy({
      listWorkStreams: listGitHubPrWorkStreamCandidates,
      resolveConnection: async (squad, selected) =>
        squad === squadId && selected === connectionId ? { id: connectionId } : undefined,
      lastRealDeliveries: async () => new Map(),
    })
    const watch = (await policy.listWatches()).find((candidate) => candidate.resourceKey === key)!.connection
    const poller = createGitHubPlugin(
      { currentUser: async () => ({ version: 1, userId: 42, login: 'fixture' }) },
      async () => 'fixture'
    ).runtime.provider.capabilities.event_polling! as EventPollingCapability
    const store = new DbEventPollingCursorStore()
    const target = { providerKey: 'github', resourceKey: key, active: true, connection: watch }
    const wakes = () =>
      db
        .select()
        .from(inbox)
        .where(sql`${inbox.metadata}->>'source' = 'delivery-readiness' AND ${inbox.metadata}->>'workStreamId' = ${id}`)
    const poll = async () => {
      const claim = await store.claim('github', key, new Date(), 60_000)
      const polled = await poller.poll(watch, claim!.cursor)
      await store.save('github', key, claim!.leaseToken, polled.nextCursor, new Date(0))
      await notifyDeliverySnapshotChanged(target, claim!.cursor, polled.nextCursor)
      return polled.nextCursor
    }

    // Approved and green, but GitHub still reports BLOCKED: not actionable.
    await poll()
    expect(await wakes()).toHaveLength(0)
    // Mergeability turns clean: exactly one wake to the delivery participant, with its context.
    merge = 'CLEAN'
    const cleanCursor = await poll()
    const [wake, ...rest] = await wakes()
    expect(rest).toHaveLength(0)
    expect(wake!.recipientId).toBe(participant)
    expect(wake!.content).toContain(`Head: ${head}`)
    expect(wake!.content).toContain(
      `Approval commit: ${head} (approved by @fixture-reviewer, a reviewer with write access: OWNER)`
    )
    expect(wake!.content).toContain('Checks: success; mergeability: clean')
    // A repeated notification and a semantically identical re-observation add nothing.
    await notifyDeliverySnapshotChanged(target, cleanCursor, cleanCursor)
    await poll()
    expect(await wakes()).toHaveLength(1)
    // Nothing merged or finished on the platform's own authority.
    expect((await getFlow(id))!.state.status).toBe('completion-ready')
  } finally {
    send.mockRestore()
    const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    for (const agent of owned) await db.delete(inbox).where(eq(inbox.recipientId, agent.id))
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  }
})

for (const state of ['MERGED', 'CLOSED'] as const)
  test(`an inline pr-merge flow whose pull request is already ${state.toLowerCase()} ${state === 'MERGED' ? 'wakes its delivery participant once to finish' : 'is never reported merged'}`, async () => {
    // Synthetic fixture reproducing the reported gap: an inline flow stored as completion { mode: pr-merge }
    // (no followChanges), and a pull request that merged before any merge event reached the stream.
    const agentTypeId = `missed-merge-${crypto.randomUUID()}`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Missed merge fixture',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'Test worker',
    })
    await db.insert(squads).values({ id: squadId, name: 'Missed merge test', purpose: 'test' })
    const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
      success: true,
      queued: true,
      status: 'queued',
    })
    const head = 'd'.repeat(40)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname
      const body =
        path === '/graphql'
          ? {
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: head,
                    headRefName: 'work',
                    baseRefName: 'main',
                    state,
                    isDraft: false,
                    mergeStateStatus: 'UNKNOWN',
                    reviewDecision: 'APPROVED',
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
                  },
                },
              },
            }
          : path.endsWith('/pulls/7')
            ? {
                id: 7,
                number: 7,
                state: 'closed',
                merged: state === 'MERGED',
                head: { sha: head },
                base: { repo: { full_name: 'acme/widgets' } },
                requested_reviewers: [],
                requested_teams: [],
              }
            : path.endsWith('/issues/7')
              ? { number: 7 }
              : []
      return new Response(JSON.stringify(body), {
        headers: { date: new Date().toUTCString(), 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch)
    restoreFetch = () => fetchMock.mockRestore()
    try {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = agentTypeId
      definition.completion = { mode: 'pr-merge' }
      const id = await db.transaction(async (tx) => {
        const [stream] = await tx
          .insert(workStreams)
          .values({
            squadId,
            title: 'Missed merge',
            status: 'active',
            metadata: {
              codeHost: {
                integration: 'github',
                repository: 'acme/widgets',
                connectionId,
                changeRequest: { number: 7 },
              },
            },
          })
          .returning()
        const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
        await dispatchFlow(tx, stream!, run, [])
        return stream!.id
      })
      const started = (await getFlow(id))!
      await advanceFlow(
        id,
        {
          action: 'complete',
          expectedVersion: started.version,
          attemptId: 1,
          outcome: 'completed',
          evidence: 'PR open',
        },
        crypto.randomUUID(),
        { type: 'legacy' }
      )
      const ready = (await getFlow(id))!
      expect(ready.state.status).toBe('completion-ready')
      expect(ready.state.definition.completion).toEqual({ mode: 'pr-merge' })
      const participant = ready.attemptAgents['1']!

      // The default makes the stream a delivery watch, so the poller reads the pull request live.
      const candidate = (await listGitHubPrWorkStreamCandidates()).find((entry) => entry.squadId === squadId)
      expect(candidate?.deliveryPresentation).toBe(true)
      const policy = new GitHubPrWatchPolicy({
        listWorkStreams: listGitHubPrWorkStreamCandidates,
        resolveConnection: async (squad, selected) =>
          squad === squadId && selected === connectionId ? { id: connectionId } : undefined,
        lastRealDeliveries: async () => new Map(),
      })
      const watch = (await policy.listWatches()).find((entry) => entry.resourceKey === key)!.connection
      const poller = createGitHubPlugin(
        { currentUser: async () => ({ version: 1, userId: 42, login: 'fixture' }) },
        async () => 'fixture'
      ).runtime.provider.capabilities.event_polling! as EventPollingCapability
      const store = new DbEventPollingCursorStore()
      const target = { providerKey: 'github', resourceKey: key, active: true, connection: watch }
      const wakes = () =>
        db
          .select()
          .from(inbox)
          .where(
            sql`${inbox.metadata}->>'source' = 'delivery-readiness' AND ${inbox.metadata}->>'workStreamId' = ${id}`
          )
      const poll = async () => {
        const claim = await store.claim('github', key, new Date(), 60_000)
        const polled = await poller.poll(watch, claim!.cursor)
        await store.save('github', key, claim!.leaseToken, polled.nextCursor, new Date(0))
        await notifyDeliverySnapshotChanged(target, claim!.cursor, polled.nextCursor)
        return polled.nextCursor
      }

      const cursor = await poll()
      if (state === 'CLOSED') {
        expect(await wakes()).toHaveLength(0)
        // Closed without merging is a delivery failure, never a merge to finish.
        const stream = await WorkStream.mustFind(id)
        const json = { ...stream.toJson(), ...(await computeDerivedStates([stream])).get(stream.id) }
        expect(json.delivery).toEqual({ kind: 'failure', explanation: { codeHostReason: 'closed' } })
        return
      }
      const [wake, ...rest] = await wakes()
      expect(rest).toHaveLength(0)
      expect(wake!.recipientId).toBe(participant)
      const merged = await WorkStream.mustFind(id)
      const json = { ...merged.toJson(), ...(await computeDerivedStates([merged])).get(merged.id) }
      expect(codeHostDeliveryLabel(json.delivery)).toBe('PR merged — finalizing delivery')
      expect(wake!.metadata).toMatchObject({ reason: 'merged', flowVersion: ready.version })
      expect(wake!.content).toContain('acme/widgets PR 7 (https://github.com/acme/widgets/pull/7): merged')
      expect(wake!.content).toContain(
        `ficus workstream finish ${(await WorkStream.mustFind(id)).number ?? id} --version ${ready.version}`
      )
      // The wake is current while the flow still waits, and repeated observations add nothing.
      const { isCurrentDeliveryReadinessMessage } = await import('../../workflows/delivery-readiness')
      expect(await isCurrentDeliveryReadinessMessage(wake!)).toBe(true)
      await notifyDeliverySnapshotChanged(target, cursor, cursor)
      await poll()
      expect(await wakes()).toHaveLength(1)
      // Ficus finished nothing on its own authority.
      expect((await getFlow(id))!.state.status).toBe('completion-ready')
    } finally {
      send.mockRestore()
      const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
      for (const agent of owned) await db.delete(inbox).where(eq(inbox.recipientId, agent.id))
      await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
      await db.delete(agents).where(eq(agents.squadId, squadId))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    }
  })
