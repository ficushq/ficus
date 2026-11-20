import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  agents,
  db,
  inbox,
  integrationConnectionAssignments,
  integrationConnections,
  integrationOutputEvents,
  squads,
} from '../../../db'
import { getSecretStore } from '../../secrets'
import { linearOutputAdapter } from './outputs'
import { canReceiveLinearEvent, routeLinearEvent } from './ingress'

const store = getSecretStore()
const connectionIds: string[] = []
const squadIds: string[] = []
const credentialRefs: string[] = []
const eventKeys: string[] = []
/** Squad A's connected account is the assignee; squad B's account can read the issue but owns nothing. */
let squadA: string
let squadB: string
const keyA = 'linear-key-a'
const keyB = 'linear-key-b'

async function createSquadWithLinear(credential: string) {
  const squadId = (
    await db
      .insert(squads)
      .values({ name: `linear-ingress-${randomUUID()}`, purpose: 'Linear ingress fixtures' })
      .returning()
  )[0]!.id
  const id = randomUUID()
  const revision = randomUUID()
  const credentialRef = `__integration-test:linear:${id}`
  await store.set(credentialRef, credential, 'test')
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'linear',
    adapterVersion: 1,
    displayName: `Linear test account ${id}`,
    configuration: { version: 1 },
    credentialRef,
    materialRevision: revision,
    validatedRevision: revision,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 900_000),
  })
  await db
    .insert(integrationConnectionAssignments)
    .values({ squadId, providerKey: 'linear', connectionId: id, isDefault: true })
  squadIds.push(squadId)
  connectionIds.push(id)
  credentialRefs.push(credentialRef)
  return squadId
}

/** Answers the per-squad probe by API key, so each connected account sees what its viewer sees. */
function stubLinear(access: Record<string, unknown>) {
  const probed: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const credential = new Headers(init?.headers).get('Authorization') ?? ''
    probed.push(credential)
    const data = access[credential]
    return data ? Response.json({ data }) : Response.json({ errors: [{ message: 'not authorized' }] })
  }) as unknown as typeof fetch
  return probed
}
function readable(viewerId: string, assigneeId: string | null = null) {
  return {
    viewer: { id: viewerId },
    issue: { id: 'issue-uuid', team: { id: 'team-uuid' }, assignee: assigneeId ? { id: assigneeId } : null },
  }
}
function issueEvent(updatedFrom: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return {
    type: 'Issue',
    payload: {
      action: 'update',
      updatedFrom,
      data: {
        id: 'issue-uuid',
        number: 123,
        identifier: 'ENG-123',
        title: 'Fix bug',
        url: 'https://linear.app/acme/issue/ENG-123',
        teamId: 'team-uuid',
        team: { id: 'team-uuid', key: 'ENG' },
        state: { id: 'state-uuid', name: 'Todo', type: 'unstarted' },
        assigneeId: 'user-a',
        updatedAt: new Date().toISOString(),
        ...changes,
      },
    },
  }
}
function commentEvent() {
  return {
    type: 'Comment',
    payload: {
      action: 'create',
      data: {
        id: randomUUID(),
        body: 'Ping',
        issueId: 'issue-uuid',
        issue: { id: 'issue-uuid', title: 'Fix bug' },
        userId: 'user-b',
        url: 'https://linear.app/acme/issue/ENG-123#comment-1',
        createdAt: new Date().toISOString(),
      },
    },
  }
}
/** Squads the published fact was actually recorded for. */
async function publishedFor(event: { type: string; payload: unknown }) {
  const fact = linearOutputAdapter.normalize(event)[0]!
  eventKeys.push(fact.eventKey)
  const rows = await db
    .select({ authority: integrationOutputEvents.authority })
    .from(integrationOutputEvents)
    .where(and(eq(integrationOutputEvents.integration, 'linear'), eq(integrationOutputEvents.eventKey, fact.eventKey)))
  return rows.map((row) => (row.authority.kind === 'connection' ? row.authority.squadId : 'instance')).sort()
}

beforeAll(async () => {
  await store.initialize()
  squadA = await createSquadWithLinear(keyA)
  squadB = await createSquadWithLinear(keyB)
})
afterEach(async () => {
  if (eventKeys.length)
    await db
      .delete(integrationOutputEvents)
      .where(
        and(eq(integrationOutputEvents.integration, 'linear'), inArray(integrationOutputEvents.eventKey, eventKeys))
      )
  eventKeys.length = 0
})
afterAll(async () => {
  await db
    .delete(integrationConnectionAssignments)
    .where(inArray(integrationConnectionAssignments.connectionId, connectionIds))
  await db.delete(integrationConnections).where(inArray(integrationConnections.id, connectionIds))
  for (const ref of credentialRefs) await store.delete(ref)
  await db.delete(squads).where(inArray(squads.id, squadIds))
})

test('assignment publishes only for the squad whose connected account holds the assignment', async () => {
  const fallbacks: string[] = []
  const probed = stubLinear({ [keyA]: readable('user-a', 'user-a'), [keyB]: readable('user-b', 'user-a') })
  const event = issueEvent({ assigneeId: null })
  await routeLinearEvent(event, async (squadId) => void fallbacks.push(squadId))
  expect(probed.sort()).toEqual([keyA, keyB])
  expect(await publishedFor(event)).toEqual([squadA])
  // The legacy team-metadata path still runs for assignments no subscription claimed.
  expect(fallbacks).toEqual([squadA])
})

test('unassignment publishes for the squad that held the previous assignment', async () => {
  const fallbacks: string[] = []
  const event = issueEvent({ assigneeId: 'user-a' }, { assigneeId: null })
  stubLinear({ [keyA]: readable('user-a'), [keyB]: readable('user-b') })
  await routeLinearEvent(event, async (squadId) => void fallbacks.push(squadId))
  expect(await publishedFor(event)).toEqual([squadA])
  expect(fallbacks).toEqual([])
})

test('readable issues publish updates and comments to every connected squad', async () => {
  const fallbacks: string[] = []
  stubLinear({ [keyA]: readable('user-a', 'user-a'), [keyB]: readable('user-b', 'user-a') })
  const update = issueEvent({ stateId: 'previous-state' })
  await routeLinearEvent(update, async (squadId) => void fallbacks.push(squadId))
  expect(await publishedFor(update)).toEqual([squadA, squadB].sort())
  const comment = commentEvent()
  await routeLinearEvent(comment, async (squadId) => void fallbacks.push(squadId))
  expect(await publishedFor(comment)).toEqual([squadA, squadB].sort())
  // Only assignments fall back to the legacy team-metadata path.
  expect(fallbacks).toEqual([])
})

test('a squad whose account cannot read the issue receives nothing', async () => {
  stubLinear({ [keyA]: readable('user-a', 'user-a') })
  const update = issueEvent({ title: 'Old title' })
  await routeLinearEvent(update, async () => {})
  expect(await publishedFor(update)).toEqual([squadA])
  // A probe that answers for a different issue or team is not authority over this one.
  stubLinear({
    [keyA]: { viewer: { id: 'user-a' }, issue: { id: 'other-issue', team: { id: 'team-uuid' }, assignee: null } },
    [keyB]: { viewer: { id: 'user-b' }, issue: { id: 'issue-uuid', team: { id: 'other-team' }, assignee: null } },
  })
  const second = issueEvent({ title: 'Older title' }, { title: 'Renamed' })
  await routeLinearEvent(second, async () => {})
  expect(await publishedFor(second)).toEqual([])
})

test('events that normalize to nothing never probe a connection', async () => {
  const probed = stubLinear({ [keyA]: readable('user-a', 'user-a') })
  await routeLinearEvent({ type: 'Issue', payload: { action: 'create', data: { id: 'issue-uuid' } } }, async () => {})
  await routeLinearEvent({ type: 'Project', payload: { action: 'update', data: { id: 'project' } } }, async () => {})
  expect(probed).toEqual([])
})

test('readability decides publication, and assignment outputs additionally bind the account', () => {
  const access = readable('user-a', 'user-a')
  const event = { output: 'issue.assigned', issueId: 'issue-uuid', teamId: 'team-uuid', assignee: 'user-a' }
  expect(canReceiveLinearEvent(access, event)).toBe(true)
  expect(canReceiveLinearEvent({ ...access, viewer: { id: 'user-b' } }, event)).toBe(false)
  expect(canReceiveLinearEvent({ ...access, issue: null }, event)).toBe(false)
  expect(canReceiveLinearEvent(access, { ...event, issueId: 'other' })).toBe(false)
  expect(canReceiveLinearEvent(access, { ...event, teamId: 'other' })).toBe(false)
  expect(canReceiveLinearEvent(readable('user-a'), event)).toBe(false)
  // Unassignment binds the previous assignee; other outputs need only readability.
  const unassigned = { ...event, output: 'issue.unassigned' }
  expect(canReceiveLinearEvent(readable('user-a'), unassigned)).toBe(true)
  expect(canReceiveLinearEvent(readable('user-b'), unassigned)).toBe(false)
  expect(canReceiveLinearEvent(readable('user-b'), { ...event, output: 'issue.updated', assignee: 'user-a' })).toBe(
    true
  )
  expect(canReceiveLinearEvent(readable('user-b'), { ...event, output: 'issue.comment', assignee: '' })).toBe(true)
  // An unknown team on the fact does not relax the issue check.
  expect(canReceiveLinearEvent(readable('user-b'), { ...event, output: 'issue.updated', teamId: '' })).toBe(true)
})

describe('API-key rule audiences bind to the probed viewer', () => {
  /** Squad A's default Linear rules with its team routed; returns the notices its manager received. */
  async function routeWithDefaults(event: { type: string; payload: unknown }) {
    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: squadA }).returning()
    await db
      .update(squads)
      .set({ managerAgentId: manager!.id, metadata: { linear: [{ teamId: 'team-uuid' }] } })
      .where(eq(squads.id, squadA))
    try {
      await routeLinearEvent(event, async () => {})
      const fact = linearOutputAdapter.normalize(event)[0]!
      eventKeys.push(...linearOutputAdapter.normalize(event).map((item) => item.eventKey))
      const [recorded] = await db
        .select({ authority: integrationOutputEvents.authority })
        .from(integrationOutputEvents)
        .where(
          and(
            eq(integrationOutputEvents.eventKey, fact.eventKey),
            sql`${integrationOutputEvents.authority}->>'squadId' = ${squadA}`
          )
        )
      return {
        accountId: recorded?.authority.kind === 'connection' ? recorded.authority.accountId : undefined,
        notices: await db.select().from(inbox).where(eq(inbox.recipientId, manager!.id)),
      }
    } finally {
      await db.update(squads).set({ managerAgentId: null, metadata: {} }).where(eq(squads.id, squadA))
      await db.delete(inbox).where(eq(inbox.recipientId, manager!.id))
      await db.delete(agents).where(eq(agents.id, manager!.id))
    }
  }

  test('a comment on an issue the viewer is not assigned or delegated does not notify the manager', async () => {
    stubLinear({ [keyA]: readable('user-a', 'someone-else') })
    const { accountId, notices } = await routeWithDefaults(commentEvent())
    expect(accountId).toBe('user-a')
    expect(notices).toEqual([])
  })

  test('a comment on an issue assigned to the viewer notifies the manager', async () => {
    stubLinear({ [keyA]: readable('user-a', 'user-a') })
    const { notices } = await routeWithDefaults(commentEvent())
    expect(notices).toHaveLength(1)
  })

  test('the viewer’s own comment is suppressed as a self-comment', async () => {
    stubLinear({ [keyA]: readable('user-a', 'user-a') })
    const own = commentEvent()
    ;(own.payload.data as Record<string, unknown>).userId = 'user-a'
    const { notices } = await routeWithDefaults(own)
    expect(notices).toEqual([])
  })

  test('a delegation to another agent does not match the connected-account delegation rule', async () => {
    stubLinear({ [keyA]: readable('user-a', 'user-a') })
    const delegated = issueEvent({ delegateId: null }, { delegateId: 'other-agent' })
    const { notices } = await routeWithDefaults(delegated)
    expect(notices).toEqual([])
  })
})
