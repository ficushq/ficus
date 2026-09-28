import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { trackedResourceKey, type IntegrationOutputFact, type TrackedResource } from '@ficus/shared'
import { db, squads, workStreams, integrationOutputEvents } from '../../db'
import type { IntegrationOutputAuthority } from '../integrations/outputs/types'
import { deliveryView, recordDeliveryObservation, recordDeliveryVerification } from './delivery-pull-requests'

const prefix = `delivery-${randomUUID()}`
const repo = `${prefix}/repo`
const other = `${prefix}/other`
const eventIds: string[] = []
let squadId: string

const primaryKey = trackedResourceKey({ integration: 'github', repository: repo, kind: 'pull_request', number: 10 })
const flagged: TrackedResource = {
  integration: 'github',
  repository: other,
  kind: 'pull_request',
  number: 20,
  delivery: true,
}
const flaggedKey = trackedResourceKey(flagged)
const unflagged: TrackedResource = { integration: 'github', repository: other, kind: 'pull_request', number: 21 }
const trackedIssue: TrackedResource = { integration: 'github', repository: other, kind: 'issue', number: 22 }
const baseMetadata = {
  codeHost: { integration: 'github', repository: repo, changeRequest: { number: 10 } },
  tracked: [flagged, unflagged, trackedIssue],
}

function prFact(
  repository: string,
  number: number,
  changes: Partial<IntegrationOutputFact> & { data?: Record<string, unknown> } = {}
): IntegrationOutputFact {
  return {
    output: 'pull_request.merged',
    version: 1,
    eventKey: randomUUID(),
    resourceKey: `${repository}#${number}`,
    occurredAt: new Date().toISOString(),
    data: { repository, pullRequest: { number, headSha: 'a'.repeat(40) } },
    subject: `PR ${repository}#${number}`,
    body: '',
    ...changes,
  }
}
async function insertEvent(fact: IntegrationOutputFact, authority: IntegrationOutputAuthority = { kind: 'instance' }) {
  const [row] = await db
    .insert(integrationOutputEvents)
    .values({ integration: 'github', sourceKey: `github:${prefix}`, eventKey: fact.eventKey, authority, fact })
    .returning()
  eventIds.push(row!.id)
  return row!
}
async function createStream(metadata: Record<string, unknown> = baseMetadata) {
  const [row] = await db.insert(workStreams).values({ squadId, title: prefix, metadata }).returning()
  return row!
}
async function metadataOf(id: string) {
  const [row] = await db.select().from(workStreams).where(eq(workStreams.id, id))
  return row!.metadata as Record<string, any>
}
async function updatedAtOf(id: string) {
  const [row] = await db.select({ updatedAt: workStreams.updatedAt }).from(workStreams).where(eq(workStreams.id, id))
  return row!.updatedAt.getTime()
}
/** `updatedAt` has no database default on update, so a stale one has to be visible to be caught. */
async function backdate(id: string) {
  const stale = new Date('2020-01-01T00:00:00.000Z')
  await db.update(workStreams).set({ updatedAt: stale }).where(eq(workStreams.id, id))
  return stale.getTime()
}
/** Runs the observation exactly as `matchOutputEvent` does: inside the caller's transaction. */
async function observe(streamId: string, event: Awaited<ReturnType<typeof insertEvent>>) {
  return db.transaction(async (tx) => {
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    return recordDeliveryObservation(tx, stream!, event)
  })
}

beforeAll(async () => {
  squadId = (await db.insert(squads).values({ name: prefix, purpose: 'Delivery state fixtures' }).returning())[0]!.id
})
afterAll(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

test('the delivery view is complete only when every designated pull request is merged', () => {
  expect(deliveryView({})).toEqual({ pullRequests: [], complete: false })
  expect(deliveryView({ tracked: [trackedIssue] })).toEqual({ pullRequests: [], complete: false })
  // An unobserved delivery PR reads as open, never as complete.
  const unobserved = deliveryView(baseMetadata)
  expect(unobserved.complete).toBe(false)
  expect(unobserved.pullRequests).toEqual([
    {
      key: primaryKey,
      repository: repo,
      number: 10,
      url: `https://github.com/${repo}/pull/10`,
      primary: true,
      state: 'open',
    },
    {
      key: flaggedKey,
      repository: other,
      number: 20,
      url: `https://github.com/${other}/pull/20`,
      primary: false,
      state: 'open',
    },
  ])

  const halfway = deliveryView({
    ...baseMetadata,
    delivery: { pullRequests: { [primaryKey]: { state: 'merged', at: '2026-01-01T00:00:00.000Z' } } },
  })
  expect(halfway.pullRequests.map((pr) => pr.state)).toEqual(['merged', 'open'])
  expect(halfway.complete).toBe(false)

  const done = deliveryView({
    ...baseMetadata,
    delivery: {
      pullRequests: {
        [primaryKey]: { state: 'merged', at: '2026-01-01T00:00:00.000Z', headSha: 'b'.repeat(40) },
        [flaggedKey]: { state: 'merged', at: '2026-01-02T00:00:00.000Z' },
      },
    },
  })
  expect(done.complete).toBe(true)
  expect(done.pullRequests[0]).toMatchObject({ at: '2026-01-01T00:00:00.000Z', headSha: 'b'.repeat(40) })
  // Malformed stored state never leaks into the view.
  expect(deliveryView({ ...baseMetadata, delivery: 'nope' }).pullRequests.map((pr) => pr.state)).toEqual([
    'open',
    'open',
  ])
})

test('observations record merge, close and reopen for designated pull requests only', async () => {
  const stream = await createStream()
  const stale = await backdate(stream.id)
  const merged = await insertEvent(prFact(other, 20, { occurredAt: '2026-02-01T00:00:00.000Z' }))
  expect(await observe(stream.id, merged)).toBe(true)
  // The row changed, so it stamps `updatedAt` like every other work-stream writer.
  expect(await updatedAtOf(stream.id)).toBeGreaterThan(stale)
  expect((await metadataOf(stream.id)).delivery.pullRequests[flaggedKey]).toEqual({
    state: 'merged',
    at: '2026-02-01T00:00:00.000Z',
    headSha: 'a'.repeat(40),
    eventId: merged.id,
  })
  // The rest of the metadata survives the write.
  expect((await metadataOf(stream.id)).tracked).toHaveLength(3)

  const closedPrimary = await insertEvent(
    prFact(repo, 10, { output: 'pull_request.closed', occurredAt: '2026-02-02T00:00:00.000Z' })
  )
  expect(await observe(stream.id, closedPrimary)).toBe(true)
  expect((await metadataOf(stream.id)).delivery.pullRequests[primaryKey]).toMatchObject({ state: 'closed' })

  const reopened = await insertEvent(
    prFact(repo, 10, {
      output: 'pull_request.updated',
      occurredAt: '2026-02-03T00:00:00.000Z',
      data: { repository: repo, pullRequest: { number: 10 }, action: 'reopened' },
    })
  )
  expect(await observe(stream.id, reopened)).toBe(true)
  expect((await metadataOf(stream.id)).delivery.pullRequests[primaryKey]).toMatchObject({ state: 'open' })

  // Anything that is not a designated delivery pull request leaves the state alone.
  const ignored = [
    await insertEvent(prFact(other, 21)),
    await insertEvent(
      prFact(other, 22, {
        output: 'issue.assigned',
        data: { repository: other, issue: { number: 22 }, assignee: 'tau-bot' },
      })
    ),
    await insertEvent(
      prFact(repo, 10, {
        output: 'pull_request.updated',
        data: { repository: repo, pullRequest: { number: 10 }, action: 'synchronize' },
      })
    ),
    await insertEvent(prFact(other, 99)),
  ]
  for (const event of ignored) expect(await observe(stream.id, event)).toBe(false)
  expect(Object.keys((await metadataOf(stream.id)).delivery.pullRequests).sort()).toEqual(
    [primaryKey, flaggedKey].sort()
  )
})

test('an older observation never overwrites a newer one, and malformed state is replaced', async () => {
  const stream = await createStream({
    ...baseMetadata,
    delivery: { pullRequests: { [flaggedKey]: 'not a state' } },
  })
  const merged = await insertEvent(prFact(other, 20, { occurredAt: '2026-03-02T00:00:00.000Z' }))
  expect(await observe(stream.id, merged)).toBe(true)
  expect((await metadataOf(stream.id)).delivery.pullRequests[flaggedKey]).toMatchObject({ state: 'merged' })

  const late = await insertEvent(
    prFact(other, 20, { output: 'pull_request.closed', occurredAt: '2026-03-01T00:00:00.000Z' })
  )
  expect(await observe(stream.id, late)).toBe(false)
  expect((await metadataOf(stream.id)).delivery.pullRequests[flaggedKey]).toMatchObject({ state: 'merged' })

  const newer = await insertEvent(
    prFact(other, 20, { output: 'pull_request.closed', occurredAt: '2026-03-03T00:00:00.000Z' })
  )
  expect(await observe(stream.id, newer)).toBe(true)
  expect((await metadataOf(stream.id)).delivery.pullRequests[flaggedKey]).toMatchObject({
    state: 'closed',
    eventId: newer.id,
  })
})

test('an observation from another connection than the designated one is ignored', async () => {
  const connectionId = randomUUID()
  const stream = await createStream({
    ...baseMetadata,
    tracked: [{ ...flagged, connectionId }],
  })
  const foreign = await insertEvent(prFact(other, 20), {
    kind: 'connection',
    connectionId: randomUUID(),
    squadId,
  })
  expect(await observe(stream.id, foreign)).toBe(false)
  const own = await insertEvent(prFact(other, 20), { kind: 'connection', connectionId, squadId })
  expect(await observe(stream.id, own)).toBe(true)
  expect((await metadataOf(stream.id)).delivery.pullRequests[flaggedKey]).toMatchObject({ state: 'merged' })
})

test('verification results are written under the stream lock without disturbing other metadata', async () => {
  const stream = await createStream()
  const stale = await backdate(stream.id)
  const results = [
    { key: primaryKey, state: 'merged' as const, headSha: 'c'.repeat(40) },
    { key: flaggedKey, state: 'merged' as const },
  ]
  await recordDeliveryVerification(stream.id, results)
  const metadata = await metadataOf(stream.id)
  expect(metadata.codeHost).toEqual(baseMetadata.codeHost)
  expect(metadata.tracked).toHaveLength(3)
  expect(deliveryView(metadata).complete).toBe(true)
  expect(metadata.delivery.pullRequests[primaryKey]).toMatchObject({ state: 'merged', headSha: 'c'.repeat(40) })
  expect(metadata.delivery.pullRequests[flaggedKey]!.at).toBeString()
  const written = await updatedAtOf(stream.id)
  expect(written).toBeGreaterThan(stale)

  // Re-verifying the same evidence changes nothing, so it must not touch the row at all.
  await backdate(stream.id)
  await recordDeliveryVerification(stream.id, results)
  expect(await updatedAtOf(stream.id)).toBe(stale)
  expect(await metadataOf(stream.id)).toEqual(metadata)

  // A differing head sha is new evidence: it is written, and stamps `updatedAt`.
  await recordDeliveryVerification(stream.id, [{ key: primaryKey, state: 'merged', headSha: 'd'.repeat(40) }])
  expect((await metadataOf(stream.id)).delivery.pullRequests[primaryKey]).toMatchObject({ headSha: 'd'.repeat(40) })
  expect(await updatedAtOf(stream.id)).toBeGreaterThan(stale)
})
