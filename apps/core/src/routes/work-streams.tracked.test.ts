import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github', 'linear')
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  createBlankWorkflow,
  squadEventRuleSchema,
  trackedResourceKey,
  type IntegrationOutputFact,
} from '@ficus/shared'
import { workStreamsRouter } from './work-streams'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import {
  workStreams,
  squads,
  agents,
  agentTypes,
  inbox,
  integrationOutputDeliveries,
  integrationOutputEvents,
  integrationConnections,
  integrationConnectionAssignments,
  settings,
} from '../db/schema'
import { AgentType } from '../entities/AgentType'

import { Squad } from '../entities/Squad'
import { WorkStream } from '../entities/WorkStream'
import { createTestGitHubConnection } from '../test-utils/github-connection'
import * as repositorySetup from '../services/work-streams/repository-setup'
import { INTEGRATION_DEFAULT_PREFIX } from '../services/integrations/scope-settings'
import { publishIntegrationOutput } from '../services/integrations/outputs/runtime'
import type { IntegrationOutputAuthority } from '../services/integrations/outputs/types'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)

const wsPrefix = `ws-tracked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const eventIds: string[] = []
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: wsPrefix })
})
afterAll(async () => {
  await cleanupTestRbac(wsPrefix)
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

describe('work-stream tracked-resource routes', () => {
  let testPrefix: string
  let testSquadId: string
  let testAgentTypeId: string
  let repo: string
  let connection: Awaited<ReturnType<typeof createTestGitHubConnection>>

  async function apiFetch(url: string, init?: { method?: string; body?: unknown; token?: string }): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        headers: { ...authHeaders(init?.token ?? admin.token), 'Content-Type': 'application/json' },
      })
    )
  }

  function issueFact(number: number, repository = repo): IntegrationOutputFact {
    return {
      output: 'issue.assigned',
      version: 1,
      eventKey: randomUUID(),
      resourceKey: `${repository}#${number}`,
      occurredAt: new Date().toISOString(),
      data: { repository, issue: { number }, assignee: 'tau-bot' },
      subject: `Issue ${repository}#${number}`,
      body: 'Please take a look.',
    }
  }
  async function insertEvent(fact: IntegrationOutputFact, authority: IntegrationOutputAuthority) {
    const [row] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: `github:${testPrefix}`,
        eventKey: fact.eventKey,
        authority,
        fact,
      })
      .returning()
    eventIds.push(row!.id)
    return row!
  }

  beforeEach(async () => {
    testPrefix = `rt-tracked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    repo = `${testPrefix}/repo`
    await AgentType.upsert({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'Test prompt',
    })
    const squad = await Squad.create({ name: `${testPrefix} Tracked Squad`, purpose: 'Testing tracked links' })
    testSquadId = squad.id
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = testAgentTypeId
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    connection = await createTestGitHubConnection({ squadId: testSquadId })
  })

  afterEach(async () => {
    const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, testSquadId))
    if (owned.length)
      await db.delete(inbox).where(
        inArray(
          inbox.recipientId,
          owned.map((row) => row.id)
        )
      )
    await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, testSquadId))
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquadId))
    await connection.dispose()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('creates one work stream from an integration event and reuses it for the same event', async () => {
    const event = await insertEvent(issueFact(4101), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const created = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} from event`, integrationEventId: event.id },
    })
    expect(created.status).toBe(201)
    const stream = (await created.json()) as { id: string; metadata: Record<string, any> }
    expect(stream.metadata.tracked).toHaveLength(1)
    expect(stream.metadata.tracked[0]).toMatchObject({
      integration: 'github',
      repository: repo,
      kind: 'issue',
      number: 4101,
      origin: { eventId: event.id, output: 'issue.assigned' },
    })

    const again = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} from event again`, integrationEventId: event.id },
    })
    expect(again.status).toBe(200)
    const reused = (await again.json()) as { id: string; reusedFromEvent: boolean }
    expect(reused).toMatchObject({ id: stream.id, reusedFromEvent: true })
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(1)
  })

  /** A Linear connection the squad may use, with a credential the describe step can read. */
  async function createLinearConnection() {
    const { getSecretStore } = await import('../services/secrets')
    const store = getSecretStore()
    await store.initialize()
    const id = randomUUID()
    const revision = randomUUID()
    const credentialRef = `__integration-test:linear:${id}`
    await store.set(credentialRef, 'lin_api_fixture', 'test')
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
    })
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId: testSquadId, providerKey: 'linear', connectionId: id, isDefault: true })
    return {
      id,
      dispose: async () => {
        await db.delete(integrationConnectionAssignments).where(eq(integrationConnectionAssignments.connectionId, id))
        await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
        await store.delete(credentialRef)
      },
    }
  }

  it('creates a work stream from a Linear comment event, resolving the issue at link time', async () => {
    const linear = await createLinearConnection()
    const issueId = randomUUID()
    const [row] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'linear',
        sourceKey: `linear:${testPrefix}`,
        eventKey: randomUUID(),
        authority: { kind: 'connection', connectionId: linear.id, squadId: testSquadId },
        // A comment delivery names its issue by UUID only: no team key, no number.
        fact: {
          output: 'issue.comment',
          version: 1,
          eventKey: randomUUID(),
          resourceKey: issueId,
          occurredAt: new Date().toISOString(),
          data: { issue: { id: issueId }, teamId: 'team-uuid', actor: 'user-a', action: 'create' },
          subject: 'Linear comment',
          body: 'Could you take another look?',
        },
      })
      .returning()
    eventIds.push(row!.id)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({
        data: { issue: { id: issueId, url: 'https://linear.app/acme/issue/ENG-77', number: 77, team: { key: 'ENG' } } },
      })) as unknown as typeof fetch
    try {
      const created = await apiFetch('/api/workstreams', {
        method: 'POST',
        body: { squadId: testSquadId, title: `${testPrefix} from comment`, integrationEventId: row!.id },
      })
      expect(created.status).toBe(201)
      const stream = (await created.json()) as { metadata: Record<string, any> }
      expect(stream.metadata.tracked).toHaveLength(1)
      expect(stream.metadata.tracked[0]).toMatchObject({
        integration: 'linear',
        repository: 'eng',
        kind: 'issue',
        number: 77,
        externalId: issueId,
        url: 'https://linear.app/acme/issue/ENG-77',
        connectionId: linear.id,
        origin: { eventId: row!.id, output: 'issue.comment' },
      })
    } finally {
      globalThis.fetch = originalFetch
      await linear.dispose()
    }
  })

  it('refuses to create from an event another squad observed', async () => {
    const other = await Squad.create({ name: `${testPrefix} Other Squad`, purpose: 'Other' })
    const event = await insertEvent(issueFact(4102), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: other.id,
    })
    const response = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} foreign event`, integrationEventId: event.id },
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBeString()
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(0)
  })

  it('lists, adds and removes tracked links for readers and updaters', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} links`, metadata: {} })
      .returning()
    const id = row!.id

    const empty = await apiFetch(`/api/workstreams/${id}/tracked`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ resources: [], subscriptions: 'no-flow' })

    const added = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(added.status).toBe(200)
    const addedBody = (await added.json()) as { added: Array<{ number: number }>; resources: unknown[] }
    expect(addedBody.added).toHaveLength(1)
    expect(addedBody.added[0]!.number).toBe(4201)
    expect(addedBody.resources).toHaveLength(1)

    const again = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(again.status).toBe(200)
    expect((await again.json()).added).toEqual([])

    const listed = await apiFetch(`/api/workstreams/${id}/tracked`)
    expect((await listed.json()).resources).toHaveLength(1)

    const removed = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'DELETE',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ removed: true, resources: [] })
  })

  it('adds and removes a tracked link written as a reference', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} reference`, metadata: {} })
      .returning()
    const id = row!.id
    const added = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { reference: `${repo}#4401`, kind: 'pull_request' },
    })
    expect(added.status).toBe(200)
    expect((await added.json()).added).toMatchObject([{ repository: repo, kind: 'pull_request', number: 4401 }])
    // An issue is the default when the caller names no kind, so this is a second link.
    const issue = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { reference: `${repo}#4401` },
    })
    expect((await issue.json()).added).toMatchObject([{ kind: 'issue', number: 4401 }])
    const malformed = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { reference: 'nonsense reference' },
    })
    expect(malformed.status).toBe(400)
    const removed = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'DELETE',
      body: { reference: `${repo}#4401`, kind: 'pull_request' },
    })
    expect(removed.status).toBe(200)
    expect((await removed.json()).resources).toMatchObject([{ kind: 'issue', number: 4401 }])
    const unknown = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'DELETE',
      body: { reference: 'not a reference' },
    })
    expect(unknown.status).toBe(400)
  })

  it('refuses a Linear pull request, a resource that provider does not have', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} linear-pr`, metadata: {} })
      .returning()
    const reference = await apiFetch(`/api/workstreams/${row!.id}/tracked`, {
      method: 'POST',
      body: { reference: 'ENG-12', kind: 'pull_request' },
    })
    expect(reference.status).toBe(400)
    expect((await reference.json()).error).toContain('linear')
    const flagged = await apiFetch(`/api/workstreams/${row!.id}/tracked`, {
      method: 'POST',
      body: {
        resource: { integration: 'linear', repository: 'eng', kind: 'pull_request', number: 12 },
        delivery: true,
      },
    })
    expect(flagged.status).toBe(400)
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
  })

  it('refuses to untrack the designated delivery change request', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({
        squadId: testSquadId,
        title: `${testPrefix} delivery`,
        metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 4301 } } },
      })
      .returning()
    const response = await apiFetch(`/api/workstreams/${row!.id}/tracked`, {
      method: 'DELETE',
      body: { url: `https://github.com/${repo}/pull/4301` },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'delivery_change_request' })
  })

  it('requires workstreams:update to change tracked links', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} rbac`, metadata: {} })
      .returning()
    const reader = await createTestUser({ prefix: wsPrefix })
    const role = await createTestRole({ prefix: wsPrefix, permissions: ['workstreams:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: testSquadId })
    const url = `https://github.com/${repo}/issues/4401`
    expect((await apiFetch(`/api/workstreams/${row!.id}/tracked`, { token: reader.token })).status).toBe(200)
    expect(
      (await apiFetch(`/api/workstreams/${row!.id}/tracked`, { method: 'POST', body: { url }, token: reader.token }))
        .status
    ).toBe(403)
    expect(
      (await apiFetch(`/api/workstreams/${row!.id}/tracked`, { method: 'DELETE', body: { url }, token: reader.token }))
        .status
    ).toBe(403)
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
  })

  it('rejects invalid tracked metadata written through PATCH', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} patch`, metadata: {} })
      .returning()
    const response = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ bad: true }] } },
    })
    expect(response.status).toBe(400)
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
    const accepted = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ integration: 'github', repository: repo, kind: 'issue', number: 4501 }] } },
    })
    expect(accepted.status).toBe(200)
    expect((await WorkStream.mustFind(row!.id)).metadata).toMatchObject({ tracked: [{ number: 4501 }] })
  })

  it('rejects a PATCH that claims a server-managed origin', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} origin`, metadata: {} })
      .returning()
    const response = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: {
        metadata: {
          tracked: [
            {
              integration: 'github',
              repository: repo,
              kind: 'issue',
              number: 4601,
              origin: { eventId: randomUUID(), resourceKey: `${repo}#4601`, output: 'issue.assigned' },
            },
          ],
        },
      },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('origin is server-managed')
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
  })

  it('authorizes tracked links outside the work-stream transaction', async () => {
    // A configured global default makes the provider lookup open its own squad-locking
    // transaction; authorizing under the update lock would wait on it forever.
    await db
      .insert(settings)
      .values({ key: `${INTEGRATION_DEFAULT_PREFIX}github`, value: connection.id, updatedBy: 'test-fixture' })
      .onConflictDoUpdate({ target: settings.key, set: { value: connection.id } })
    try {
      const [row] = await db
        .insert(workStreams)
        .values({ squadId: testSquadId, title: `${testPrefix} default`, metadata: {} })
        .returning()
      const response = await apiFetch(`/api/workstreams/${row!.id}`, {
        method: 'PATCH',
        body: { metadata: { tracked: [{ integration: 'github', repository: repo, kind: 'issue', number: 4701 }] } },
      })
      expect(response.status).toBe(200)
      expect((await WorkStream.mustFind(row!.id)).metadata).toMatchObject({ tracked: [{ number: 4701 }] })
    } finally {
      await db.delete(settings).where(eq(settings.key, `${INTEGRATION_DEFAULT_PREFIX}github`))
    }
  })

  it('keeps a stored origin exactly as the server recorded it across a PATCH', async () => {
    const event = await insertEvent(issueFact(4901), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const created = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} stored origin`, integrationEventId: event.id },
    })
    expect(created.status).toBe(201)
    const stream = (await created.json()) as { id: string; metadata: Record<string, any> }
    const stored = stream.metadata.tracked[0]
    expect(stored.origin.eventId).toBe(event.id)

    // Resubmitting the entry exactly as stored keeps it.
    const unchanged = await apiFetch(`/api/workstreams/${stream.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [stored] } },
    })
    expect(unchanged.status).toBe(200)
    expect((await WorkStream.mustFind(stream.id)).metadata).toMatchObject({
      tracked: [{ number: 4901, origin: { eventId: event.id } }],
    })

    // Repointing the origin of that same identity is a forgery, not an update.
    const repointed = await apiFetch(`/api/workstreams/${stream.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ ...stored, origin: { ...stored.origin, eventId: randomUUID() } }] } },
    })
    expect(repointed.status).toBe(400)
    expect((await repointed.json()).error).toContain('origin is server-managed')
    expect((await WorkStream.mustFind(stream.id)).metadata).toMatchObject({
      tracked: [{ origin: { eventId: event.id } }],
    })
  })

  it('refuses a PATCH that stamps an origin onto an existing link or the delivery pull request', async () => {
    const existing = { integration: 'github', repository: repo, kind: 'issue', number: 4903 }
    const [row] = await db
      .insert(workStreams)
      .values({
        squadId: testSquadId,
        title: `${testPrefix} forged origin`,
        metadata: {
          codeHost: { integration: 'github', repository: repo, changeRequest: { number: 4902 } },
          tracked: [existing],
        },
      })
      .returning()
    const origin = { eventId: randomUUID(), resourceKey: `${repo}#4903`, output: 'issue.assigned' }

    const onExisting = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ ...existing, origin }] } },
    })
    expect(onExisting.status).toBe(400)
    expect((await onExisting.json()).error).toContain('origin is server-managed')

    // The delivery PR identity only lives in `codeHost`, so it has no stored origin to keep.
    const onDelivery = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: {
        metadata: {
          tracked: [
            {
              integration: 'github',
              repository: repo,
              kind: 'pull_request',
              number: 4902,
              origin: { ...origin, resourceKey: `${repo}#4902` },
            },
          ],
        },
      },
    })
    expect(onDelivery.status).toBe(400)
    expect((await onDelivery.json()).error).toContain('origin is server-managed')
    expect((await WorkStream.mustFind(row!.id)).metadata).toMatchObject({ tracked: [existing] })
  })

  it('stays idempotent when the create body echoes the event identity without its origin', async () => {
    const event = await insertEvent(issueFact(4910), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const body = {
      squadId: testSquadId,
      title: `${testPrefix} echoed identity`,
      integrationEventId: event.id,
      metadata: { tracked: [{ integration: 'github', repository: repo, kind: 'issue', number: 4910 }] },
    }
    const created = await apiFetch('/api/workstreams', { method: 'POST', body })
    expect(created.status).toBe(201)
    const stream = (await created.json()) as { id: string; metadata: Record<string, any> }
    // The server-resolved entry wins over the client's origin-less copy of the same identity.
    expect(stream.metadata.tracked).toHaveLength(1)
    expect(stream.metadata.tracked[0]).toMatchObject({ number: 4910, origin: { eventId: event.id } })

    const again = await apiFetch('/api/workstreams', { method: 'POST', body })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ id: stream.id, reusedFromEvent: true })
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(1)
  })

  it('creates exactly one stream when the same event is submitted concurrently', async () => {
    const event = await insertEvent(issueFact(4920), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const body = { squadId: testSquadId, title: `${testPrefix} concurrent`, integrationEventId: event.id }
    const responses = await Promise.all([
      apiFetch('/api/workstreams', { method: 'POST', body }),
      apiFetch('/api/workstreams', { method: 'POST', body }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(1)
  })

  it('delivers a later issue closure to the stream created from the event, not to the manager', async () => {
    const [manager] = await db.insert(agents).values({ squadId: testSquadId, agentTypeId: testAgentTypeId }).returning()
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = testAgentTypeId
    definition.completion.followChanges = true
    // A squad rule that would otherwise page the manager for every issue update.
    const rule = squadEventRuleSchema.parse({
      id: 'issue-updates',
      source: { integration: 'github', output: 'issue.updated', version: 1 },
      filters: { audience: 'any' },
      action: { type: 'notify-manager' },
    })
    await db
      .update(squads)
      .set({
        managerAgentId: manager!.id,
        metadata: {
          workflow: { kind: 'inline', definition },
          integrationRules: { github: [rule] },
        },
      })
      .where(eq(squads.id, testSquadId))

    const assigned = await insertEvent(issueFact(4930), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const created = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: {
        squadId: testSquadId,
        title: `${testPrefix} follow issue`,
        integrationEventId: assigned.id,
        workflow: { kind: 'inline', definition },
      },
    })
    expect(created.status).toBe(201)
    const stream = (await created.json()) as { id: string; metadata: Record<string, any> }
    // The stored entry is pinned to the observing connection, so the later event must carry it too.
    expect(stream.metadata.tracked[0]).toMatchObject({ number: 4930, connectionId: connection.id })

    const managerBefore = await db.select().from(inbox).where(eq(inbox.recipientId, manager!.id))
    const closed = await publishIntegrationOutput(
      'github',
      {
        ...issueFact(4930),
        output: 'issue.updated',
        subject: `Issue ${repo}#4930 closed`,
        data: { repository: repo, issue: { number: 4930 }, action: 'closed', state: 'closed' },
      },
      { kind: 'connection', connectionId: connection.id, squadId: testSquadId }
    )
    eventIds.push(closed)

    const hash = createHash('sha256')
      .update(trackedResourceKey({ integration: 'github', repository: repo, kind: 'issue', number: 4930 }))
      .digest('hex')
      .slice(0, 12)
    const rows = await db
      .select()
      .from(integrationOutputDeliveries)
      .where(eq(integrationOutputDeliveries.workStreamId, stream.id))
    expect(rows.map((row) => row.subscriptionId)).toContain(`tracked-${hash}-updated`)
    expect(rows.find((row) => row.subscriptionId === `tracked-${hash}-updated`)!.eventId).toBe(closed)
    // The tracked stream owns the closure, so the notify-manager rule stays silent.
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, manager!.id))).toHaveLength(managerBefore.length)
  })

  it('settles an event replay before provisioning a repository', async () => {
    const event = await insertEvent(issueFact(4801), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockImplementation(
      async (_squadId, _input, _key, metadata) => metadata
    )
    try {
      const body = {
        squadId: testSquadId,
        title: `${testPrefix} replay`,
        integrationEventId: event.id,
        repository: 'demo',
      }
      const created = await apiFetch('/api/workstreams', { method: 'POST', body })
      expect(created.status).toBe(201)
      expect(setup).toHaveBeenCalledTimes(1)
      const again = await apiFetch('/api/workstreams', { method: 'POST', body })
      expect(again.status).toBe(200)
      expect((await again.json()).reusedFromEvent).toBe(true)
      // The replay is settled before any worktree is provisioned.
      expect(setup).toHaveBeenCalledTimes(1)
    } finally {
      setup.mockRestore()
    }
  })

  it('designates a tracked pull request for delivery and refuses the flag on issues', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({
        squadId: testSquadId,
        title: `${testPrefix} delivery flag`,
        metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 4950 } } },
      })
      .returning()
    const id = row!.id
    const url = `https://github.com/${repo}/pull/4951`

    const listed = await apiFetch(`/api/workstreams/${id}/tracked`)
    expect(await listed.json()).toMatchObject({
      delivery: { pullRequests: [{ number: 4950, primary: true, state: 'open' }], complete: false },
    })

    const added = await apiFetch(`/api/workstreams/${id}/tracked`, { method: 'POST', body: { url } })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({
      changed: true,
      delivery: { pullRequests: [{ number: 4950 }] },
    })

    const flagged = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url, delivery: true },
    })
    expect(flagged.status).toBe(200)
    const body = (await flagged.json()) as {
      added: unknown[]
      changed: boolean
      resources: Array<{ number: number; delivery: boolean }>
      delivery: { pullRequests: Array<{ number: number; primary: boolean }>; complete: boolean }
    }
    expect(body.added).toEqual([])
    expect(body.changed).toBe(true)
    expect(body.resources.map((resource) => [resource.number, resource.delivery])).toEqual([
      [4950, true],
      [4951, true],
    ])
    expect(body.delivery.pullRequests.map((item) => [item.number, item.primary])).toEqual([
      [4950, true],
      [4951, false],
    ])
    expect((await WorkStream.mustFind(id)).metadata).toMatchObject({ tracked: [{ number: 4951, delivery: true }] })

    const issue = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url: `https://github.com/${repo}/issues/4952`, delivery: true },
    })
    expect(issue.status).toBe(400)
    expect((await issue.json()).error).toBeString()
    expect((await WorkStream.mustFind(id)).metadata).toMatchObject({ tracked: [{ number: 4951 }] })
  })
})
