import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { ACTIVITY_SETTLED_MARGIN_MS, manualInputRequestSchema, taskInputSummary } from '@ficus/shared'
import { db } from '../../db'
import {
  agents,
  inbox,
  squadActivity,
  squads,
  workStreamFlowRuns,
  workStreamFlowTransitions,
  workStreamWaits,
  workStreams,
} from '../../db/schema'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { requestStructuredInput, resolveStructuredInput } from '../recovery/structured-input'
import type { SquadActivityAccess } from '../squad/activity'
import { activityRetentionFloor } from '../squad/activity-cursor'
import { materializeSourceGroup } from './materialize'
import { projectGlobalActivity } from './global-activity'
import { countSettledActivity } from './settled'

const FULL: SquadActivityAccess = { agentsRead: true, workstreamsRead: true, inbox: { mode: 'all' } }
const HOUR = 3_600_000
/** Settled long enough ago that a count includes it: counts stop ACTIVITY_SETTLED_MARGIN_MS ago. */
const settledAt = () => new Date(Date.now() - ACTIVITY_SETTLED_MARGIN_MS - 60_000)
const createdSquads: string[] = []
const inboxRecipients: string[] = []
let squadId: string
let owner: string
let worker: string
let reviewer: string
let streamId: string
let since: Date

const decide = (actor: 'owner' | 'human' = 'owner') =>
  manualInputRequestSchema.parse({
    schemaVersion: 1,
    kind: 'decide',
    purpose: 'task-decision',
    actor,
    subject: 'Which cache backend',
    options: [
      { id: 'redis', label: 'Redis' },
      { id: 'memory', label: 'In memory' },
    ],
  })

/** A closed wait written directly, for the shapes no public path produces in one step. */
async function closedWait(values: Partial<typeof workStreamWaits.$inferInsert>) {
  const request = decide(values.actor === 'human' ? 'human' : 'owner')
  const [wait] = await db
    .insert(workStreamWaits)
    .values({
      workStreamId: streamId,
      type: 'manual',
      actor: 'owner',
      createdBy: 'agent',
      createdByAgentId: worker,
      structured: { request, summary: taskInputSummary(request as never), version: 1 },
      openedAt: new Date(Date.now() - 2 * HOUR),
      closedAt: settledAt(),
      resolution: 'cleared',
      resolutionNote: 'Selected: Redis',
      ...values,
    })
    .returning()
  await materializeSourceGroup({ family: 'wait', groupId: wait!.id })
  return wait!
}

async function doneNotice(event: 'done' | 'canceled') {
  inboxRecipients.push(owner)
  const [row] = await db
    .insert(inbox)
    .values({
      recipientType: 'agent',
      recipientId: owner,
      senderType: 'system',
      content: `Work stream ${event}.`,
      metadata: { event, workStreamId: streamId, ownerAgentId: owner },
    })
    .returning()
  await materializeSourceGroup({ family: 'inbox', groupId: row!.id })
  return row!
}

beforeEach(async () => {
  since = new Date(Date.now() - HOUR)
  const [squad] = await db
    .insert(squads)
    .values({ name: `settled-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadId = squad!.id
  createdSquads.push(squadId)
  const made = await db
    .insert(agents)
    .values([
      { squadId, agentTypeId: 'manager' },
      { squadId, agentTypeId: 'engineer' },
      { squadId, agentTypeId: 'reviewer' },
    ])
    .returning()
  ;[owner, worker, reviewer] = made.map((agent) => agent.id) as [string, string, string]
  streamId = (await storedLegacyWorkStream({ squadId, title: 'Settled fixture', ownerAgentId: owner })).id
})

afterEach(async () => {
  if (inboxRecipients.length) await db.delete(inbox).where(inArray(inbox.recipientId, inboxRecipients.splice(0)))
  for (const id of createdSquads.splice(0)) {
    // squad_activity has no foreign key to squads.
    await db.delete(squadActivity).where(eq(squadActivity.squadId, id))
    await db.delete(workStreams).where(eq(workStreams.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
})

describe('settled without you', () => {
  test('counts an owner-answered task input once, through the recorded resolver', async () => {
    const wait = await requestStructuredInput(streamId, decide(), { createdBy: 'agent', createdByAgentId: worker })
    const closed = await resolveStructuredInput(
      streamId,
      wait.id,
      { action: 'choose', expectedVersion: 0, optionId: 'redis' },
      { agentId: owner }
    )
    expect(closed.resolvedByAgentId).toBe(owner)
    expect(closed.resolvedByUserId).toBeNull()
    await db.update(workStreamWaits).set({ closedAt: settledAt() }).where(eq(workStreamWaits.id, wait.id))
    await materializeSourceGroup({ family: 'wait', groupId: wait.id })

    // Each of these is left out: answered by a person, once routed to a person, closed by a path
    // that recorded no resolver, answered by the asker itself, still open, and closed before `since`.
    await closedWait({ actor: 'human', resolvedByUserId: null, resolvedByAgentId: null })
    await closedWait({
      resolvedByAgentId: owner,
      actorChanges: [{ from: 'human', to: 'owner', at: new Date().toISOString() } as never],
    })
    await closedWait({ resolvedByAgentId: null })
    await closedWait({ resolvedByAgentId: worker })
    await closedWait({ resolvedByAgentId: owner, closedAt: null, resolution: null })
    await closedWait({ resolvedByAgentId: owner, closedAt: new Date(Date.now() - 2 * HOUR) })

    const summary = await countSettledActivity([{ squadId, access: FULL }], since)
    expect(summary).toMatchObject({ since: since.toISOString(), clamped: false })
    expect(summary.counts).toEqual({ questions: 1, reviews: 0 })

    // The Activity filter lists exactly the counted rows.
    const page = await projectGlobalActivity({
      limit: 50,
      verbose: false,
      agentIds: [],
      kinds: [],
      settled: { kind: 'questions', since: since.toISOString() },
      squadAccess: [{ squadId, access: FULL }],
    })
    expect(page.items.map((item) => item.id)).toEqual([`41:${wait.id}`])
  })

  test('counts Reviewer verdicts from their recorded transitions, and nothing for completed streams', async () => {
    const attempt = (id: number, agentTypeId: string) => ({
      id,
      stepId: agentTypeId === 'reviewer' ? 'review' : 'implement',
      status: 'completed',
      participant: { agentTypeId, session: 'reuse-within-stream' },
      step: { id: 'step', kind: 'agent', participant: 'p', instructions: 'x', output: 'y', outcomes: {} },
    })
    await db.insert(workStreamFlowRuns).values({
      workStreamId: streamId,
      activated: true,
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'a'.repeat(64),
      source: {} as never,
      state: { attempts: [attempt(1, 'engineer'), attempt(2, 'reviewer')] } as never,
      createdBy: 'test',
    })
    const verdict = crypto.randomUUID()
    const transition = (requestId: string, actorKey: string, command: Record<string, unknown>, version: number) => ({
      workStreamId: streamId,
      requestId,
      requestHash: 'b'.repeat(64),
      command: { expectedVersion: version - 1, ...command } as never,
      version,
      stateStatus: 'running' as const,
      actorKey,
      createdAt: settledAt(),
    })
    await db.insert(workStreamFlowTransitions).values([
      // The engineer's own completion is not a review.
      transition(
        crypto.randomUUID(),
        `agent:${worker}`,
        { action: 'complete', attemptId: 1, outcome: 'completed', evidence: 'built' },
        1
      ),
      transition(
        verdict,
        `agent:${reviewer}`,
        { action: 'complete', attemptId: 2, outcome: 'changes-requested', evidence: 'Missing a test.' },
        2
      ),
      // A Reviewer's amend revises a result; it is not another verdict.
      transition(crypto.randomUUID(), `agent:${reviewer}`, { action: 'amend', attemptId: 2, evidence: 'more' }, 3),
    ])
    await materializeSourceGroup({ family: 'workstream', groupId: streamId })
    // Completed streams are the Updates header's count, not the line's.
    await doneNotice('done')

    const summary = await countSettledActivity([{ squadId, access: FULL }], since)
    expect(summary.counts).toEqual({ questions: 0, reviews: 1 })

    const reviews = await projectGlobalActivity({
      limit: 50,
      verbose: false,
      agentIds: [],
      kinds: [],
      settled: { kind: 'reviews', since: since.toISOString() },
      squadAccess: [{ squadId, access: FULL }],
    })
    expect(reviews.items).toHaveLength(1)
    expect(reviews.items[0]).toMatchObject({
      id: `32:${verdict}`,
      agentId: reviewer,
      agentTypeId: 'reviewer',
      kind: 'workstream',
      ref: { type: 'workstream', workStreamId: streamId },
    })
    expect(reviews.items[0]!.summary).toContain('review changes requested')
  })

  test('is zero when nothing was settled, and raises an old start to the retention floor', async () => {
    const summary = await countSettledActivity([{ squadId, access: FULL }], since)
    expect(summary.counts).toEqual({ questions: 0, reviews: 0 })
    expect(await countSettledActivity([], since)).toMatchObject({ counts: { questions: 0, reviews: 0 } })
    const old = await countSettledActivity([{ squadId, access: FULL }], new Date(Date.now() - 90 * 24 * HOUR))
    expect(old.clamped).toBe(true)
    expect(old.since).toBe(activityRetentionFloor(new Date()).toISOString())
  })

  test('counts up to `through`, a margin behind the clock, so the next period counts what settled since', async () => {
    await closedWait({ resolvedByAgentId: owner })
    // Settled seconds ago: its row may still be being written while a count runs, so it is left to
    // the period that starts at `through` rather than lost between the two.
    const recent = await closedWait({ resolvedByAgentId: owner, closedAt: new Date(Date.now() - 5_000) })
    const before = Date.now()
    const summary = await countSettledActivity([{ squadId, access: FULL }], since)
    expect(summary.through).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Math.abs(Date.parse(summary.through) - (before - ACTIVITY_SETTLED_MARGIN_MS))).toBeLessThan(10_000)
    expect(summary.counts).toEqual({ questions: 1, reviews: 0 })
    const [row] = await db
      .select({ at: squadActivity.at })
      .from(squadActivity)
      .where(and(eq(squadActivity.rowId, recent.id), eq(squadActivity.lane, 41)))
    expect(row!.at.getTime()).toBeGreaterThan(Date.parse(summary.through))

    // The next visit starts at `through` and counts it: once, and not dropped.
    const next = await countSettledActivity([{ squadId, access: FULL }], new Date(summary.through), new Date())
    expect(next.since).toBe(summary.through)
    const page = await projectGlobalActivity({
      limit: 50,
      verbose: false,
      agentIds: [],
      kinds: [],
      settled: { kind: 'questions', since: summary.through },
      squadAccess: [{ squadId, access: FULL }],
    })
    expect(page.items.map((item) => item.id)).toEqual([`41:${recent.id}`])
    // With no squads there is nothing to count, but the end comes from the same clock and margin.
    const empty = await countSettledActivity([], since)
    expect(Math.abs(Date.parse(empty.through) - (Date.now() - ACTIVITY_SETTLED_MARGIN_MS))).toBeLessThan(10_000)
  })

  test('counts only rows the viewer may read', async () => {
    const wait = await closedWait({ resolvedByAgentId: owner })
    expect(wait.id).toBeTruthy()

    const count = async (access: SquadActivityAccess) =>
      (await countSettledActivity([{ squadId, access }], since)).counts
    expect(await count(FULL)).toEqual({ questions: 1, reviews: 0 })
    // Work stream rows need workstreams:read; inbox access does not matter for these rows.
    expect(await count({ ...FULL, workstreamsRead: false })).toEqual({ questions: 0, reviews: 0 })
    expect(await count({ ...FULL, agentsRead: false, inbox: { mode: 'none' } })).toEqual({ questions: 1, reviews: 0 })
    // A squad the viewer cannot read contributes nothing.
    const [other] = await db
      .insert(squads)
      .values({ name: `settled-other-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(other!.id)
    expect((await countSettledActivity([{ squadId: other!.id, access: FULL }], since)).counts).toEqual({
      questions: 0,
      reviews: 0,
    })
  })
})
