import { githubOutputAdapter } from '../outputs/github'
import { listGitHubPrWorkStreamCandidates } from './database-watch-source'
import { notifyDeliverySnapshotChanged } from './delivery-presentation-store'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  createBlankWorkflow,
  createWorkflowRun,
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  buildWorkInterestSnapshot,
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
import { GitHubPrEventPoller } from './event-poller'

const squadId = crypto.randomUUID()
const connectionId = crypto.randomUUID()
const key = `${squadId}:${connectionId}:acme/widgets#7`
afterEach(async () => {
  await db.delete(integrationOutputEvents).where(eq(integrationOutputEvents.sourceKey, key))
  await db.delete(integrationEventPollingCursors).where(eq(integrationEventPollingCursors.resourceKey, key))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

test('actual poll -> durable cursor -> serialized attention supports baseline and same-head changes without activity replay', async () => {
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
  const poller = new GitHubPrEventPoller({
    resolveCredential: async () => 'fixture',
    fetch: async (input) => {
      const path = new URL(input).pathname
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
    },
  })
  const watch = {
    id: connectionId,
    squadId,
    providerKey: 'github',
    adapterVersion: 1,
    configuration: { owner: 'acme', repo: 'widgets', number: 7, deliveryPresentation: true },
  }
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
    for (const [review, check, mergeState, expected, attention, bucket] of [
      ['APPROVED', 'PENDING', 'UNKNOWN', 'delivery_external', false, 'externalWait'],
      ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'delivery_external', false, 'externalWait'],
      ['REVIEW_REQUIRED', 'PENDING', 'UNKNOWN', 'delivery_review', true, 'needsYou'],
      ['CHANGES_REQUESTED', 'SUCCESS', 'BLOCKED', 'delivery_failure', false, 'blocked'],
      // Dismissing a rejecting review restores the required-review gate without
      // synthesizing a review event or advancing the workflow.
      ['REVIEW_REQUIRED', 'SUCCESS', 'BLOCKED', 'delivery_review', true, 'needsYou'],
      ['APPROVED', 'PENDING', 'BLOCKED', 'delivery_external', false, 'externalWait'],
      ['APPROVED', 'SUCCESS', 'CLEAN', 'delivery_merge', true, 'needsYou'],
      ['APPROVED', 'FAILURE', 'UNSTABLE', 'delivery_failure', false, 'blocked'],
      ['APPROVED', 'SUCCESS', 'CLEAN', 'delivery_merge', true, 'needsYou'],
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
  } finally {
    stop()
  }
})
