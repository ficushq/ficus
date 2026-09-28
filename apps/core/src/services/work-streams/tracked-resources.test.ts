import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github', 'linear')
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  createBlankWorkflow,
  trackedResourceKey,
  type IntegrationOutputFact,
  type TrackedResource,
} from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  inbox,
  squads,
  workStreams,
  integrationConnections,
  integrationConnectionAssignments,
  integrationOutputDeliveries,
  integrationOutputEvents,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { attachFlow, dispatchFlow } from '../workflows/execution'
import { publishIntegrationOutput } from '../integrations/outputs/runtime'
import type { IntegrationOutputAuthority } from '../integrations/outputs/types'
import {
  TrackedResourceError,
  addTrackedResources,
  authorizeTrackedResource,
  listTrackedResources,
  mergeTracked,
  parseTrackedMetadata,
  removeTrackedResource,
  resolveEventTrackedResource,
  resolveTrackedResourceRequest,
  validateTrackedMetadata,
} from './tracked-resources'

const prefix = `tracked-${randomUUID()}`
const repo = `${prefix}/repo`
const eventIds: string[] = []
let squadId: string
let otherSquadId: string
let connectionId: string
let connectionRevision: string
let fixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

function issueFact(number: number, changes: Partial<IntegrationOutputFact> = {}): IntegrationOutputFact {
  return {
    output: 'issue.assigned',
    version: 1,
    eventKey: randomUUID(),
    resourceKey: `${repo}#${number}`,
    occurredAt: new Date().toISOString(),
    data: { repository: repo, issue: { number }, assignee: 'tau-bot' },
    subject: `Issue ${repo}#${number}`,
    body: 'Please take a look.',
    ...changes,
  }
}
async function insertEvent(fact: IntegrationOutputFact, authority: IntegrationOutputAuthority, integration = 'github') {
  const [row] = await db
    .insert(integrationOutputEvents)
    .values({
      integration,
      sourceKey: `${integration}:${prefix}`,
      eventKey: fact.eventKey,
      authority,
      fact,
    })
    .returning()
  eventIds.push(row!.id)
  return row!
}
function trackedIssue(number: number, repository = repo): TrackedResource {
  return { integration: 'github', repository, kind: 'issue', number }
}
async function createStream(
  options: { metadata?: Record<string, unknown>; flow?: 'follow' | 'no-follow'; status?: 'active' | 'done' } = {}
) {
  return db.transaction(async (tx) => {
    const [stream] = await tx
      .insert(workStreams)
      .values({
        squadId,
        title: prefix,
        status: options.status ?? 'active',
        metadata: options.metadata ?? {},
      })
      .returning()
    if (options.flow) {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = prefix
      definition.completion.followChanges = options.flow === 'follow'
      const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
      await dispatchFlow(tx, stream!, run, [])
    }
    return stream!.id
  })
}
async function metadataOf(id: string) {
  return (await WorkStream.mustFind(id)).metadata as Record<string, any>
}

beforeAll(async () => {
  await db.insert(agentTypes).values({
    id: prefix,
    name: 'Tracked resource fixture worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
  squadId = (await db.insert(squads).values({ name: prefix, purpose: 'Tracked resource fixtures' }).returning())[0]!.id
  otherSquadId = (
    await db
      .insert(squads)
      .values({ name: `${prefix}-other`, purpose: 'Tracked resource fixtures' })
      .returning()
  )[0]!.id
  const fixture = await createTestGitHubConnection({ squadId })
  fixtures.push(fixture)
  connectionId = fixture.id
  const [connection] = await db
    .select({ materialRevision: integrationConnections.materialRevision })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
  connectionRevision = connection!.materialRevision
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, queued: true, status: 'queued' })
})
afterAll(async () => {
  send?.mockRestore()
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.squadId, [squadId, otherSquadId]))
  if (owned.length)
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        owned.map((row) => row.id)
      )
    )
  await db.delete(workStreams).where(inArray(workStreams.squadId, [squadId, otherSquadId]))
  await db.delete(agents).where(inArray(agents.squadId, [squadId, otherSquadId]))
  for (const fixture of fixtures) await fixture.dispose()
  fixtures = []
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

test('an event resolves to a tracked issue only for the squad whose live connection observed it', async () => {
  const fact = issueFact(2101)
  const event = await insertEvent(fact, { kind: 'connection', connectionId, squadId, connectionRevision })
  expect(await resolveEventTrackedResource(event.id, squadId)).toEqual({
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2101,
    connectionId,
    url: `https://github.com/${repo}/issues/2101`,
    origin: {
      eventId: event.id,
      resourceKey: fact.resourceKey,
      output: 'issue.assigned',
      occurredAt: fact.occurredAt,
    },
  })
  await expect(resolveEventTrackedResource(event.id, otherSquadId)).rejects.toMatchObject({
    name: 'TrackedResourceError',
    status: 403,
  })
  await expect(resolveEventTrackedResource(randomUUID(), squadId)).rejects.toMatchObject({ status: 404 })
  const instance = await insertEvent(issueFact(2102), { kind: 'instance' })
  await expect(resolveEventTrackedResource(instance.id, squadId)).rejects.toMatchObject({ status: 403 })
  // Authority names this squad, but the connection is not assigned to it.
  const unassigned = await createTestGitHubConnection({ login: 'unassigned' })
  fixtures.push(unassigned)
  const foreign = await insertEvent(issueFact(2103), {
    kind: 'connection',
    connectionId: unassigned.id,
    squadId,
  })
  await expect(resolveEventTrackedResource(foreign.id, squadId)).rejects.toMatchObject({ status: 403 })
  const untrackable = await insertEvent(issueFact(2104, { data: { repository: repo, assignee: 'tau-bot' } }), {
    kind: 'connection',
    connectionId,
    squadId,
    connectionRevision,
  })
  await expect(resolveEventTrackedResource(untrackable.id, squadId)).rejects.toMatchObject({ status: 400 })
})

test('authorization comes from the squad connection, not from the resource identity', async () => {
  await authorizeTrackedResource(squadId, trackedIssue(2110))
  await expect(authorizeTrackedResource(otherSquadId, trackedIssue(2110))).rejects.toMatchObject({ status: 403 })
  await expect(
    authorizeTrackedResource(squadId, { ...trackedIssue(2110), integration: 'bitbucket' })
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    authorizeTrackedResource(squadId, { ...trackedIssue(2110), repository: 'not a repo' })
  ).rejects.toMatchObject({ status: 400 })
  // A URL request resolves to the same identity and is authorized the same way.
  expect(await resolveTrackedResourceRequest(squadId, { url: `https://github.com/${repo}/pull/2111` })).toMatchObject({
    integration: 'github',
    repository: repo,
    kind: 'pull_request',
    number: 2111,
  })
  await expect(resolveTrackedResourceRequest(squadId, { url: 'https://example.com/x' })).rejects.toMatchObject({
    status: 400,
  })
})

test('adding the same link twice is a no-op and concurrent adds of different links both land', async () => {
  const id = await createStream()
  const first = await addTrackedResources(id, [trackedIssue(2201)])
  expect(first.added.map((resource) => resource.key)).toEqual([trackedResourceKey(trackedIssue(2201))])
  expect(first.view.resources).toHaveLength(1)
  const addedAt = (await metadataOf(id)).tracked[0].addedAt
  expect(addedAt).toBeString()
  const second = await addTrackedResources(id, [trackedIssue(2201)])
  expect(second.added).toEqual([])
  expect(second.view.resources).toHaveLength(1)
  expect((await metadataOf(id)).tracked[0].addedAt).toBe(addedAt)

  const concurrent = await createStream()
  await Promise.all([
    addTrackedResources(concurrent, [trackedIssue(2202)]),
    addTrackedResources(concurrent, [trackedIssue(2203)]),
  ])
  expect((await listTrackedResources(concurrent)).resources.map((resource) => resource.number).sort()).toEqual([
    2202, 2203,
  ])
})

test('mergeTracked keeps existing entries and their stamps while deduping by identity', () => {
  const existing = [{ ...trackedIssue(2210), addedAt: '2024-01-01T00:00:00.000Z' }]
  const merged = mergeTracked(existing, [trackedIssue(2210), trackedIssue(2211)])
  expect(merged).toHaveLength(2)
  expect(merged[0]).toEqual(existing[0]!)
  expect(merged[1]!.number).toBe(2211)
  expect(merged[1]!.addedAt).toBeString()
  expect(mergeTracked(undefined, [])).toEqual([])
})

test('the delivery change request cannot be untracked, and removing a tracked issue keeps the repository', async () => {
  const delivery = await createStream({
    metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2301 } } },
  })
  await expect(
    removeTrackedResource(delivery, { integration: 'github', repository: repo, kind: 'pull_request', number: 2301 })
  ).rejects.toMatchObject({ status: 409 })
  expect((await metadataOf(delivery)).codeHost.changeRequest.number).toBe(2301)

  // A legacy `github.issue` alongside the tracked entry is inert: removing the entry removes the link.
  const attached = await createStream({
    metadata: { github: { repo, issue: 2302 }, tracked: [trackedIssue(2302)] },
  })
  const removed = await removeTrackedResource(attached, {
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2302,
  })
  expect(removed.removed).toBe(true)
  expect(removed.view.resources).toEqual([])
  const metadata = await metadataOf(attached)
  expect(metadata.tracked).toEqual([])
  expect(metadata.github.repo).toBe(repo)

  const missing = await createStream()
  expect((await removeTrackedResource(missing, { ...trackedIssue(2303) })).removed).toBe(false)
})

test('removing a tracked link supersedes its pending deliveries', async () => {
  const resource = trackedIssue(2310)
  const id = await createStream({ metadata: { tracked: [resource] }, flow: 'follow' })
  eventIds.push(
    (await publishIntegrationOutput('github', issueFact(2310, { output: 'issue.updated' }), {
      kind: 'connection',
      connectionId,
      squadId,
    }))!
  )
  const before = await db
    .select()
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.workStreamId, id))
  expect(before).toHaveLength(1)
  expect(before[0]!.status).not.toBe('superseded')
  const result = await removeTrackedResource(id, {
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2310,
  })
  expect(result.removed).toBe(true)
  expect(result.view.resources).toEqual([])
  expect((await metadataOf(id)).tracked).toEqual([])
  const after = await db
    .select()
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.workStreamId, id))
  expect(after[0]).toMatchObject({ status: 'superseded', reason: 'Subscription changed' })
})

test('the view explains why links are not subscribed', async () => {
  const resource = trackedIssue(2401)
  const noFlow = await listTrackedResources(await createStream({ metadata: { tracked: [resource] } }))
  expect(noFlow.subscriptions).toBe('no-flow')
  expect(noFlow.resources.map((item) => item.subscribed)).toEqual([false])

  const notFollowing = await listTrackedResources(
    await createStream({ metadata: { tracked: [resource] }, flow: 'no-follow' })
  )
  expect(notFollowing.subscriptions).toBe('not-following')
  expect(notFollowing.resources.every((item) => !item.subscribed && item.subscriptionIds.length === 0)).toBe(true)

  const active = await listTrackedResources(await createStream({ metadata: { tracked: [resource] }, flow: 'follow' }))
  expect(active.subscriptions).toBe('active')
  expect(active.resources).toHaveLength(1)
  expect(active.resources[0]!.subscribed).toBe(true)
  expect(active.resources[0]!.subscriptionIds.length).toBeGreaterThan(0)

  const ended = await createStream({ metadata: { tracked: [resource] }, flow: 'follow' })
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, ended))
  const endedView = await listTrackedResources(ended)
  expect(endedView.subscriptions).toBe('ended')
  expect(endedView.resources.map((item) => item.subscribed)).toEqual([false])

  await expect(listTrackedResources(randomUUID())).rejects.toMatchObject({ status: 404 })
})

test('tracked metadata is validated on write and only new entries are authorized', async () => {
  await expect(validateTrackedMetadata(squadId, { tracked: [{ bad: true }] })).rejects.toMatchObject({ status: 400 })
  await expect(validateTrackedMetadata(squadId, { tracked: 'nope' })).rejects.toMatchObject({ status: 400 })
  await expect(validateTrackedMetadata(otherSquadId, { tracked: [trackedIssue(2501)] })).rejects.toMatchObject({
    status: 403,
  })
  // An unchanged entry is never re-authorized, so a squad that lost its connection can still be updated.
  const metadata: Record<string, unknown> = {
    tracked: [{ ...trackedIssue(2501), addedAt: '2024-01-01T00:00:00.000Z' }],
  }
  await validateTrackedMetadata(otherSquadId, metadata, { tracked: [trackedIssue(2501)] })
  expect(metadata.tracked).toEqual([{ ...trackedIssue(2501), addedAt: '2024-01-01T00:00:00.000Z' }])
  await validateTrackedMetadata(otherSquadId, { title: 'no tracked key' })
  expect(new TrackedResourceError('nope', 409).status).toBe(409)
})

test('origin is server-managed: a caller cannot claim an event it did not create from', async () => {
  const eventId = randomUUID()
  const claimed = {
    ...trackedIssue(2601),
    origin: { eventId, resourceKey: `${repo}#2601`, output: 'issue.assigned' },
  }
  await expect(validateTrackedMetadata(squadId, { tracked: [claimed] })).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining('origin is server-managed'),
  })
  await expect(
    validateTrackedMetadata(squadId, { tracked: [claimed] }, undefined, { allowOriginEventId: randomUUID() })
  ).rejects.toMatchObject({ status: 400 })
  // The create-from-event path stamps the origin itself, so its own event id is allowed.
  await validateTrackedMetadata(squadId, { tracked: [claimed] }, undefined, { allowOriginEventId: eventId })
  // An entry already stored keeps the origin it was created with.
  await validateTrackedMetadata(otherSquadId, { tracked: [claimed] }, { tracked: [claimed] })
})

test('a stored origin may only be kept exactly as stored, never added or rewritten', async () => {
  const origin = { eventId: randomUUID(), resourceKey: `${repo}#2610`, output: 'issue.assigned' }
  const stored = { ...trackedIssue(2610), addedAt: '2024-01-01T00:00:00.000Z', origin }
  const previous = { tracked: [stored] }
  // Resubmitting the stored entry unchanged is accepted without re-authorizing it.
  await validateTrackedMetadata(otherSquadId, { tracked: [{ ...stored }] }, previous)
  // The same identity with a different origin is a forgery, even though the key already exists.
  await expect(
    validateTrackedMetadata(
      otherSquadId,
      { tracked: [{ ...stored, origin: { ...origin, eventId: randomUUID() } }] },
      previous
    )
  ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('origin is server-managed') })

  // An entry stored without an origin cannot acquire one on a later write.
  const plain = { ...trackedIssue(2611), addedAt: '2024-01-01T00:00:00.000Z' }
  await expect(
    validateTrackedMetadata(otherSquadId, { tracked: [{ ...plain, origin }] }, { tracked: [plain] })
  ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('origin is server-managed') })

  // The delivery pull request resolves without a `tracked` entry, so an origin on it is new and refused,
  // while the same identity without one still skips authorization.
  const deliveryPr = { integration: 'github' as const, repository: repo, kind: 'pull_request' as const, number: 2612 }
  const delivery = { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2612 } } }
  await expect(
    validateTrackedMetadata(
      otherSquadId,
      { tracked: [{ ...deliveryPr, origin: { ...origin, resourceKey: `${repo}#2612` } }] },
      delivery
    )
  ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('origin is server-managed') })
  await validateTrackedMetadata(otherSquadId, { tracked: [{ ...deliveryPr }] }, delivery)
})

test('parseTrackedMetadata validates shape without reading the database', () => {
  const metadata: Record<string, unknown> = { tracked: [{ ...trackedIssue(2701), url: undefined }] }
  expect(parseTrackedMetadata(metadata)).toEqual([trackedIssue(2701)])
  expect(metadata.tracked).toEqual([trackedIssue(2701)])
  expect(parseTrackedMetadata({ title: 'no tracked key' })).toBeNull()
  expect(() => parseTrackedMetadata({ tracked: 'nope' })).toThrow('metadata.tracked must be an array')
  expect(() => parseTrackedMetadata({ tracked: [{ bad: true }] })).toThrow('metadata.tracked[0] is invalid')
})

test('a tracked pull request can be designated for delivery, and issues can never be', async () => {
  const id = await createStream({
    metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2210 } } },
  })
  const pullRequest = { integration: 'github', repository: repo, kind: 'pull_request' as const, number: 2211 }
  const plain = await addTrackedResources(id, [pullRequest])
  expect(plain.changed).toBe(true)
  expect(plain.view.delivery.pullRequests.map((item) => item.number)).toEqual([2210])

  // Designating an already tracked pull request adds nothing but does change the stream.
  const flagged = await addTrackedResources(id, [{ ...pullRequest, delivery: true }])
  expect(flagged.added).toEqual([])
  expect(flagged.changed).toBe(true)
  expect((await metadataOf(id)).tracked).toHaveLength(1)
  expect((await metadataOf(id)).tracked[0].delivery).toBe(true)
  expect(flagged.view.delivery).toEqual({
    pullRequests: [
      {
        key: trackedResourceKey({ ...pullRequest, number: 2210 }),
        repository: repo,
        number: 2210,
        url: `https://github.com/${repo}/pull/2210`,
        primary: true,
        state: 'open',
      },
      {
        key: trackedResourceKey(pullRequest),
        repository: repo,
        number: 2211,
        url: `https://github.com/${repo}/pull/2211`,
        primary: false,
        state: 'open',
      },
    ],
    complete: false,
  })
  expect((await addTrackedResources(id, [{ ...pullRequest, delivery: true }])).changed).toBe(false)

  // The primary delivery pull request is already designated: re-adding it with the flag is a no-op.
  const primary = await addTrackedResources(id, [
    { integration: 'github', repository: repo, kind: 'pull_request', number: 2210, delivery: true },
  ])
  expect(primary.added).toEqual([])
  expect(primary.changed).toBe(false)
  expect((await metadataOf(id)).tracked).toHaveLength(1)

  expect(
    await resolveTrackedResourceRequest(squadId, { url: `https://github.com/${repo}/pull/2212`, delivery: true })
  ).toMatchObject({ kind: 'pull_request', number: 2212, delivery: true })
  await expect(
    resolveTrackedResourceRequest(squadId, { url: `https://github.com/${repo}/issues/2213`, delivery: true })
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    resolveTrackedResourceRequest(squadId, { resource: trackedIssue(2214), delivery: true })
  ).rejects.toMatchObject({ status: 400 })
})

test('the view reports the observed merge state of each delivery pull request', async () => {
  const flagged = {
    integration: 'github',
    repository: repo,
    kind: 'pull_request' as const,
    number: 2431,
    delivery: true as const,
  }
  const primaryKey = trackedResourceKey({ ...flagged, number: 2430 })
  const id = await createStream({
    metadata: {
      codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2430 } },
      tracked: [flagged, trackedIssue(2432)],
      delivery: {
        pullRequests: {
          [primaryKey]: { state: 'merged', at: '2026-01-01T00:00:00.000Z', headSha: 'a'.repeat(40) },
        },
      },
    },
  })
  const view = await listTrackedResources(id)
  expect(view.resources.map((resource) => [resource.number, resource.mergeState])).toEqual([
    [2430, 'merged'],
    [2431, undefined],
    [2432, undefined],
  ])
  expect(view.delivery.complete).toBe(false)
  expect(view.delivery.pullRequests.map((item) => [item.number, item.state, item.primary])).toEqual([
    [2430, 'merged', true],
    [2431, 'open', false],
  ])
})

test('an issue is never stamped as a delivery pull request, however it is designated', async () => {
  const id = await createStream({ metadata: { tracked: [trackedIssue(2440)] } })
  // The request layer rejects `delivery` on an issue with a 400, so this can only come from an
  // internal caller — the write itself still refuses to flag anything that is not a pull request.
  const result = await addTrackedResources(id, [{ ...trackedIssue(2440), delivery: true }])
  expect(result.added).toEqual([])
  const metadata = await metadataOf(id)
  expect(metadata.tracked).toHaveLength(1)
  expect(metadata.tracked[0].delivery).toBeUndefined()
  expect(result.view.resources.map((resource) => resource.delivery)).toEqual([false])
  expect(result.view.delivery).toEqual({ pullRequests: [], complete: false })
})

test('untracking a delivery pull request drops the delivery state it left behind', async () => {
  const flagged = {
    integration: 'github',
    repository: repo,
    kind: 'pull_request' as const,
    number: 2451,
    delivery: true as const,
  }
  const flaggedKey = trackedResourceKey(flagged)
  const primaryKey = trackedResourceKey({ ...flagged, number: 2450 })
  const observed = { state: 'merged' as const, at: '2026-01-01T00:00:00.000Z', headSha: 'a'.repeat(40) }
  const id = await createStream({
    metadata: {
      codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2450 } },
      tracked: [flagged, trackedIssue(2452)],
      delivery: { pullRequests: { [primaryKey]: observed, [flaggedKey]: observed } },
    },
  })
  // Removing the issue is not a pull request removal: the delivery state is untouched.
  expect((await removeTrackedResource(id, { ...trackedIssue(2452) })).removed).toBe(true)
  expect(Object.keys((await metadataOf(id)).delivery.pullRequests).sort()).toEqual([primaryKey, flaggedKey].sort())

  const removed = await removeTrackedResource(id, {
    integration: 'github',
    repository: repo,
    kind: 'pull_request',
    number: 2451,
  })
  expect(removed.removed).toBe(true)
  expect(removed.view.delivery.pullRequests.map((item) => item.number)).toEqual([2450])
  // The orphaned entry is gone; the primary's own state survives.
  expect((await metadataOf(id)).delivery).toEqual({ pullRequests: { [primaryKey]: observed } })

  // The last entry takes the whole object with it rather than leaving an empty husk.
  const solo = await createStream({
    metadata: { tracked: [flagged], delivery: { pullRequests: { [flaggedKey]: observed } } },
  })
  expect(
    (await removeTrackedResource(solo, { integration: 'github', repository: repo, kind: 'pull_request', number: 2451 }))
      .removed
  ).toBe(true)
  expect(await metadataOf(solo)).not.toHaveProperty('delivery')
})

const linearConnections: Array<() => Promise<void>> = []
/** A Linear connection the squad may use: assignment is the only thing authorization reads. */
async function createLinearConnection(target: string, overrides: Record<string, unknown> = {}) {
  const { getSecretStore } = await import('../secrets')
  const id = randomUUID()
  const revision = randomUUID()
  const credentialRef = `__integration-test:linear:${id}`
  await getSecretStore().set(credentialRef, 'lin_api_fixture', 'test')
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'linear',
    adapterVersion: 1,
    displayName: 'linear-fixture',
    configuration: { version: 1 },
    credentialRef,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    materialRevision: revision,
    validatedRevision: revision,
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  })
  await db
    .insert(integrationConnectionAssignments)
    .values({ squadId: target, providerKey: 'linear', connectionId: id, isDefault: true })
  const dispose = async () => {
    await db.delete(integrationConnectionAssignments).where(eq(integrationConnectionAssignments.connectionId, id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    await getSecretStore().delete(credentialRef)
  }
  linearConnections.push(dispose)
  return { id, dispose }
}
/** Stand in for Linear's GraphQL endpoint; `null` is an issue this connection cannot read. */
function stubLinearIssue(issue: unknown, queries: unknown[] = []) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: { body?: string }) => {
    queries.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ data: { issue } }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch)
}
const linearIssue = {
  id: 'f2a7c1e0-1111-4222-8333-444455556666',
  url: 'https://linear.app/acme/issue/ENG-12/keyboard-navigation',
  number: 12,
  team: { key: 'ENG' },
}

test('a typed reference resolves on the provider that owns it, and GitHub needs the caller to pick a kind', async () => {
  expect(await resolveTrackedResourceRequest(squadId, { reference: `${repo}#2401` })).toMatchObject({
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2401,
  })
  expect(
    await resolveTrackedResourceRequest(squadId, { reference: `${repo}#2402`, kind: 'pull_request' })
  ).toMatchObject({ integration: 'github', repository: repo, kind: 'pull_request', number: 2402 })
  await expect(resolveTrackedResourceRequest(squadId, { reference: 'not a reference' })).rejects.toMatchObject({
    status: 400,
  })
  // A squad with no Linear connection cannot claim a Linear issue, however well-formed.
  await expect(resolveTrackedResourceRequest(squadId, { reference: 'ENG-12' })).rejects.toMatchObject({ status: 403 })
})

test('a Linear link is described by the squad’s own connection, recording the provider id and URL', async () => {
  await createLinearConnection(squadId)
  const queries: unknown[] = []
  const fetching = stubLinearIssue(linearIssue, queries)
  try {
    const expected = {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 12,
      externalId: linearIssue.id,
      url: linearIssue.url,
    }
    expect(await resolveTrackedResourceRequest(squadId, { reference: 'eng-12' })).toMatchObject(expected)
    expect(await resolveTrackedResourceRequest(squadId, { url: linearIssue.url })).toMatchObject(expected)
    expect(queries).toHaveLength(2)
    expect((queries[0] as { variables: unknown }).variables).toEqual({ id: 'ENG-12' })
    // An identity that already carries both is not re-read: the provider is asked only what is missing.
    const known = {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue' as const,
      number: 12,
      externalId: linearIssue.id,
      url: linearIssue.url,
    }
    expect(await resolveTrackedResourceRequest(squadId, { resource: known })).toMatchObject(known)
    expect(queries).toHaveLength(2)
    // A link the connection cannot read is not a link this squad may keep.
    fetching.mockRestore()
    const missing = stubLinearIssue(null)
    try {
      await expect(resolveTrackedResourceRequest(squadId, { reference: 'ENG-13' })).rejects.toMatchObject({
        status: 404,
      })
    } finally {
      missing.mockRestore()
    }
    // A provider failure is an identity answer, not a leaked provider error.
    const failing = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('linear said no'))
    try {
      await expect(resolveTrackedResourceRequest(squadId, { reference: 'ENG-14' })).rejects.toMatchObject({
        status: 404,
      })
    } finally {
      failing.mockRestore()
    }
  } finally {
    fetching.mockRestore()
    for (const dispose of linearConnections.splice(0)) await dispose()
  }
})

test('Linear links are authorized by the squad’s own assignment, and Linear has no pull requests', async () => {
  const issue: TrackedResource = { integration: 'linear', repository: 'eng', kind: 'issue', number: 12 }
  const pullRequest: TrackedResource = { ...issue, kind: 'pull_request' }
  // Linear has no pull requests, so the kind is refused before any connection is consulted.
  await expect(authorizeTrackedResource(squadId, pullRequest)).rejects.toMatchObject({ status: 400 })
  await expect(
    resolveTrackedResourceRequest(squadId, { reference: 'ENG-12', kind: 'pull_request' })
  ).rejects.toMatchObject({ status: 400 })
  await expect(resolveTrackedResourceRequest(squadId, { resource: pullRequest, delivery: true })).rejects.toMatchObject(
    { status: 400 }
  )
  // A disabled or unauthenticated assignment is not one this squad may act on.
  for (const overrides of [{ enabled: false }, { authState: 'pending' }]) {
    const connection = await createLinearConnection(squadId, overrides)
    await expect(authorizeTrackedResource(squadId, issue)).rejects.toMatchObject({ status: 403 })
    await connection.dispose()
  }
  const connection = await createLinearConnection(squadId)
  const fetching = stubLinearIssue(linearIssue)
  try {
    await authorizeTrackedResource(squadId, issue)
    await authorizeTrackedResource(squadId, { ...issue, connectionId: connection.id })
    // A link pinned to another account is not authorized by this squad's assignment.
    await expect(authorizeTrackedResource(squadId, { ...issue, connectionId: randomUUID() })).rejects.toMatchObject({
      status: 403,
    })
    // A reference may name the account it belongs to; it is checked, never quietly ignored.
    expect(
      await resolveTrackedResourceRequest(squadId, { reference: 'ENG-12', connectionId: connection.id })
    ).toMatchObject({ integration: 'linear', repository: 'eng', number: 12, connectionId: connection.id })
    await expect(
      resolveTrackedResourceRequest(squadId, { reference: 'ENG-12', connectionId: randomUUID() })
    ).rejects.toMatchObject({ status: 403 })
  } finally {
    fetching.mockRestore()
    await connection.dispose()
  }
})

/** A Linear comment fact: Linear names the issue by UUID only, exactly as it delivers it. */
function linearCommentFact(issueId: string): IntegrationOutputFact {
  return {
    output: 'issue.comment',
    version: 1,
    eventKey: randomUUID(),
    resourceKey: issueId,
    occurredAt: new Date().toISOString(),
    data: { issue: { id: issueId }, teamId: 'team-uuid', actor: 'user-a', action: 'create' },
    subject: 'Linear comment',
    body: 'Could you take another look?',
  }
}

test('a Linear comment event is completed through the squad’s connection, by the issue’s own id', async () => {
  const linear = await createLinearConnection(squadId)
  const event = await insertEvent(
    linearCommentFact(linearIssue.id),
    { kind: 'connection', connectionId: linear.id, squadId },
    'linear'
  )
  const queries: unknown[] = []
  const fetching = stubLinearIssue(linearIssue, queries)
  try {
    // The fact carries no team key or number, so the provider is asked by the UUID it does carry.
    expect(await resolveEventTrackedResource(event.id, squadId)).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 12,
      externalId: linearIssue.id,
      url: linearIssue.url,
      connectionId: linear.id,
      origin: {
        eventId: event.id,
        resourceKey: linearIssue.id,
        output: 'issue.comment',
        occurredAt: event.fact.occurredAt,
      },
    })
    expect((queries[0] as { variables: unknown }).variables).toEqual({ id: linearIssue.id })
    // Correlation is still not access: another squad never reaches the provider at all.
    await expect(resolveEventTrackedResource(event.id, otherSquadId)).rejects.toMatchObject({ status: 403 })
    expect(queries).toHaveLength(1)
  } finally {
    fetching.mockRestore()
  }
  // An issue this connection cannot read is not a link this squad may keep.
  const missing = stubLinearIssue(null)
  try {
    await expect(resolveEventTrackedResource(event.id, squadId)).rejects.toMatchObject({ status: 404 })
  } finally {
    missing.mockRestore()
    await linear.dispose()
    linearConnections.length = 0
  }
})

test('a stale Linear connection asks for revalidation; an unreadable issue answers without provider text', async () => {
  const stale = await createLinearConnection(squadId, { validationExpiresAt: new Date(Date.now() - 1000) })
  const unused = stubLinearIssue(linearIssue)
  try {
    // Authorization still holds — the squad keeps its assignment — but nothing may be read with it.
    await expect(resolveTrackedResourceRequest(squadId, { reference: 'ENG-12' })).rejects.toMatchObject({
      status: 409,
      message: 'Linear connection needs revalidation before linking',
    })
    expect(unused).not.toHaveBeenCalled()
  } finally {
    unused.mockRestore()
    await stale.dispose()
  }
  const live = await createLinearConnection(squadId)
  const failing = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('linear said no: token lin_api_secret'))
  try {
    const error = await resolveTrackedResourceRequest(squadId, { reference: 'ENG-15' }).catch((caught) => caught)
    expect(error).toMatchObject({ status: 404 })
    expect(error.message).toContain('ENG-15')
    expect(error.message).not.toContain('lin_api_secret')
    expect(error.message).not.toContain('linear said no')
  } finally {
    failing.mockRestore()
  }
  // The provider's own answer still has to be an identity this instance can follow.
  const malformed = stubLinearIssue({ ...linearIssue, team: { key: 'not a team key' } })
  try {
    await expect(resolveTrackedResourceRequest(squadId, { reference: 'ENG-12' })).rejects.toMatchObject({
      status: 400,
    })
  } finally {
    malformed.mockRestore()
    await live.dispose()
  }
})
