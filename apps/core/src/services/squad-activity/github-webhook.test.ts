import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  integrationEventPollingDispatches,
  squadActivity,
  squadSourceConfigs,
  squads,
  webhookEvents,
  workStreamFlowRuns,
  workStreams,
} from '../../db/schema'
import { storeWebhookEvent } from '../webhooks/store'
import { extractGitHubIssueDispatchFact } from './github-issue-fact'
import { extractGitHubPrDispatchFact, githubPrLogicalRowId } from './github-pr-fact'
import { materializeGitHubDispatch, materializeGitHubWebhook } from './materialize'
import { repairSquadActivity } from './repair'
import { loadActivitySource } from './families'
import { listGitHubAssociationPage, listGitHubIssueAssociationPage } from './source-loaders'

// Activity repair only accepts windows inside the retention floor (30 days), so the
// fixture day is always yesterday rather than a fixed date that ages out.
const ACTIVITY_DAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const NEXT_DAY = new Date(Date.parse(`${ACTIVITY_DAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const squadIds: string[] = []
const webhookIds: string[] = []
const dispatchKeys: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  for (const webhookId of webhookIds.splice(0)) await db.delete(webhookEvents).where(eq(webhookEvents.id, webhookId))
  for (const eventKey of dispatchKeys.splice(0))
    await db.delete(integrationEventPollingDispatches).where(eq(integrationEventPollingDispatches.eventKey, eventKey))
})

describe('verified GitHub webhook Activity', () => {
  test('keeps supported verified legacy empty-owner rows fail-closed through immediate and repair paths', async () => {
    const repository = `legacy-empty-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `legacy-empty-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'Canonical coordinates must not grant legacy ownership',
      metadata: { github: { repo: repository, pr: { number: 42 } } },
    })
    const payload = {
      action: 'closed',
      number: 42,
      repository: { full_name: repository },
      pull_request: {
        id: 4242,
        number: 42,
        closed_at: `${ACTIVITY_DAY}T01:30:00Z`,
        html_url: `https://github.com/${repository}/pull/42`,
      },
    }
    const [webhook] = await db
      .insert(webhookEvents)
      .values({
        provider: 'github',
        eventType: 'pull_request',
        payload,
        headers: { 'x-github-delivery': crypto.randomUUID() },
        verified: true,
      })
      .returning()
    webhookIds.push(webhook.id)
    expect(webhook.activitySquadIds).toEqual([])
    const fact = extractGitHubPrDispatchFact('github', { type: 'pull_request', payload })!
    expect((await listGitHubAssociationPage(`hook:${webhook.id}`, fact, null, 10)).groupIds).toEqual([])
    expect(await materializeGitHubWebhook(webhook.id)).toBe(0)
    await repairSquadActivity({
      from: new Date(`${ACTIVITY_DAY}T00:00:00Z`),
      to: new Date(`${NEXT_DAY}T00:00:00Z`),
      pageSize: 2,
    })
    expect(
      await db
        .select()
        .from(squadActivity)
        .where(eq(squadActivity.sourceGroupId, `hook:${webhook.id}:${squad.id}`))
    ).toEqual([])
  })

  test('uses immutable ingress owners for immediate materialization and repair', async () => {
    const repository = `snapshot-${crypto.randomUUID()}/widgets`
    const createdSquads = await db
      .insert(squads)
      .values([
        { name: `snapshot-a-${crypto.randomUUID()}`, purpose: 'test' },
        { name: `snapshot-b-${crypto.randomUUID()}`, purpose: 'test' },
      ])
      .returning({ id: squads.id })
    squadIds.push(...createdSquads.map((squad) => squad.id))
    await db.insert(workStreams).values(
      createdSquads.map((squad, index) => ({
        squadId: squad.id,
        title: `snapshot owner ${index}`,
        metadata: { github: { repo: repository, pr: { number: 42 } } },
      }))
    )
    const [configA] = await db
      .insert(squadSourceConfigs)
      .values({
        squadId: createdSquads[0].id,
        sourceType: 'github_issue',
        enabled: true,
        policy: { version: 1, scope: { repos: [repository] } },
      })
      .returning()
    const payload = {
      action: 'closed',
      number: 42,
      repository: { full_name: repository },
      pull_request: {
        id: 4200,
        number: 42,
        closed_at: `${ACTIVITY_DAY}T01:00:00Z`,
        html_url: `https://github.com/${repository}/pull/42`,
      },
    }
    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'pull_request',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.id, configA.id))
    await db.insert(squadSourceConfigs).values({
      squadId: createdSquads[1].id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: [repository] } },
    })
    const [stored] = await db
      .select({ owners: webhookEvents.activitySquadIds })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
    // Ownership union (ACTIVITY_DAY): squad 0 via its source config, squad 1 via
    // its work stream referencing the repo — both are stamped at ingest, and
    // the stamp is immutable (the config swap below changes nothing).
    expect([...(stored.owners ?? [])].sort()).toEqual([createdSquads[0].id, createdSquads[1].id].sort())
    expect(await materializeGitHubWebhook(eventId)).toBe(2)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, createdSquads[0].id))).toHaveLength(1)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, createdSquads[1].id))).toHaveLength(1)

    for (const squad of createdSquads) await db.delete(squadActivity).where(eq(squadActivity.squadId, squad.id))
    await repairSquadActivity({
      from: new Date(`${ACTIVITY_DAY}T00:00:00Z`),
      to: new Date(`${NEXT_DAY}T00:00:00Z`),
      pageSize: 2,
    })
    expect(
      await db
        .select()
        .from(squadActivity)
        .where(and(eq(squadActivity.squadId, createdSquads[0].id), eq(squadActivity.sourceFamily, 'github-pr')))
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(squadActivity)
        .where(and(eq(squadActivity.squadId, createdSquads[1].id), eq(squadActivity.sourceFamily, 'github-pr')))
    ).toHaveLength(1)

    await db.insert(squadSourceConfigs).values({
      squadId: createdSquads[0].id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: [repository] } },
    })
    const sharedEventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'pull_request',
      payload: {
        ...payload,
        pull_request: { ...payload.pull_request, id: 4201, closed_at: `${ACTIVITY_DAY}T02:00:00Z` },
      },
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(sharedEventId)
    const [shared] = await db
      .select({ owners: webhookEvents.activitySquadIds })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, sharedEventId))
    expect(shared.owners.sort()).toEqual(createdSquads.map((squad) => squad.id).sort())
    expect(await materializeGitHubWebhook(sharedEventId)).toBe(2)

    for (const verified of [false, true]) {
      const unsupportedId = await storeWebhookEvent({
        provider: 'github',
        eventType: 'pull_request',
        payload: { ...payload, action: 'opened' },
        headers: {},
        signature: null,
        verified,
      })
      webhookIds.push(unsupportedId)
      const [unsupported] = await db
        .select({ owners: webhookEvents.activitySquadIds })
        .from(webhookEvents)
        .where(eq(webhookEvents.id, unsupportedId))
      expect(unsupported.owners).toEqual([])
      expect(await materializeGitHubWebhook(unsupportedId)).toBe(0)
    }
  })

  test('rejects invalid and out-of-range materialization bounds', async () => {
    for (const pageSize of [Number.NaN, Number.POSITIVE_INFINITY, 1.5])
      await expect(materializeGitHubWebhook(crypto.randomUUID(), { pageSize })).rejects.toThrow(TypeError)
    for (const concurrency of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 1, 2, 3, 9, 16])
      await expect(materializeGitHubWebhook(crypto.randomUUID(), { concurrency })).rejects.toThrow(TypeError)
  })

  test('materializes the authoritative webhook path even when polling is suppressed', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-webhook-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    await db.insert(squadSourceConfigs).values({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['activity-webhook/widgets'] } },
    })
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'Webhook PR',
        metadata: { github: { repo: 'activity-webhook/widgets', pr: { number: 42 } } },
      })
      .returning()
    const [unownedSquad] = await db
      .insert(squads)
      .values({ name: `activity-webhook-unowned-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(unownedSquad.id)
    await db.insert(workStreams).values({
      squadId: unownedSquad.id,
      title: 'Same coordinates, different webhook owner',
      metadata: { github: { repo: 'activity-webhook/widgets', pr: { number: 42 } } },
    })
    const [webhook] = await db
      .insert(webhookEvents)
      .values({
        provider: 'github',
        eventType: 'pull_request',
        payload: {
          action: 'closed',
          number: 42,
          repository: { full_name: 'Activity-Webhook/Widgets' },
          pull_request: {
            id: 4200,
            number: 42,
            merged: true,
            merged_at: `${ACTIVITY_DAY}T00:00:00Z`,
            html_url: 'https://github.com/activity-webhook/widgets/pull/42',
          },
        },
        headers: { 'x-github-delivery': 'delivery-1' },
        verified: true,
        activitySquadIds: [squad.id],
      })
      .returning()
    webhookIds.push(webhook.id)

    const snapshot = await loadActivitySource(db, {
      family: 'github-pr',
      groupId: `hook:${webhook.id}:${squad.id}`,
    })
    expect(snapshot && 'fact' in snapshot ? snapshot.fact.providerDeliveryId : null).toBe('delivery-1')
    expect(await materializeGitHubWebhook(webhook.id)).toBe(1)
    await db.update(squadActivity).set({ preview: [] }).where(eq(squadActivity.squadId, squad.id))
    expect(await materializeGitHubWebhook(webhook.id)).toBe(1)
    const [regenerated] = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(regenerated.preview).toEqual([{ text: '[PR #42 merged]' }])

    const [row] = await db
      .select()
      .from(squadActivity)
      .where(eq(squadActivity.sourceGroupId, `hook:${webhook.id}:${squad.id}`))
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, unownedSquad.id))).toEqual([])
    expect(row.rowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row.rowId).not.toBe(webhook.id)
    await materializeGitHubWebhook(webhook.id)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toHaveLength(1)
    expect(row).toMatchObject({
      squadId: squad.id,
      workStreamId: stream.id,
      kind: 'pr',
      summary: '[PR #42 merged]',
      sourceGroupId: `hook:${webhook.id}:${squad.id}`,
    })

    const [redelivery] = await db
      .insert(webhookEvents)
      .values({
        provider: 'github',
        eventType: 'pull_request',
        payload: webhook.payload,
        headers: { 'x-github-delivery': 'delivery-2' },
        verified: true,
        activitySquadIds: [squad.id],
      })
      .returning()
    webhookIds.push(redelivery.id)
    await materializeGitHubWebhook(redelivery.id)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toHaveLength(1)

    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: [squad.id],
      completedAt: new Date(),
      eventOccurredAt: new Date(`${ACTIVITY_DAY}T00:00:00Z`),
      eventFact: {
        eventType: 'pull_request',
        action: 'merged',
        occurredAt: `${ACTIVITY_DAY}T00:00:00.000Z`,
        actorLogin: null,
        repository: 'activity-webhook/widgets',
        prNumber: 42,
        nativeId: '4200',
        providerDeliveryId: null,
        logicalRowId: githubPrLogicalRowId({
          eventType: 'pull_request',
          action: 'merged',
          occurredAt: `${ACTIVITY_DAY}T00:00:00.000Z`,
          repository: 'activity-webhook/widgets',
          prNumber: 42,
          nativeId: '4200',
        }),
        url: 'https://github.com/activity-webhook/widgets/pull/42',
      },
    })
    await materializeGitHubDispatch(activityId, squad.id)
    expect((await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id)))[0].sourceGroupId).toBe(
      `hook:${webhook.id}:${squad.id}`
    )

    await db.delete(squadActivity).where(eq(squadActivity.squadId, squad.id))
    await materializeGitHubDispatch(activityId, squad.id)
    await materializeGitHubWebhook(redelivery.id)
    expect((await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id)))[0].sourceGroupId).toBe(
      `poll:${activityId}:${squad.id}`
    )

    await db.delete(squadActivity).where(eq(squadActivity.squadId, squad.id))
    await Promise.all([materializeGitHubWebhook(webhook.id), materializeGitHubWebhook(redelivery.id)])
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toHaveLength(1)

    await db.delete(squadActivity).where(eq(squadActivity.squadId, squad.id))
    await Promise.all([materializeGitHubDispatch(activityId, squad.id), materializeGitHubWebhook(webhook.id)])
    const concurrent = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(concurrent).toHaveLength(1)
    expect(concurrent[0].sourceGroupId).toMatch(new RegExp(`^(poll:${activityId}|hook:${webhook.id}):${squad.id}$`))
  })
})

describe('tracked GitHub issue Activity', () => {
  const issuePayload = (
    repository: string,
    overrides: Record<string, unknown> = {},
    issueOverrides: Record<string, unknown> = {}
  ) => ({
    action: 'closed',
    repository: { full_name: repository },
    sender: { login: 'noahsaso' },
    issue: {
      id: 9912,
      number: 12,
      title: 'Ship the tracked issue',
      closed_at: `${ACTIVITY_DAY}T01:00:00Z`,
      updated_at: `${ACTIVITY_DAY}T01:00:00Z`,
      html_url: `https://github.com/${repository}/issues/12`,
      ...issueOverrides,
    },
    ...overrides,
  })

  test('projects a tracked issue webhook once across retries and the poll equivalent', async () => {
    const repository = `tracked-issue-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `tracked-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'Tracked issue stream',
        metadata: { tracked: [{ integration: 'github', repository, kind: 'issue', number: 12 }] },
      })
      .returning()
    // Activity is independent of delivery: this stream has no flow run at all.
    expect(
      await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, stream.id))
    ).toHaveLength(0)

    const payload = issuePayload(repository)
    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    const [stored] = await db
      .select({ owners: webhookEvents.activitySquadIds })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
    expect(stored.owners).toEqual([squad.id])
    expect(await materializeGitHubWebhook(eventId)).toBe(1)
    const rowsForSquad = async () =>
      db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id)).orderBy(squadActivity.at)
    const closedRows = await rowsForSquad()
    expect(closedRows).toHaveLength(1)
    expect(closedRows[0]).toMatchObject({
      lane: 71,
      kind: 'issue',
      workStreamId: stream.id,
      sourceFamily: 'github-issue',
      sourceGroupId: `hook:${eventId}:${squad.id}`,
      summary: '[Issue #12 closed] Ship the tracked issue · by noahsaso',
    })
    expect(closedRows[0].ref).toEqual({
      type: 'issue',
      url: `https://github.com/${repository}/issues/12`,
      workStreamId: stream.id,
    })

    // Retry of the very same delivery under a fresh delivery id.
    const retryId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(retryId)
    expect(await materializeGitHubWebhook(retryId)).toBe(1)
    expect(await rowsForSquad()).toHaveLength(1)

    // The poller's synthesized equivalent of the same close collapses onto that row.
    const pollFact = extractGitHubIssueDispatchFact('github', {
      type: 'issues',
      payload: issuePayload(repository),
      metadata: { synthetic: true },
    })!
    expect(pollFact.logicalRowId).toBe(closedRows[0].rowId)
    const activityId = crypto.randomUUID()
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId,
      activitySquadIds: [squad.id],
      completedAt: new Date(),
      eventOccurredAt: new Date(pollFact.occurredAt),
      eventFact: pollFact,
    })
    await materializeGitHubDispatch(activityId, squad.id)
    expect(await rowsForSquad()).toHaveLength(1)

    // Distinct edits of one comment are distinct facts.
    for (const updatedAt of [`${ACTIVITY_DAY}T03:00:00Z`, `${ACTIVITY_DAY}T04:00:00Z`]) {
      const commentId = await storeWebhookEvent({
        provider: 'github',
        eventType: 'issue_comment',
        payload: issuePayload(repository, {
          action: 'edited',
          comment: { id: 5501, updated_at: updatedAt, user: { login: 'ficusagent' } },
        }),
        headers: { 'x-github-delivery': crypto.randomUUID() },
        signature: 'verified',
        verified: true,
      })
      webhookIds.push(commentId)
      expect(await materializeGitHubWebhook(commentId)).toBe(1)
    }
    expect(await rowsForSquad()).toHaveLength(3)

    // Out-of-order reopen/close transitions each keep their own occurrence time.
    const reopenId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload: issuePayload(
        repository,
        { action: 'reopened' },
        { closed_at: null, updated_at: `${ACTIVITY_DAY}T02:00:00Z` }
      ),
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(reopenId)
    expect(await materializeGitHubWebhook(reopenId)).toBe(1)
    const transitions = (await rowsForSquad()).filter(
      (row) => row.summary.includes('closed] ') || row.summary.includes('reopened] ')
    )
    expect(transitions.map((row) => [row.summary, row.at.toISOString()])).toEqual([
      ['[Issue #12 closed] Ship the tracked issue · by noahsaso', `${ACTIVITY_DAY}T01:00:00.000Z`],
      ['[Issue #12 reopened] Ship the tracked issue · by noahsaso', `${ACTIVITY_DAY}T02:00:00.000Z`],
    ])
  })

  test('associates tracked issue coordinates but never an untracked source link', async () => {
    const repository = `tracked-issue-${crypto.randomUUID()}/widgets`
    const [trackedSquad] = await db
      .insert(squads)
      .values({ name: `tracked-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(trackedSquad.id)
    const [trackedStream] = await db
      .insert(workStreams)
      .values({
        squadId: trackedSquad.id,
        title: 'Tracked issue stream',
        metadata: { tracked: [{ integration: 'github', repository, kind: 'issue', number: 12 }] },
      })
      .returning()
    // Owns the repo's events through `github.repo`, but the legacy `github.issue`
    // key is never read: it names no tracked resource, so it associates nothing.
    const [legacySquad] = await db
      .insert(squads)
      .values({ name: `legacy-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(legacySquad.id)
    await db.insert(workStreams).values({
      squadId: legacySquad.id,
      title: 'Legacy issue stream',
      metadata: { github: { repo: repository, issue: 12 } },
    })
    const [linkSquad] = await db
      .insert(squads)
      .values({ name: `source-link-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(linkSquad.id)
    // Owns the repo's events, but merely *linking* the issue is not tracking it.
    await db.insert(squadSourceConfigs).values({
      squadId: linkSquad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: [repository] } },
    })
    await db.insert(workStreams).values({
      squadId: linkSquad.id,
      title: 'Only a source link',
      metadata: { sources: [{ type: 'github_issue', url: `https://github.com/${repository}/issues/12` }] },
    })

    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload: issuePayload(repository),
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    const [stored] = await db
      .select({ owners: webhookEvents.activitySquadIds })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
    expect([...stored.owners].sort()).toEqual([trackedSquad.id, legacySquad.id, linkSquad.id].sort())
    expect(await materializeGitHubWebhook(eventId)).toBe(1)
    const trackedRows = await db.select().from(squadActivity).where(eq(squadActivity.squadId, trackedSquad.id))
    expect(trackedRows).toHaveLength(1)
    expect(trackedRows[0].workStreamId).toBe(trackedStream.id)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, legacySquad.id))).toEqual([])
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, linkSquad.id))).toEqual([])
  })

  test('keeps unowned issue receipts fail-closed through immediate and repair paths', async () => {
    const repository = `unowned-issue-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `unowned-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'Tracked but unowned',
      metadata: { tracked: [{ integration: 'github', repository, kind: 'issue', number: 12 }] },
    })
    const payload = issuePayload(repository)
    const [webhook] = await db
      .insert(webhookEvents)
      .values({
        provider: 'github',
        eventType: 'issues',
        payload,
        headers: { 'x-github-delivery': crypto.randomUUID() },
        verified: true,
      })
      .returning()
    webhookIds.push(webhook.id)
    expect(webhook.activitySquadIds).toEqual([])
    const fact = extractGitHubIssueDispatchFact('github', { type: 'issues', payload })!
    expect((await listGitHubIssueAssociationPage(`hook:${webhook.id}`, fact, null, 10)).groupIds).toEqual([])
    expect(await materializeGitHubWebhook(webhook.id)).toBe(0)
    await repairSquadActivity({
      from: new Date(`${ACTIVITY_DAY}T00:00:00Z`),
      to: new Date(`${NEXT_DAY}T00:00:00Z`),
      pageSize: 2,
    })
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])
  })

  test('associates a tracked pull request that no delivery ever bound', async () => {
    const repository = `tracked-pr-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `tracked-pr-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'Tracked PR stream',
        metadata: { tracked: [{ integration: 'github', repository, kind: 'pull_request', number: 7 }] },
      })
      .returning()
    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'pull_request',
      payload: {
        action: 'closed',
        number: 7,
        repository: { full_name: repository },
        pull_request: {
          id: 7007,
          number: 7,
          closed_at: `${ACTIVITY_DAY}T05:00:00Z`,
          html_url: `https://github.com/${repository}/pull/7`,
        },
      },
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    const [stored] = await db
      .select({ owners: webhookEvents.activitySquadIds })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
    expect(stored.owners).toEqual([squad.id])
    expect(await materializeGitHubWebhook(eventId)).toBe(1)
    const rows = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lane: 70,
      kind: 'pr',
      workStreamId: stream.id,
      sourceFamily: 'github-pr',
      summary: '[PR #7 closed]',
    })
  })

  test('attributes one issue event to every tracking stream in the squad, and repair backfills a missing one', async () => {
    const repository = `shared-issue-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `shared-issue-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const tracker = async (title: string, createdAt: string) =>
      (
        await db
          .insert(workStreams)
          .values({
            squadId: squad.id,
            title,
            createdAt: new Date(createdAt),
            metadata: { tracked: [{ integration: 'github', repository, kind: 'issue', number: 12 }] },
          })
          .returning()
      )[0]
    const first = await tracker('first tracker', '2026-08-01T00:00:00Z')
    const second = await tracker('second tracker', '2026-08-02T00:00:00Z')

    const payload = issuePayload(repository)
    const fact = extractGitHubIssueDispatchFact('github', { type: 'issues', payload, metadata: { synthetic: true } })!
    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    // One squad association, but two rows inside it: one per tracking stream.
    expect(await materializeGitHubWebhook(eventId)).toBe(1)
    const rowsForSquad = async () => db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    const byStream = async () => new Map((await rowsForSquad()).map((row) => [row.workStreamId, row]))

    const streams = await byStream()
    expect([...streams.keys()].sort()).toEqual([first.id, second.id].sort())
    expect([...streams.values()].every((row) => row.lane === 71 && row.sourceFamily === 'github-issue')).toBe(true)
    // The oldest stream keeps the fact's own logical identity; the next gets a derived one.
    expect(streams.get(first.id)!.rowId).toBe(fact.logicalRowId)
    expect(streams.get(second.id)!.rowId).not.toBe(fact.logicalRowId)
    expect(streams.get(second.id)!.ref).toEqual({
      type: 'issue',
      url: `https://github.com/${repository}/issues/12`,
      workStreamId: second.id,
    })
    expect(streams.get(first.id)!.summary).toBe(streams.get(second.id)!.summary)

    // A retried delivery of the same event still projects exactly two rows.
    const retryId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'issues',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(retryId)
    await materializeGitHubWebhook(retryId)
    expect(await rowsForSquad()).toHaveLength(2)

    // Repair over a squad that only ever recorded the first stream's row adds the
    // second stream's row and never deletes the row that was already there.
    const keptRowId = streams.get(first.id)!.rowId
    await db
      .delete(squadActivity)
      .where(and(eq(squadActivity.squadId, squad.id), eq(squadActivity.workStreamId, second.id)))
    expect(await rowsForSquad()).toHaveLength(1)
    await repairSquadActivity({
      from: new Date(`${ACTIVITY_DAY}T00:00:00Z`),
      to: new Date(`${NEXT_DAY}T00:00:00Z`),
      pageSize: 2,
    })
    const repaired = await byStream()
    expect([...repaired.keys()].sort()).toEqual([first.id, second.id].sort())
    expect(repaired.get(first.id)!.rowId).toBe(keptRowId)
  })

  test('attributes one pull request event to every tracking stream in the squad', async () => {
    const repository = `shared-pr-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `shared-pr-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadIds.push(squad.id)
    const tracker = async (title: string, createdAt: string) =>
      (
        await db
          .insert(workStreams)
          .values({
            squadId: squad.id,
            title,
            createdAt: new Date(createdAt),
            metadata: { tracked: [{ integration: 'github', repository, kind: 'pull_request', number: 7 }] },
          })
          .returning()
      )[0]
    const first = await tracker('first PR tracker', '2026-08-01T00:00:00Z')
    const second = await tracker('second PR tracker', '2026-08-02T00:00:00Z')

    const payload = {
      action: 'closed',
      number: 7,
      repository: { full_name: repository },
      pull_request: {
        id: 7008,
        number: 7,
        closed_at: `${ACTIVITY_DAY}T05:00:00Z`,
        html_url: `https://github.com/${repository}/pull/7`,
      },
    }
    const fact = extractGitHubPrDispatchFact('github', { type: 'pull_request', payload } as never)!
    const eventId = await storeWebhookEvent({
      provider: 'github',
      eventType: 'pull_request',
      payload,
      headers: { 'x-github-delivery': crypto.randomUUID() },
      signature: 'verified',
      verified: true,
    })
    webhookIds.push(eventId)
    expect(await materializeGitHubWebhook(eventId)).toBe(1)
    const rows = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(rows).toHaveLength(2)
    const byStream = new Map(rows.map((row) => [row.workStreamId, row]))
    expect([...byStream.keys()].sort()).toEqual([first.id, second.id].sort())
    expect([...byStream.values()].every((row) => row.lane === 70 && row.summary === '[PR #7 closed]')).toBe(true)
    expect(byStream.get(first.id)!.rowId).toBe(fact.logicalRowId)
    expect(byStream.get(second.id)!.rowId).not.toBe(fact.logicalRowId)
    // The shared PR ref type names no stream; the row's own column carries it.
    expect(byStream.get(second.id)!.ref).toEqual({ type: 'pr', url: `https://github.com/${repository}/pull/7` })
  })
})
