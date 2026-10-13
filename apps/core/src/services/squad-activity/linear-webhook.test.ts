import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { squadActivity, squads, webhookEvents, workStreams } from '../../db/schema'
import { storeWebhookEvent } from '../webhooks/store'
import { extractLinearIssueDispatchFact } from './linear-issue-fact'
import { materializeWebhookActivity } from './materialize'
import { repairSquadActivity } from './repair'

const squadIds: string[] = []
const webhookIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  for (const webhookId of webhookIds.splice(0)) await db.delete(webhookEvents).where(eq(webhookEvents.id, webhookId))
})

// Activity repair only accepts windows inside the retention floor (30 days), so the
// fixture day is always yesterday rather than a fixed date that ages out.
const ACTIVITY_DAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const DAY_START = Date.parse(`${ACTIVITY_DAY}T00:00:00Z`)
// Inside the repair window used below, and before the receipts' own (live) created_at.
const OCCURRED_AT = `${ACTIVITY_DAY}T10:00:00Z`
const WINDOW = { from: new Date(DAY_START), to: new Date(DAY_START + 86_400_000) }
const issueUrl = 'https://linear.app/acme/issue/ENG-12/ship-the-tracked-issue'

const issuePayload = (
  identity: { issueId: string; teamId: string },
  data: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
) => ({
  action: 'update',
  type: 'Issue',
  actor: { id: 'actor-1', name: 'Ada' },
  updatedFrom: { stateId: 'state-1' },
  webhookTimestamp: Date.parse(OCCURRED_AT),
  data: {
    id: identity.issueId,
    number: 12,
    identifier: 'ENG-12',
    title: 'Ship the tracked issue',
    url: issueUrl,
    teamId: identity.teamId,
    team: { id: identity.teamId, key: 'ENG' },
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
    assigneeId: null,
    labelIds: [],
    labels: [],
    createdAt: '2026-09-09T10:00:00Z',
    updatedAt: OCCURRED_AT,
    ...data,
  },
  ...overrides,
})

const commentPayload = (identity: { issueId: string }, action: string, data: Record<string, unknown> = {}) => ({
  action,
  type: 'Comment',
  webhookTimestamp: Date.parse(OCCURRED_AT),
  data: {
    id: 'comment-1',
    body: 'Looks good',
    issueId: identity.issueId,
    issue: { id: identity.issueId, title: 'Ship the tracked issue', identifier: 'ENG-12', number: 12 },
    userId: 'user-9',
    url: `${issueUrl}#comment-comment-1`,
    createdAt: `${ACTIVITY_DAY}T11:00:00Z`,
    updatedAt: `${ACTIVITY_DAY}T11:30:00Z`,
    ...data,
  },
})

const storeLinear = async (eventType: string, payload: Record<string, unknown>) => {
  const eventId = await storeWebhookEvent({
    provider: 'linear',
    eventType,
    payload,
    headers: { 'linear-delivery': crypto.randomUUID() },
    signature: 'verified',
    verified: true,
  })
  webhookIds.push(eventId)
  return eventId
}

const owners = async (eventId: string) =>
  (
    await db.select({ owners: webhookEvents.activitySquadIds }).from(webhookEvents).where(eq(webhookEvents.id, eventId))
  )[0].owners

const newSquad = async (prefix: string, metadata: Record<string, unknown> = {}) => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-${crypto.randomUUID()}`, purpose: 'test', metadata })
    .returning()
  squadIds.push(squad.id)
  return squad
}

const tracker = async (squadId: string, title: string, createdAt: string, metadata: Record<string, unknown>) =>
  (
    await db
      .insert(workStreams)
      .values({ squadId, title, createdAt: new Date(createdAt), metadata })
      .returning()
  )[0]

const linearTracked = (issueId: string, url?: string) => ({
  tracked: [
    {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 12,
      externalId: issueId,
      ...(url ? { url } : {}),
    },
  ],
})

describe('verified Linear webhook Activity', () => {
  test('attributes one issue event to every tracking stream, once across redeliveries', async () => {
    const identity = { issueId: crypto.randomUUID(), teamId: crypto.randomUUID() }
    const squad = await newSquad('linear-tracked')
    const first = await tracker(squad.id, 'first tracker', '2026-09-01T00:00:00Z', linearTracked(identity.issueId))
    const second = await tracker(squad.id, 'second tracker', '2026-09-02T00:00:00Z', linearTracked(identity.issueId))

    const payload = issuePayload(identity)
    const fact = extractLinearIssueDispatchFact('linear', { type: 'Issue', payload, metadata: { source: 'webhook' } })!
    const eventId = await storeLinear('Issue', payload)
    expect(await owners(eventId)).toEqual([squad.id])
    // One squad association, but two rows inside it: one per tracking stream.
    expect(await materializeWebhookActivity('linear', eventId)).toBe(1)

    const rowsForSquad = async () => db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    const byStream = async () => new Map((await rowsForSquad()).map((row) => [row.workStreamId, row]))
    const streams = await byStream()
    expect([...streams.keys()].sort()).toEqual([first.id, second.id].sort())
    expect(streams.get(first.id)).toMatchObject({
      lane: 71,
      kind: 'issue',
      sourceFamily: 'linear-issue',
      sourceGroupId: `hook:${eventId}:${squad.id}`,
      // The actor reads as the person Linear named, not the raw user id.
      summary: '[Issue ENG-12 moved to In Progress] Ship the tracked issue · by Ada',
    })
    expect(streams.get(first.id)!.at.toISOString()).toBe(new Date(OCCURRED_AT).toISOString())
    // The oldest stream keeps the fact's own logical identity; the next gets a derived one.
    expect(streams.get(first.id)!.rowId).toBe(fact.logicalRowId)
    expect(streams.get(second.id)!.rowId).not.toBe(fact.logicalRowId)
    expect(streams.get(second.id)!.ref).toEqual({ type: 'issue', url: issueUrl, workStreamId: second.id })
    expect(streams.get(first.id)!.summary).toBe(streams.get(second.id)!.summary)

    // A redelivery of the same event under a fresh delivery id adds nothing.
    const redeliveryId = await storeLinear('Issue', payload)
    expect(await materializeWebhookActivity('linear', redeliveryId)).toBe(1)
    expect(await rowsForSquad()).toHaveLength(2)

    // A comment and its edit are their own facts, one row per tracking stream each.
    const commentId = await storeLinear('Comment', commentPayload(identity, 'create'))
    expect(await materializeWebhookActivity('linear', commentId)).toBe(1)
    const editId = await storeLinear('Comment', commentPayload(identity, 'update'))
    expect(await materializeWebhookActivity('linear', editId)).toBe(1)
    const all = await rowsForSquad()
    expect(all).toHaveLength(6)
    expect([...new Set(all.map((row) => row.summary))].sort()).toEqual([
      // A comment delivery that names no display name falls back to the actor id.
      '[Issue ENG-12 comment edited] Ship the tracked issue · by user-9',
      '[Issue ENG-12 comment] Ship the tracked issue · by user-9',
      '[Issue ENG-12 moved to In Progress] Ship the tracked issue · by Ada',
    ])

    // Repair over the window backfills a lost row and never deletes the surviving one.
    const keptRowId = streams.get(first.id)!.rowId
    await db
      .delete(squadActivity)
      .where(and(eq(squadActivity.squadId, squad.id), eq(squadActivity.workStreamId, second.id)))
    expect(await rowsForSquad()).toHaveLength(3)
    await repairSquadActivity({ ...WINDOW, pageSize: 2 })
    const repaired = await rowsForSquad()
    expect(repaired).toHaveLength(6)
    // The surviving rows keep their identity; only the deleted ones are written again.
    expect(repaired.filter((row) => row.workStreamId === first.id).map((row) => row.rowId)).toContain(keptRowId)
    expect(repaired.filter((row) => row.workStreamId === second.id)).toHaveLength(3)
  })

  test('projects a legacy linear.issueId stream and falls back to the tracked link', async () => {
    const identity = { issueId: crypto.randomUUID(), teamId: crypto.randomUUID() }
    const legacySquad = await newSquad('linear-legacy')
    const legacyStream = await tracker(legacySquad.id, 'legacy stream', '2026-09-01T00:00:00Z', {
      linear: { issueId: identity.issueId },
    })
    const trackedSquad = await newSquad('linear-url-fallback')
    const trackedStream = await tracker(
      trackedSquad.id,
      'tracked stream',
      '2026-09-01T00:00:00Z',
      linearTracked(identity.issueId, issueUrl)
    )

    // A delivery that carries no link of its own still points at the tracked resource.
    const eventId = await storeLinear('Issue', issuePayload(identity, { url: undefined }))
    expect((await owners(eventId)).sort()).toEqual([legacySquad.id, trackedSquad.id].sort())
    expect(await materializeWebhookActivity('linear', eventId)).toBe(2)

    const [legacyRow] = await db.select().from(squadActivity).where(eq(squadActivity.squadId, legacySquad.id))
    expect(legacyRow).toMatchObject({ lane: 71, sourceFamily: 'linear-issue', workStreamId: legacyStream.id })
    expect(legacyRow.ref).toEqual({ type: 'issue', url: '', workStreamId: legacyStream.id })
    const [trackedRow] = await db.select().from(squadActivity).where(eq(squadActivity.squadId, trackedSquad.id))
    expect(trackedRow.ref).toEqual({ type: 'issue', url: issueUrl, workStreamId: trackedStream.id })
  })

  test('owns a receipt by team routing but projects nothing without a tracking stream', async () => {
    const identity = { issueId: crypto.randomUUID(), teamId: crypto.randomUUID() }
    const routedSquad = await newSquad('linear-routed', { linear: [{ teamId: identity.teamId }] })
    const objectRoutedSquad = await newSquad('linear-routed-object', { linear: { teamId: identity.teamId } })
    const eventId = await storeLinear('Issue', issuePayload(identity))
    expect((await owners(eventId)).sort()).toEqual([routedSquad.id, objectRoutedSquad.id].sort())
    expect(await materializeWebhookActivity('linear', eventId)).toBe(0)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, routedSquad.id))).toEqual([])
  })

  test('never projects a receipt the squad does not own, through either path', async () => {
    const identity = { issueId: crypto.randomUUID(), teamId: crypto.randomUUID() }
    const squad = await newSquad('linear-unowned')
    await tracker(squad.id, 'tracking stream', '2026-09-01T00:00:00Z', linearTracked(identity.issueId))
    const [webhook] = await db
      .insert(webhookEvents)
      .values({
        provider: 'linear',
        eventType: 'Issue',
        payload: issuePayload(identity),
        headers: { 'linear-delivery': crypto.randomUUID() },
        verified: true,
      })
      .returning()
    webhookIds.push(webhook.id)
    expect(webhook.activitySquadIds).toEqual([])
    expect(await materializeWebhookActivity('linear', webhook.id)).toBe(0)
    await repairSquadActivity({ ...WINDOW, pageSize: 2 })
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])
  })
})
