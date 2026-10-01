import { afterEach, expect, spyOn, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createBlankWorkflow, effectiveSquadEventRules, resolveTrackedResources } from '@ficus/shared'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import {
  db,
  squads,
  agents,
  agentTypes,
  inbox,
  workStreams,
  workStreamFlowRuns,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  integrationAuditEvents,
  integrationConnections,
} from '../../../db'
import { Agent } from '../../../entities/Agent'
import * as api from '../../github/api-client'
import { publishGitHubWebhookOutputs } from './ingress'
import { publishIntegrationOutputs } from '../outputs/runtime'
import { reportDependabotUnavailable } from './dependabot-status'
import { resolveEventTrackedResource } from '../../work-streams/tracked-resources'
useEnabledIntegrationFixtures('github')

const owned: string[] = []
const connections: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
const prefix = `dependabot-${crypto.randomUUID()}`
const repo = `${prefix}/private`
const repository = { id: 101, full_name: repo }
const alert = {
  number: 7,
  state: 'open',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  dependency: { package: { name: 'widget', ecosystem: 'npm' }, manifest_path: 'bun.lock' },
  security_advisory: { ghsa_id: 'GHSA-abcd-efgh-ijkl', severity: 'high' },
  security_vulnerability: {
    severity: 'high',
    vulnerable_version_range: '<2',
    first_patched_version: { identifier: '2' },
  },
}
const event = (action = 'created', overrides = {}) => ({
  type: 'dependabot_alert',
  payload: { repository, action, alert: { ...alert, ...overrides } },
})
async function fixture(metadata: unknown = { github: [{ repo }] }) {
  await db
    .insert(agentTypes)
    .values({ id: prefix, name: prefix, model: 'anthropic:claude-sonnet-4-5', systemPrompt: 'Test manager' })
    .onConflictDoNothing()
  const [squad] = await db
    .insert(squads)
    .values({ name: prefix, purpose: 'Dependabot discovery test', metadata })
    .returning()
  owned.push(squad!.id)
  const [manager] = await db
    .insert(agents)
    .values({ squadId: squad!.id, agentTypeId: prefix, status: 'idle' })
    .returning()
  await db.update(squads).set({ managerAgentId: manager!.id }).where(eq(squads.id, squad!.id))
  const connection = await createTestGitHubConnection({ squadId: squad!.id })
  connections.push(connection)
  return { squadId: squad!.id, managerId: manager!.id, connectionId: connection.id }
}
afterEach(async () => {
  const recipients = await db.select({ id: agents.id }).from(agents).where(inArray(agents.squadId, owned))
  if (recipients.length)
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        recipients.map((r) => r.id)
      )
    )
  await db.delete(workStreams).where(inArray(workStreams.squadId, owned))
  await db.update(squads).set({ managerAgentId: null }).where(inArray(squads.id, owned))
  await db.delete(agents).where(inArray(agents.squadId, owned))
  for (const connection of connections.splice(0)) {
    await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.connectionId, connection.id))
    await db
      .delete(integrationOutputEvents)
      .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${connection.id}`)
    await connection.dispose()
  }
  await db.delete(squads).where(inArray(squads.id, owned.splice(0)))
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
})

test('webhook and API overlap notify one manager; inaccessible alerts and unrelated squads receive no vulnerability details', async () => {
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const one = await fixture()
  const unrelated = await fixture({ github: [{ repo: 'elsewhere/private' }] })
  let securityAllowed = true
  const read = spyOn(api, 'githubApiGet').mockImplementation(
    async <T>(path: string): Promise<T | null> =>
      (path.includes('/dependabot/alerts/') ? (securityAllowed ? { number: 7 } : null) : repository) as T | null
  )
  try {
    await publishGitHubWebhookOutputs(event())
    const authority = { kind: 'connection' as const, squadId: one.squadId, connectionId: one.connectionId }
    await publishIntegrationOutputs('github', { ...event('observed'), metadata: { synthetic: true } }, authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('--from-event')
    expect(messages[0]!.content).toContain('Dependabot alert')
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, unrelated.managerId))).toHaveLength(0)
    const [stored] = await db
      .select()
      .from(integrationOutputEvents)
      .where(
        and(
          eq(integrationOutputEvents.integration, 'github'),
          sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`,
          eq(
            integrationOutputEvents.eventKey,
            (await import('../outputs/github')).githubOutputAdapter.normalize(event())[0]!.eventKey
          )
        )
      )
    expect((await resolveEventTrackedResource(stored!.id, one.squadId)).externalId).toBe('101:7')
    await expect(resolveEventTrackedResource(stored!.id, unrelated.squadId)).rejects.toThrow('not accessible')
    securityAllowed = false
    await publishGitHubWebhookOutputs(event('reopened', { updated_at: '2026-09-02T00:00:00Z' }))
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))
    expect(notices).toHaveLength(2)
    expect(notices[1]!.subject).toBe('Dependabot discovery unavailable')
    await reportDependabotUnavailable(one.squadId, one.connectionId)
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(2)
  } finally {
    read.mockRestore()
    send.mockRestore()
  }
})

test('configured workflows create one paused tracked alert stream across replay, rename and reopen; fixed alerts never create work', async () => {
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const rules = effectiveSquadEventRules({ github: [{ repo }] }, 'github').filter(
    (r) => r.source.output === 'dependabot_alert.updated'
  )
  rules[0]!.action = {
    type: 'start-workstream',
    workflow: {
      kind: 'inline',
      definition: {
        ...createBlankWorkflow(),
        participants: { worker: { agentTypeId: prefix, session: 'reuse-within-stream' } },
      },
    },
  }
  const one = await fixture({ github: [{ repo: '*' }], integrationRules: { github: rules } })
  const authority = { kind: 'connection' as const, squadId: one.squadId, connectionId: one.connectionId }
  try {
    await Promise.all([
      publishIntegrationOutputs('github', event(), authority),
      publishIntegrationOutputs('github', event(), authority),
    ])
    const renamed = event('reopened', { updated_at: '2026-09-02T00:00:00Z' })
    renamed.payload.repository = { ...repository, full_name: `${prefix}/renamed` }
    await publishIntegrationOutputs('github', renamed, authority)
    await publishIntegrationOutputs(
      'github',
      event('fixed', { state: 'fixed', number: 8, updated_at: '2026-09-03T00:00:00Z' }),
      authority
    )
    const streams = await db.select().from(workStreams).where(eq(workStreams.squadId, one.squadId))
    expect(streams).toHaveLength(1)
    expect(streams[0]!.status).toBe('queued')
    expect(streams[0]!.pause).toBeTruthy()
    expect(resolveTrackedResources(streams[0]!.metadata)[0]).toMatchObject({
      kind: 'dependabot_alert',
      externalId: '101:7',
      delivery: false,
    })
    expect((streams[0]!.metadata as any).github).toBeUndefined()
    expect(
      await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streams[0]!.id))
    ).toHaveLength(1)
    expect(
      await db.select().from(integrationOutputTriggerRuns).where(eq(integrationOutputTriggerRuns.squadId, one.squadId))
    ).toHaveLength(1)
  } finally {
    send.mockRestore()
  }
})

test('managed relay rejects unrelated squad interests and rechecks Dependabot resource permission', async () => {
  const { dispatchHostedGitHubDelivery } = await import('../relay/runtime')
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const one = await fixture({ github: [{ repo }], integrationRules: { github: [] } })
  const connection = (
    await db.select().from(integrationConnections).where(eq(integrationConnections.id, one.connectionId))
  )[0]!
  const read = spyOn(api, 'githubApiGet').mockResolvedValue(null)
  try {
    await dispatchHostedGitHubDelivery(
      {
        id: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        connectionId: one.connectionId,
        connectionRevision: connection.materialRevision,
        resourceId: '101',
        resourceKey: repo,
        eventType: 'dependabot_alert',
        payload: event().payload,
      },
      [{ squadId: one.squadId, connectionId: one.connectionId, repository: repo }]
    )
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(0)
    await db
      .update(squads)
      .set({ metadata: { github: [{ repo }] } })
      .where(eq(squads.id, one.squadId))
    const delivery = {
      id: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      connectionId: one.connectionId,
      connectionRevision: connection.materialRevision,
      resourceId: '101',
      resourceKey: repo,
      eventType: 'dependabot_alert',
      payload: event().payload,
    }
    read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path.includes('/dependabot/alerts/') ? null : repository) as T | null
    )
    await dispatchHostedGitHubDelivery(delivery, [
      { squadId: one.squadId, connectionId: one.connectionId, repository: repo },
    ])
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(0)
    read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path.includes('/dependabot/alerts/') ? { number: 7 } : repository) as T | null
    )
    await dispatchHostedGitHubDelivery(delivery, [
      { squadId: one.squadId, connectionId: one.connectionId, repository: repo },
    ])
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(1)
  } finally {
    read.mockRestore()
    send.mockRestore()
  }
})
