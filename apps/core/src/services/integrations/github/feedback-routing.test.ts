import { expect, spyOn, test, setSystemTime } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
import {
  db,
  squads,
  agents,
  agentTypes,
  users,
  roles,
  roleAssignments,
  workStreams,
  workStreamFlowRuns,
  inbox,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationOutputTriggerRuns,
  githubFeedbackRevisions,
  githubTrustedAuthors,
  githubOutputProofs,
  setDatabaseQueryObserverForTest,
  chatSendReceipts,
  integrationConnections,
  integrationConnectionAssignments,
  integrationAuditEvents,
} from '../../../db'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { InboxMessage } from '../../../entities/InboxMessage'
import { Agent, setSendMessageLockedHookForTests } from '../../../entities/Agent'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import * as api from '../../github/api-client'
import { githubOutputAdapter } from '../outputs/github'
import {
  publishIntegrationOutput,
  reconcileUnmatchedOutputs,
  reconcileOutputDeliveries,
  outputDeliveryHistory,
  isCurrentIntegrationNotification,
  isCurrentIntegrationDelivery,
} from '../outputs/runtime'
import * as renewal from './feedback-renewal'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import { githubContentHash } from './feedback-envelope'
import { deliverInboxMessagesToAgent } from '../../inbox/inboxDelivery'
import { hasAcceptedGitHubFeedbackReceipts } from './feedback-release'
import { dispatchFlow, attachFlow } from '../../workflows/execution'
import { recordIntegrationOutput } from '../outputs/runtime'
import { setGitHubAuthorFilter } from './author-filter-setting'
import { Squad } from '../../../entities/Squad'
useEnabledIntegrationFixtures('github')

async function fixture(action: 'notify-manager' | 'notify-consultant' | 'start-workstream' = 'notify-manager') {
  const squadId = crypto.randomUUID(),
    typeId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    moderatorRole = crypto.randomUUID()
  await db.insert(users).values({ id: userId, email: `${userId}@routing.test` })
  await db
    .insert(agentTypes)
    .values({ id: typeId, name: typeId, model: 'anthropic:claude-sonnet-4-5', systemPrompt: 'Test' })
  const workflow = createBlankWorkflow()
  workflow.participants.worker!.agentTypeId = typeId
  await db.insert(squads).values({
    id: squadId,
    name: 'Routing',
    purpose: 'Test',
    metadata: {
      integrationRules: {
        github: [
          {
            id: 'rule',
            enabled: true,
            source: { integration: 'github', output: 'pull_request.comment', version: 1 },
            filters: { audience: 'any' },
            predicates: [],
            action: {
              type: action,
              ...(action === 'start-workstream' ? { workflow: { kind: 'inline', definition: workflow } } : {}),
            },
          },
        ],
      },
    },
  })
  const [manager] = await db
    .insert(agents)
    .values({ squadId, agentTypeId: typeId, name: 'Manager', status: 'idle' })
    .returning()
  await db.update(squads).set({ managerAgentId: manager!.id }).where(eq(squads.id, squadId))
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      providerKey: 'github',
      adapterVersion: 1,
      displayName: 'Test',
      configuration: {},
      credentialRef: `fixture:${squadId}`,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      materialRevision: revision,
      validatedRevision: revision,
      validationExpiresAt: new Date(Date.now() + 600_000),
    })
    .returning()
  await db
    .insert(integrationConnectionAssignments)
    .values({ squadId, providerKey: 'github', connectionId: connection!.id })
  const authority = { kind: 'connection' as const, squadId, connectionId: connection!.id, connectionRevision: revision }
  const native = {
    id: 30,
    user: { id: 2, login: 'author', type: 'User' },
    body: 'HELD_SENTINEL',
    html_url: 'https://github.com/acme/project/pull/3#issuecomment-30',
    created_at: '2026-10-02T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
  }
  const fact = () =>
    githubOutputAdapter.normalize({
      type: 'issue_comment',
      githubObservation: { kind: 'webhook' },
      payload: {
        action: 'created',
        repository: { id: 10, full_name: 'acme/project' },
        issue: { id: 20, number: 3, title: 'UNREVIEWED_PARENT', body: 'PARENT_BODY', pull_request: {} },
        comment: native,
      },
    })[0]!
  const read = spyOn(api, 'githubApiGet').mockImplementation(
    async <T>(path: string): Promise<T | null> =>
      (path === '/repositories/10'
        ? { id: 10, full_name: 'acme/project' }
        : path === '/repos/acme/project/issues/comments/30'
          ? native
          : null) as T | null
  )
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  return {
    squadId,
    userId,
    managerId: manager!.id,
    authority,
    native,
    fact,
    read,
    useRealSend() {
      send.mockRestore()
    },
    async trust(accountType: 'User' | 'Bot' = 'User') {
      await db
        .insert(githubTrustedAuthors)
        .values({ squadId, accountId: '2', login: 'author', accountType, addedByUserId: userId })
    },
    async allow(revisionId: string) {
      await db
        .insert(roles)
        .values({ id: moderatorRole, slug: moderatorRole, name: moderatorRole, permissions: ['squads:update'] })
      await db
        .insert(roleAssignments)
        .values({ subjectType: 'user', subjectId: userId, roleId: moderatorRole, scope: 'squad', squadId })
      const [row] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, revisionId))
      const { moderateGitHubFeedback } = await import('./feedback-moderation')
      await moderateGitHubFeedback({ type: 'user', userId }, squadId, {
        requestId: crypto.randomUUID(),
        action: 'allow_once',
        selections: [{ revisionId, contentHash: row!.contentHash, decisionVersion: row!.decisionVersion }],
      })
    },
    async stream(flow = false, output = 'pull_request.comment', branch = false) {
      const [stream] = await db
        .insert(workStreams)
        .values({
          squadId,
          title: 'Test',
          status: 'active',
          assigneeAgentId: manager!.id,
          metadata: branch
            ? {
                codeHost: { integration: 'github', repository: 'acme/project' },
                git: { branch: 'feature', baseBranch: 'main' },
              }
            : { github: { repo: 'acme/project', pr: { number: 3 } } },
        })
        .returning()
      if (flow) {
        const definition = createBlankWorkflow()
        if (branch) definition.completion.mode = 'pr-merge'
        definition.subscriptions = [
          {
            id: 'feedback',
            source: { integration: 'github', output, version: 1 },
            match: { repository: { value: 'acme/project' }, 'pullRequest.number': { value: 3 } },
            deliver: { to: 'active', whenInactive: 'retain' },
          },
        ]
        if (branch)
          for (const output of ['pull_request.updated', 'pull_request.reviewed'])
            definition.subscriptions.push({
              ...definition.subscriptions[0]!,
              id: output,
              source: { integration: 'github', output, version: 1 },
            })
        await db.insert(workStreamFlowRuns).values({
          workStreamId: stream!.id,
          version: 1,
          activated: true,
          state: createWorkflowRun(definition),
          attemptAgents: {},
          createRequestId: crypto.randomUUID(),
          createRequestHash: 'a'.repeat(64),
          createdBy: 'test',
          source: { schemaVersion: 1, definition, source: { kind: 'inline' } },
        })
      }
      return stream!.id
    },
    async effects() {
      const audience = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
      return {
        inbox: (
          await db
            .select()
            .from(inbox)
            .where(
              inArray(
                inbox.recipientId,
                audience.map((x) => x.id)
              )
            )
        ).length,
        agents: audience.length,
        streams: (await db.select().from(workStreams).where(eq(workStreams.squadId, squadId))).length,
        triggers: (
          await db.select().from(integrationOutputTriggerRuns).where(eq(integrationOutputTriggerRuns.squadId, squadId))
        ).length,
        deliveries: (
          await db
            .select()
            .from(integrationOutputDeliveries)
            .innerJoin(workStreams, eq(workStreams.id, integrationOutputDeliveries.workStreamId))
            .where(eq(workStreams.squadId, squadId))
        ).length,
      }
    },
    async close() {
      read.mockRestore()
      send.mockRestore()
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, moderatorRole))
      await db.delete(roles).where(eq(roles.id, moderatorRole))
      const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
      for (const { id } of owned)
        await (await Agent.mustFind(id)).getActiveExecution().then(async (execution) => execution?.stop())
      const audience = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
      await db.delete(inbox).where(
        inArray(
          inbox.recipientId,
          audience.map((x) => x.id)
        )
      )
      await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
      await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squadId))
      await db.delete(agents).where(eq(agents.squadId, squadId))
      await db.delete(integrationOutputEvents).where(sql`${integrationOutputEvents.authority}->>'squadId' = ${squadId}`)
      await db.delete(integrationConnections).where(eq(integrationConnections.id, connection!.id))
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(users).where(eq(users.id, userId))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    },
  }
}

for (const action of ['notify-manager', 'notify-consultant', 'start-workstream'] as const)
  test(`production publish holds matching ${action} feedback before any effect, including retry`, async () => {
    const h = await fixture(action)
    try {
      const before = await h.effects()
      await publishIntegrationOutput('github', h.fact(), h.authority)
      expect(await h.effects()).toEqual(before)
      const revisions = await db
        .select()
        .from(githubFeedbackRevisions)
        .where(eq(githubFeedbackRevisions.squadId, h.squadId))
      expect(revisions).toHaveLength(1)
      expect(revisions[0]!.decision).toBe('pending')
      await reconcileUnmatchedOutputs()
      expect(await h.effects()).toEqual(before)
    } finally {
      await h.close()
    }
  })

test('tracked pre-flow and subscription audiences cannot bypass the production hold', async () => {
  const h = await fixture()
  try {
    const one = await h.stream(),
      two = await h.stream(true)
    const before = await h.effects()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await reconcileOutputDeliveries(two)
    expect(await h.effects()).toEqual(before)
    expect(await outputDeliveryHistory(one)).toEqual([])
    expect(await outputDeliveryHistory(two)).toEqual([])
  } finally {
    await h.close()
  }
})

test('irrelevant feedback is recorded but never captured or queried from GitHub', async () => {
  const h = await fixture()
  try {
    await db.update(squads).set({ metadata: {} }).where(eq(squads.id, h.squadId))
    await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(0)
    expect(h.read).not.toHaveBeenCalled()
  } finally {
    await h.close()
  }
})

test('trust does not authorize a different native resource, nor a connection changed during provider I/O', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const before = await h.effects()
    h.read.mockImplementation(async <T>(): Promise<T | null> => ({ id: 999, full_name: 'acme/project' }) as T)
    await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(await h.effects()).toEqual(before)
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(0)
    h.read.mockImplementation(async <T>(): Promise<T | null> => {
      await db
        .update(integrationConnections)
        .set({ materialRevision: crypto.randomUUID() })
        .where(eq(integrationConnections.id, h.authority.connectionId))
      return { id: 10, full_name: 'acme/project' } as T
    })
    const another = h.fact()
    another.eventKey = crypto.randomUUID()
    await publishIntegrationOutput('github', another, h.authority)
    expect(await h.effects()).toEqual(before)
  } finally {
    await h.close()
  }
})

test('trusted runtime delivery uses the stored canonical snapshot, never the parent prose', async () => {
  const h = await fixture()
  try {
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    const [event] = await db
      .select()
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.id, String(messages[0]!.metadata?.integrationEventId)))
    expect(event!.sourceKey).toStartWith('github-feedback:')
    expect(messages[0]!.content).toContain('HELD_SENTINEL')
    expect(JSON.stringify(messages)).not.toContain('UNREVIEWED_PARENT')
    expect(JSON.stringify(event!.fact)).not.toContain('PARENT_BODY')
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(true)
    await db.update(inbox).set({ content: 'SUBSTITUTED_PROSE' }).where(eq(inbox.id, messages[0]!.id))
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(false)
  } finally {
    await h.close()
  }
})

test('legacy unnormalized and forged status input has zero production effects', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const before = await h.effects()
    const raw = h.fact()
    delete raw.github
    const stored = await recordIntegrationOutput('github', raw, h.authority)
    await reconcileUnmatchedOutputs()
    expect(await h.effects()).toEqual(before)
    expect(
      await db.select().from(integrationOutputDeliveries).where(eq(integrationOutputDeliveries.eventId, stored.id))
    ).toHaveLength(0)
  } finally {
    await h.close()
  }
})

const parent = {
  id: 20,
  number: 3,
  title: 'UNTRUSTED_TITLE',
  body: 'UNTRUSTED_DESCRIPTION',
  state: 'open',
  user: { id: 999, login: 'outsider', type: 'User' },
  html_url: 'https://github.com/acme/project/pull/3',
  head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'acme/project' } },
  base: { ref: 'main' },
  created_at: '2026-10-02T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
}

test('safe lifecycle bypasses prose moderation, not resource proof or generic content triggers', async () => {
  const h = await fixture('start-workstream')
  try {
    await h.stream()
    const [squad] = await db.select().from(squads).where(eq(squads.id, h.squadId))
    const metadata = squad!.metadata as any
    metadata.integrationRules.github[0].source.output = 'pull_request.merged'
    metadata.integrationRules.github[0].action.metadata = { 'untrusted.title': { event: 'title' } }
    await db.update(squads).set({ metadata }).where(eq(squads.id, h.squadId))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...parent, state: 'closed', merged: true }) as T
    )
    const fact = githubOutputAdapter.normalize({
      type: 'pull_request',
      githubObservation: { kind: 'webhook' },
      payload: {
        action: 'closed',
        repository: { id: 10, full_name: 'acme/project' },
        pull_request: { ...parent, state: 'closed', merged: true },
      },
    })[0]!
    await publishIntegrationOutput('github', fact, h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('merged')
    expect(JSON.stringify(messages)).not.toContain('UNTRUSTED_')
    expect((await h.effects()).streams).toBe(1)
    expect((await h.effects()).triggers).toBe(0)
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(true)
    const [proof] = await db
      .select()
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, String(messages[0]!.metadata?.integrationEventId)))
    expect(proof!.sourceEventId).not.toBe(proof!.eventId)
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(eq(githubOutputProofs.eventId, proof!.eventId))
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(false)
  } finally {
    await h.close()
  }
})

test('safe CI keeps useful IDs and conclusion, never workflow names or parent prose', async () => {
  const h = await fixture()
  try {
    await h.stream()
    const run = {
      id: 40,
      workflow_id: 50,
      name: 'UNTRUSTED_WORKFLOW',
      run_number: 1,
      run_attempt: 1,
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      updated_at: '2026-10-02T10:00:00Z',
      pull_requests: [{ number: 3, base: { repo: { id: 10, full_name: 'acme/project' } } }],
    }
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : path.endsWith('/actions/runs/40')
            ? run
            : parent) as T
    )
    const fact = githubOutputAdapter.normalize({
      type: 'workflow_run',
      githubObservation: { kind: 'webhook' },
      payload: { action: 'completed', repository: { id: 10, full_name: 'acme/project' }, workflow_run: run },
    })[0]!
    await publishIntegrationOutput('github', fact, h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('Workflow 50: failure')
    expect(messages[0]!.content).toContain('/actions/runs/40')
    expect(JSON.stringify(messages)).not.toContain('UNTRUSTED_')
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(true)
  } finally {
    await h.close()
  }
})

test('native webhook-only Dependabot rules carry structured security facts but never raw package bindings', async () => {
  const h = await fixture()
  try {
    const factInput = {
      type: 'dependabot_alert',
      githubObservation: { kind: 'webhook' as const },
      payload: {
        action: 'created',
        repository: { id: 10, full_name: 'acme/project' },
        alert: {
          number: 7,
          state: 'open',
          created_at: '2026-10-02T10:00:00Z',
          updated_at: '2026-10-02T10:00:00Z',
          security_advisory: { ghsa_id: 'GHSA-cfgh-jmpq-rvwx', severity: 'high' },
          security_vulnerability: { severity: 'high' },
          dependency: { package: { name: 'UNTRUSTED_PACKAGE', ecosystem: 'npm' }, manifest_path: 'UNTRUSTED_PATH' },
        },
      },
    }
    await db
      .update(squads)
      .set({ metadata: { github: [{ repo: 'acme/project' }] } })
      .where(eq(squads.id, h.squadId))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : path.endsWith('/dependabot/alerts/7')
            ? { number: 7 }
            : null) as T | null
    )
    await publishIntegrationOutput('github', githubOutputAdapter.normalize(factInput)[0]!, h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('GHSA-cfgh-jmpq-rvwx')
    expect(JSON.stringify(messages)).not.toContain('UNTRUSTED_')
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(true)
    const poll = { ...factInput, githubObservation: { kind: 'poll' as const } }
    expect(githubOutputAdapter.normalize(poll)).toEqual([])
    const noAuthority = githubOutputAdapter.normalize({ ...factInput, githubObservation: undefined })[0]!
    noAuthority.eventKey = crypto.randomUUID()
    await publishIntegrationOutput('github', noAuthority, h.authority)
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('branch binding and earlier-event routing cannot produce an effect for held feedback', async () => {
  const h = await fixture()
  try {
    const streamId = await h.stream(true, 'pull_request.comment', true)
    const before = await h.effects()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(await h.effects()).toEqual(before)
    const heldReview = githubOutputAdapter.normalize({
      type: 'pull_request_review',
      githubObservation: { kind: 'webhook' },
      payload: {
        action: 'submitted',
        repository: { id: 10, full_name: 'acme/project' },
        pull_request: parent,
        review: {
          id: 31,
          user: { id: 2, login: 'author', type: 'User' },
          body: 'HELD_REVIEW',
          state: 'changes_requested',
          submitted_at: '2026-10-02T10:00:00Z',
        },
      },
    })[0]!
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10' ? { id: 10, full_name: 'acme/project' } : parent) as T
    )
    await publishIntegrationOutput('github', heldReview, h.authority)
    const [unbound] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
    expect((unbound!.metadata as any).codeHost.changeRequest).toBeUndefined()
    const update = githubOutputAdapter.normalize({
      type: 'pull_request',
      githubObservation: { kind: 'webhook' },
      payload: { action: 'synchronize', repository: { id: 10, full_name: 'acme/project' }, pull_request: parent },
    })[0]!
    await publishIntegrationOutput('github', update, h.authority)
    const [bound] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
    expect((bound!.metadata as any).codeHost.changeRequest?.number).toBe(3)
    expect(JSON.stringify(bound!.metadata)).not.toContain('UNTRUSTED_')
    const deliveries = await db
      .select({ event: integrationOutputEvents })
      .from(integrationOutputDeliveries)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
    expect(deliveries.every(({ event }) => event.fact.data.projection === 'status')).toBe(true)
    expect(JSON.stringify(deliveries)).not.toContain('HELD_')
    expect((await h.effects()).inbox).toBe(0)
  } finally {
    await h.close()
  }
})

test('real runtime held mail creates no chat receipt or execution without stubbing Agent acceptance', async () => {
  const h = await fixture()
  h.useRealSend()
  try {
    const before = await h.effects()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await reconcileUnmatchedOutputs()
    expect(await h.effects()).toEqual(before)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
    expect(await (await Agent.mustFind(h.managerId)).getActiveExecution()).toBeNull()
  } finally {
    await h.close()
  }
})

test('a pre-existing raw delivery cannot leak prose during reconcile or parked-owner notification', async () => {
  const h = await fixture()
  try {
    const streamId = await h.stream(true)
    const event = await recordIntegrationOutput('github', h.fact(), h.authority)
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
    const sub = run!.state.definition.subscriptions![0]!
    await db
      .insert(integrationOutputDeliveries)
      .values({ eventId: event.id, workStreamId: streamId, subscriptionId: sub.id, subscription: sub })
    const before = await h.effects()
    await reconcileOutputDeliveries(streamId)
    expect(await h.effects()).toEqual(before)
    await db
      .update(workStreams)
      .set({ status: 'queued', ownerAgentId: h.managerId, assigneeAgentId: null })
      .where(eq(workStreams.id, streamId))
    await db
      .update(workStreamFlowRuns)
      .set({ attemptAgents: { '1': crypto.randomUUID() } })
      .where(eq(workStreamFlowRuns.workStreamId, streamId))
    await reconcileOutputDeliveries(streamId)
    expect((await h.effects()).inbox).toBe(0)
    expect(await outputDeliveryHistory(streamId)).toEqual([])
  } finally {
    await h.close()
  }
})

test('source replacement and expired native proof refuse actual canonical payload at final acceptance', async () => {
  const h = await fixture()
  try {
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    const [proof] = await db
      .select()
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, String(message!.metadata?.integrationEventId)))
    expect(await isCurrentIntegrationNotification(db, h.managerId, message!.id)).toBe(true)
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(eq(githubOutputProofs.eventId, proof!.eventId))
    expect(await isCurrentIntegrationNotification(db, h.managerId, message!.id)).toBe(false)
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(githubOutputProofs.eventId, proof!.eventId))
    const [source] = await db
      .select()
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.id, proof!.sourceEventId))
    await db
      .update(integrationOutputEvents)
      .set({ fact: { ...source!.fact, body: 'CHANGED_SOURCE' } })
      .where(eq(integrationOutputEvents.id, source!.id))
    expect(await isCurrentIntegrationNotification(db, h.managerId, message!.id)).toBe(false)
  } finally {
    await h.close()
  }
})

test('unknown native IDs and unknown actors become pending, not a source of automatic effects', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const fact = h.fact()
    fact.github!.content!.nativeId = null
    fact.github!.content!.author = null
    fact.eventKey = crypto.randomUUID()
    const before = await h.effects()
    await publishIntegrationOutput('github', fact, h.authority)
    expect(await h.effects()).toEqual(before)
    const [revision] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revision!.decision).toBe('pending')
    expect(revision!.reason).toBe('unknown_identity')
  } finally {
    await h.close()
  }
})

test('revocation at consultant creation fences the actual insert, not just the preceding query', async () => {
  const h = await fixture('notify-consultant')
  const create = Agent.create
  const creation = spyOn(Agent, 'create').mockImplementation(async (...args: Parameters<typeof Agent.create>) => {
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    return create(...args)
  })
  try {
    await h.trust()
    const before = await h.effects()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(await h.effects()).toEqual(before)
  } finally {
    creation.mockRestore()
    await h.close()
  }
})

test('serialized normalized-status envelopes cannot confer authority on arbitrary prose', async () => {
  const h = await fixture()
  try {
    await h.stream()
    const run = {
      id: 40,
      workflow_id: 50,
      name: 'Workflow',
      run_number: 1,
      run_attempt: 1,
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      updated_at: '2026-10-02T10:00:00Z',
      pull_requests: [{ number: 3, base: { repo: { id: 10, full_name: 'acme/project' } } }],
    }
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : path.endsWith('/actions/runs/40')
            ? run
            : parent) as T
    )
    const fact = githubOutputAdapter.normalize({
      type: 'workflow_run',
      githubObservation: { kind: 'webhook' },
      payload: { action: 'completed', repository: { id: 10, full_name: 'acme/project' }, workflow_run: run },
    })[0]!
    fact.github!.status!.body = 'FORGED_STATUS_PROSE'
    const before = await h.effects()
    await publishIntegrationOutput('github', fact, h.authority)
    expect(await h.effects()).toEqual(before)
  } finally {
    await h.close()
  }
})

test('a pending replay uses no provider read and future author trust cannot release its history', async () => {
  const h = await fixture()
  try {
    const before = await h.effects()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    h.read.mockClear()
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(h.read).not.toHaveBeenCalled()
    expect(await h.effects()).toEqual(before)
  } finally {
    await h.close()
  }
})

test('native object ownership is independent of a serialized trusted numeric author ID', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const observed = h.fact()
    h.native.user.id = 999
    const before = await h.effects()
    await publishIntegrationOutput('github', observed, h.authority)
    expect(await h.effects()).toEqual(before)
    const [revision] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revision!.decision).toBe('pending')
  } finally {
    await h.close()
  }
})

for (const kind of ['webhook', 'poll'] as const)
  test(`verified ${kind} normalization holds real public feedback with zero routing effects`, async () => {
    const h = await fixture()
    try {
      const event = {
        type: 'issue_comment',
        githubObservation: { kind },
        payload: {
          action: 'created',
          repository: { id: 10, full_name: 'acme/project' },
          issue: { id: 20, number: 3, title: 'UNREVIEWED_PARENT', pull_request: {} },
          comment: h.native,
        },
      }
      const before = await h.effects()
      const { publishIntegrationOutputs } = await import('../outputs/runtime')
      if (kind === 'webhook') {
        h.read.mockImplementation(
          async <T>(path: string): Promise<T | null> =>
            (path === '/repositories/10' || path === '/repos/acme/project'
              ? { id: 10, full_name: 'acme/project' }
              : h.native) as T
        )
        const { publishGitHubWebhookOutputs } = await import('./ingress')
        expect(await publishGitHubWebhookOutputs(event)).toEqual([])
      } else expect(await publishIntegrationOutputs('github', event, h.authority)).toEqual([])
      await reconcileUnmatchedOutputs()
      expect(await h.effects()).toEqual(before)
      expect(
        await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
      ).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

test('authenticated hosted relay keeps factual receipts but no held-content routing effects', async () => {
  const h = await fixture()
  const { createTestGitHubConnection } = await import('../../../test-utils/github-connection')
  const connection = await createTestGitHubConnection({ squadId: h.squadId })
  try {
    const [live] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connection.id))
    const { dispatchHostedGitHubDelivery } = await import('../relay/runtime')
    const before = await h.effects()
    await dispatchHostedGitHubDelivery(
      {
        id: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        connectionId: connection.id,
        connectionRevision: live!.materialRevision,
        resourceId: '10',
        resourceKey: 'acme/project',
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          repository: { id: 10, full_name: 'acme/project' },
          issue: { id: 20, number: 3, pull_request: {} },
          comment: h.native,
        },
      },
      [{ squadId: h.squadId, connectionId: connection.id, repository: 'acme/project' }]
    )
    expect(await h.effects()).toEqual(before)
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(1)
  } finally {
    await h.close()
    await connection.dispose()
  }
})

test('an explicitly trusted bot uses the same existing pre-flow recipient, not a blanket bot bypass', async () => {
  const h = await fixture()
  try {
    h.native.user.type = 'Bot'
    h.native.user.login = 'robot[bot]'
    await h.trust('Bot')
    await h.stream()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('HELD_SENTINEL')
    expect((await h.effects()).agents).toBe(1)
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(true)
  } finally {
    await h.close()
  }
})

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
test('a native witness that expires waiting for the authority lock cannot become a fresh effect proof', async () => {
  const h = await fixture(),
    entered = barrier(),
    release = barrier(),
    blocked = barrier()
  let owner: Promise<unknown> | undefined, publishing: Promise<unknown> | undefined
  try {
    await h.trust()
    const before = await h.effects()
    owner = db.transaction(async (tx) => {
      await lockGitHubTrustAuthority(tx)
      entered.resolve()
      await release.promise
    })
    await entered.promise
    setDatabaseQueryObserverForTest((query) => {
      if (query.includes('pg_advisory_xact_lock(438, 5)')) blocked.resolve()
    })
    publishing = publishIntegrationOutput('github', h.fact(), h.authority)
    await blocked.promise
    setSystemTime(new Date(Date.now() + 90_000))
    release.resolve()
    await owner
    await publishing
    expect(await h.effects()).toEqual(before)
  } finally {
    release.resolve()
    await Promise.allSettled([owner, publishing].filter(Boolean))
    setDatabaseQueryObserverForTest(undefined)
    setSystemTime()
    await h.close()
  }
})

test('a second observing account cannot overwrite the canonical first-source resource proof', async () => {
  const h = await fixture()
  const { createTestGitHubConnection } = await import('../../../test-utils/github-connection')
  const connection = await createTestGitHubConnection({ squadId: h.squadId })
  try {
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    const before = await h.effects()
    const [second] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connection.id))
    await publishIntegrationOutput('github', h.fact(), {
      ...h.authority,
      connectionId: connection.id,
      connectionRevision: second!.materialRevision,
    })
    expect(await h.effects()).toEqual(before)
    expect(await isCurrentIntegrationNotification(db, h.managerId, message!.id)).toBe(true)
    const [proof] = await db
      .select()
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, String(message!.metadata?.integrationEventId)))
    const [source] = await db
      .select()
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.id, proof!.sourceEventId))
    expect(source!.authority).toEqual(h.authority)
  } finally {
    await h.close()
    await connection.dispose()
  }
})

test('safe CI projection preserves source partitioning so older queued runs are superseded', async () => {
  const h = await fixture()
  try {
    const streamId = await h.stream(true, 'pull_request.ci_completed')
    const runs = [1, 2].map((run_number) => ({
      id: 39 + run_number,
      workflow_id: 50,
      name: 'UNTRUSTED_WORKFLOW',
      run_number,
      run_attempt: 1,
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      updated_at: `2026-10-0${run_number}T10:00:00Z`,
      pull_requests: [{ number: 3, base: { repo: { id: 10, full_name: 'acme/project' } } }],
    }))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : path.includes('/actions/runs/')
            ? runs.find((run) => path.endsWith(`/${run.id}`))
            : parent) as T
    )
    for (const run of runs)
      await publishIntegrationOutput(
        'github',
        githubOutputAdapter.normalize({
          type: 'workflow_run',
          githubObservation: { kind: 'webhook' },
          payload: { action: 'completed', repository: { id: 10, full_name: 'acme/project' }, workflow_run: run },
        })[0]!,
        h.authority
      )
    await reconcileOutputDeliveries(streamId)
    const rows = await db
      .select({ event: integrationOutputEvents, delivery: integrationOutputDeliveries })
      .from(integrationOutputDeliveries)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
    expect(rows).toHaveLength(2)
    expect(rows.find(({ event }) => (event.fact.data.ci as any).runNumber === '1')!.delivery.status).toBe('superseded')
    expect(JSON.stringify(await outputDeliveryHistory(streamId))).not.toContain('UNTRUSTED_WORKFLOW')
  } finally {
    await h.close()
  }
})

test('bounded renewal still supersedes older CI behind a terminal newer observation', async () => {
  const h = await fixture()
  try {
    const streamId = await h.stream(true, 'pull_request.ci_completed')
    const runs = [1, 2].map((run_number) => ({
      id: 39 + run_number,
      workflow_id: 50,
      name: 'UNTRUSTED_WORKFLOW',
      run_number,
      run_attempt: 1,
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      updated_at: `2026-10-0${run_number}T10:00:00Z`,
      pull_requests: [{ number: 3, base: { repo: { id: 10, full_name: 'acme/project' } } }],
    }))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : path.includes('/actions/runs/')
            ? runs.find((run) => path.endsWith(`/${run.id}`))
            : parent) as T
    )
    for (const run of runs)
      await publishIntegrationOutput(
        'github',
        githubOutputAdapter.normalize({
          type: 'workflow_run',
          githubObservation: { kind: 'webhook' },
          payload: { action: 'completed', repository: { id: 10, full_name: 'acme/project' }, workflow_run: run },
        })[0]!,
        h.authority
      )
    const before = await db
      .select({ event: integrationOutputEvents, delivery: integrationOutputDeliveries })
      .from(integrationOutputDeliveries)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
    for (const row of before)
      await db
        .update(integrationOutputDeliveries)
        .set({ status: (row.event.fact.data.ci as any).runNumber === '2' ? 'delivered' : 'pending' })
        .where(eq(integrationOutputDeliveries.id, row.delivery.id))
    await reconcileOutputDeliveries(streamId)
    const rows = await db
      .select({ event: integrationOutputEvents, delivery: integrationOutputDeliveries })
      .from(integrationOutputDeliveries)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
    expect(rows).toHaveLength(2)
    expect(rows.find(({ event }) => (event.fact.data.ci as any).runNumber === '1')!.delivery.status).toBe('superseded')
    expect(JSON.stringify(await outputDeliveryHistory(streamId))).not.toContain('UNTRUSTED_WORKFLOW')
  } finally {
    await h.close()
  }
})

test('ordinary GitHub enqueue without an accepted receipt never claims delivered', async () => {
  const h = await fixture()
  try {
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(message).toBeDefined()
    expect(message!.deliveredAt).toBeNull()
  } finally {
    await h.close()
  }
})

test('expired ordinary queued work renews outside locks then records actual acceptance once', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(eq(githubOutputProofs.eventId, eventId!))
    h.useRealSend()
    h.read.mockClear()
    await deliverInboxMessagesToAgent(h.managerId)
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.clientId).toBe(`github-feedback:${eventId}:${message!.id}`)
    expect(receipts[0]!.messageId).toBeTruthy()
    expect(receipts[0]!.executionId).toBeTruthy()
    expect(receipts[0]!.acceptedAt).toBeTruthy()
    expect(await hasAcceptedGitHubFeedbackReceipts(eventId!)).toBe(true)
    const [after] = await db.select().from(inbox).where(eq(inbox.id, message!.id))
    expect(after!.deliveredAt).toEqual(receipts[0]!.acceptedAt)
    await deliverInboxMessagesToAgent(h.managerId)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(3)
  } finally {
    await h.close()
  }
})

test('known-record renewal deduplicates and caps provider work; revoked authority costs zero', async () => {
  expect(renewal.renewKnownGitHubOutputs).toBeDefined()
  const h = await fixture()
  try {
    await h.trust()
    const ids: string[] = []
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : {
              ...h.native,
              id: Number(path.split('/').at(-1)),
            }) as T
    )
    for (let index = 0; index < 9; index++) {
      h.native.id = 30 + index
      ids.push((await publishIntegrationOutput('github', h.fact(), h.authority))!)
    }
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(inArray(githubOutputProofs.eventId, ids))
    h.read.mockClear()
    const result = await renewal.renewKnownGitHubOutputs([...ids, ...ids])
    expect(result.renewed).toHaveLength(8)
    expect(result.deferred).toHaveLength(1)
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(24)
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    h.read.mockClear()
    const revoked = await renewal.renewKnownGitHubOutputs(ids)
    expect(revoked.renewed).toHaveLength(0)
    expect(revoked.withheld).toHaveLength(8)
    expect(revoked.deferred).toHaveLength(1)
    expect((await renewal.renewKnownGitHubOutputs(revoked.deferred)).withheld).toHaveLength(1)
    expect(h.read.mock.calls).toHaveLength(0)
  } finally {
    await h.close()
  }
}, 20_000)

test('creation owner intake links the canonical event to real accepted receipt without starting paused workers', async () => {
  const h = await fixture('start-workstream')
  try {
    await h.trust()
    h.useRealSend()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const [created] = await db.select().from(workStreams).where(eq(workStreams.squadId, h.squadId))
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(created!.pause).not.toBeNull()
    expect(notice!.metadata?.integrationEventId).toBe(eventId)
    const [receipt] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipt!.clientId).toBe(`github-feedback:${eventId}:${notice!.id}`)
    expect(receipt!.messageId).toBeTruthy()
    expect(receipt!.executionId).toBeTruthy()
    expect(receipt!.acceptedAt).toBeTruthy()
    expect(await hasAcceptedGitHubFeedbackReceipts(eventId!)).toBe(true)
    expect((await db.select().from(agents).where(eq(agents.squadId, h.squadId))).length).toBe(1)
  } finally {
    await h.close()
  }
})

for (const authority of ['material'] as const)
  test(`committing ${authority} revocation blocks then refuses real ordinary queue acceptance`, async () => {
    const h = await fixture()
    let release!: () => void, entered!: () => void, observed!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const mutated = new Promise<void>((resolve) => {
      entered = resolve
    })
    const locking = new Promise<void>((resolve) => {
      observed = resolve
    })
    let revocation: Promise<unknown> | undefined, acceptance: Promise<string> | undefined
    try {
      await h.trust()
      await publishIntegrationOutput('github', h.fact(), h.authority)
      const [row] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
      h.useRealSend()
      revocation = db.transaction(async (tx) => {
        await tx
          .update(integrationConnections)
          .set({ materialRevision: crypto.randomUUID() })
          .where(eq(integrationConnections.id, h.authority.connectionId))
        entered()
        await barrier
      })
      await mutated
      setDatabaseQueryObserverForTest((query) => {
        if (query.includes('for share') && query.includes('integration_connections')) observed()
      })
      const { prepareInboxDelivery } = await import('../../inbox/inboxDelivery')
      const { InboxMessage } = await import('../../../entities/InboxMessage')
      const prepared = prepareInboxDelivery([new InboxMessage(row!)], 'steer', 'steer')
      acceptance = (await Agent.mustFind(h.managerId))
        .sendMessage(prepared.prompt, {
          deliveryMode: 'steer',
          metadata: {
            ...prepared.metadata,
            clientId: `github-feedback:${row!.metadata!.integrationEventId}:${row!.id}`,
          },
        })
        .then(
          () => 'accepted',
          () => 'refused'
        )
      expect(await Promise.race([locking.then(() => 'authority-lock'), acceptance])).toBe('authority-lock')
      release()
      await revocation
      expect(await acceptance).toBe('refused')
      expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
    } finally {
      release?.()
      await Promise.allSettled([revocation, acceptance].filter(Boolean))
      setDatabaseQueryObserverForTest(undefined)
      await h.close()
    }
  })

test('a witness expiring behind a warm agent queue lock cannot accept a new message', async () => {
  const h = await fixture()
  try {
    await h.trust()
    h.useRealSend()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const initial = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(initial).toHaveLength(1)
    h.native.body = 'A second immutable revision'
    h.native.updated_at = '2026-10-02T10:01:00Z'
    setSendMessageLockedHookForTests(async () => {
      setSystemTime(new Date(Date.now() + 61_000))
    })
    const secondId = await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    const [notice] = await db
      .select()
      .from(inbox)
      .where(sql`${inbox.metadata}->>'integrationEventId' = ${secondId}`)
    expect(notice!.deliveredAt).toBeNull()
  } finally {
    setSendMessageLockedHookForTests(undefined)
    setSystemTime()
    await h.close()
  }
})

test('expired retained inactive consumer deliberately activates its slot', async () => {
  const h = await fixture()
  try {
    const id = await h.stream(true)
    await db.transaction(async (tx) => {
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id))
      const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
      const definition = run!.state.definition
      definition.participants.worker!.agentTypeId = (await Agent.mustFind(h.managerId)).agentTypeId
      await tx.delete(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
      await attachFlow(tx, stream!, { kind: 'inline', definition })
      await tx.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, id))
    })
    await h.trust()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(eq(githubOutputProofs.eventId, eventId!))
    h.useRealSend()
    await db.transaction(async (tx) => {
      const [stream] = await tx.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, id)).returning()
      const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
      await dispatchFlow(tx, stream!, run!, [])
    })
    h.read.mockClear()
    await reconcileOutputDeliveries(id)
    const [delivery] = await db
      .select()
      .from(integrationOutputDeliveries)
      .where(eq(integrationOutputDeliveries.eventId, eventId!))
    expect(delivery!.targets).toHaveLength(1)
    const target = delivery!.targets[0]!
    const [receipt] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, target.agentId))
    expect(receipt!.messageId).toBeTruthy()
    expect(receipt!.executionId).toBeTruthy()
    expect(receipt!.clientId).toBe(`integration-output:${delivery!.id}:${target.inboxId}`)
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(3)
  } finally {
    await h.close()
  }
})

test('retained ordinary pre-flow mail refuses acceptance while its original stream is paused', async () => {
  const h = await fixture()
  try {
    const id = await h.stream()
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(await isCurrentIntegrationNotification(db, h.managerId, notice!.id)).toBe(true)
    await db
      .update(workStreams)
      .set({
        pause: {
          id: crypto.randomUUID(),
          pausedAt: new Date().toISOString(),
          reason: 'User pause',
          parkAt: null,
          agentIds: [],
        },
      })
      .where(eq(workStreams.id, id))
    expect(await isCurrentIntegrationNotification(db, h.managerId, notice!.id)).toBe(false)
  } finally {
    await h.close()
  }
})

test('parked independent owner has an actual canonical receipt, not settlement or a substitute owner', async () => {
  const h = await fixture()
  try {
    const id = await h.stream(true)
    await db.transaction(async (tx) => {
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, id))
      const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
      const definition = run!.state.definition
      definition.participants.worker!.agentTypeId = (await Agent.mustFind(h.managerId)).agentTypeId
      await tx.delete(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, id))
      const attached = await attachFlow(tx, stream!, { kind: 'inline', definition })
      await dispatchFlow(tx, stream!, attached, [])
      await tx.update(workStreams).set({ status: 'queued', ownerAgentId: h.managerId }).where(eq(workStreams.id, id))
    })
    await h.trust()
    h.useRealSend()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const [delivery] = await db
      .select()
      .from(integrationOutputDeliveries)
      .where(eq(integrationOutputDeliveries.eventId, eventId!))
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(notice!.metadata?.integrationOwnerNotice).toBe(true)
    expect(notice!.metadata?.integrationEventId).toBe(eventId)
    const [receipt] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipt!.clientId).toBe(`integration-output:${delivery!.id}:${notice!.id}`)
    expect(receipt!.acceptedAt).toBeTruthy()
    expect(receipt!.messageId).toBeTruthy()
    expect(receipt!.executionId).toBeTruthy()
    expect(await hasAcceptedGitHubFeedbackReceipts(eventId!)).toBe(false)
    expect(delivery!.targets).toHaveLength(0)
    await reconcileOutputDeliveries(id)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    await db.update(workStreams).set({ ownerAgentId: null }).where(eq(workStreams.id, id))
    expect(await isCurrentIntegrationDelivery(db, delivery!.id, h.managerId, notice!.id)).toBe(false)
    await reconcileOutputDeliveries(id)
    expect((await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).length).toBe(1)
  } finally {
    await h.close()
  }
})

test('ordinary acceptance-before-ack crash settles the exact receipt even after revocation, without resending', async () => {
  const h = await fixture()
  const update = InboxMessage.prototype.update
  const ack = spyOn(InboxMessage.prototype, 'update').mockImplementation(async function (this: InboxMessage, input) {
    if (input.deliveredAt) throw new Error('Injected acknowledgement crash')
    return update.call(this, input)
  })
  try {
    await h.trust()
    h.useRealSend()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(notice!.deliveredAt).toBeNull()
    expect(await hasAcceptedGitHubFeedbackReceipts(eventId!)).toBe(true)
    ack.mockRestore()
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(eq(githubOutputProofs.eventId, eventId!))
    h.read.mockClear()
    await deliverInboxMessagesToAgent(h.managerId)
    const [settled] = await db.select().from(inbox).where(eq(inbox.id, notice!.id))
    expect(settled!.deliveredAt).not.toBeNull()
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    expect(h.read.mock.calls).toHaveLength(0)
  } finally {
    ack.mockRestore()
    await h.close()
  }
})

test('observed ordinary automatic-trust revocation becomes pending history, not a future trust replay', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    h.read.mockClear()
    expect((await renewal.renewKnownGitHubOutputs([eventId!])).withheld).toEqual([eventId!])
    const [revision] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revision!.decision).toBe('pending')
    expect(revision!.releaseState).toBe('held')
    expect(revision!.reason).toBe('trust_revoked')
    await h.trust()
    h.useRealSend()
    await deliverInboxMessagesToAgent(h.managerId)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
    expect(h.read.mock.calls).toHaveLength(0)
  } finally {
    await h.close()
  }
})

for (const revoked of ['resource', 'material'] as const)
  test(`expired ordinary proof cannot renew through ${revoked} revocation`, async () => {
    const h = await fixture()
    try {
      await h.trust()
      const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
      await db
        .update(githubOutputProofs)
        .set({ expiresAt: new Date(0) })
        .where(eq(githubOutputProofs.eventId, eventId!))
      if (revoked === 'resource') h.read.mockResolvedValue(null)
      else
        await db
          .update(integrationConnections)
          .set({ materialRevision: crypto.randomUUID() })
          .where(eq(integrationConnections.id, h.authority.connectionId))
      h.read.mockClear()
      h.useRealSend()
      await deliverInboxMessagesToAgent(h.managerId)
      expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
      const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
      expect(notice!.deliveredAt).toBeNull()
      expect(await isCurrentIntegrationNotification(db, h.managerId, notice!.id)).toBe(false)
      if (revoked === 'resource') expect(h.read.mock.calls.length).toBeLessThanOrEqual(3)
      else expect(h.read.mock.calls).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

test('renewal rejects oversized or malformed known-record requests without provider work', async () => {
  const h = await fixture()
  try {
    await expect(
      renewal.renewKnownGitHubOutputs(Array.from({ length: 26 }, () => crypto.randomUUID()))
    ).rejects.toThrow('invalid_github_renewal_batch')
    await expect(renewal.renewKnownGitHubOutputs(['not-a-uuid'])).rejects.toThrow('invalid_github_renewal_batch')
    expect(h.read.mock.calls).toHaveLength(0)
  } finally {
    await h.close()
  }
})

for (const warm of [false, true])
  test(`native proof expiry during ${warm ? 'warm' : 'cold'} message persistence rolls back actual acceptance`, async () => {
    const h = await fixture()
    try {
      await h.trust()
      h.useRealSend()
      if (warm) {
        await publishIntegrationOutput('github', h.fact(), h.authority)
        h.native.body = 'A new revision expiring during persistence'
        h.native.updated_at = '2026-10-02T10:01:00Z'
      }
      let shifted = false
      setDatabaseQueryObserverForTest((query) => {
        if (!shifted && query.startsWith('insert into "messages"')) {
          shifted = true
          setSystemTime(new Date(Date.now() + 61_000))
        }
      })
      await publishIntegrationOutput('github', h.fact(), h.authority)
      expect(shifted).toBe(true)
      expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(
        warm ? 1 : 0
      )
      if (!warm) expect(await (await Agent.mustFind(h.managerId)).getActiveExecution()).toBeNull()
    } finally {
      setDatabaseQueryObserverForTest(undefined)
      setSystemTime()
      await h.close()
    }
  })

test('a concurrent first-proof source adoption cannot exceed the known-renewal provider budget', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const [proof] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, eventId!))
    const fact = h.fact()
    fact.eventKey = crypto.randomUUID()
    const [second] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: crypto.randomUUID(),
        eventKey: fact.eventKey,
        authority: h.authority,
        fact,
      })
      .returning()
    await captureGitHubFeedback(second!.id, { authorizeSource: async () => true })
    await db.delete(githubOutputProofs).where(eq(githubOutputProofs.eventId, eventId!))
    let adopted = false
    h.read.mockClear()
    h.read.mockImplementation(async <T>(path: string): Promise<T | null> => {
      if (!adopted) {
        adopted = true
        await db.insert(githubOutputProofs).values({
          ...proof!,
          sourceEventId: second!.id,
          sourceHash: githubContentHash([second!.fact, second!.authority, second!.sourceKey, second!.eventKey]),
        })
      }
      return (path === '/repositories/10' ? { id: 10, full_name: 'acme/project' } : h.native) as T
    })
    await renewal.renewKnownGitHubOutputs([eventId!])
    expect(adopted).toBe(true)
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(3)
  } finally {
    await h.close()
  }
})

test('a different source material cannot first materialize an approval captured under original authority', async () => {
  const h = await fixture()
  const { createTestGitHubConnection } = await import('../../../test-utils/github-connection')
  const other = await createTestGitHubConnection({ squadId: h.squadId })
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [revision] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    await db
      .update(githubFeedbackRevisions)
      .set({
        decision: 'allow_once',
        decisionVersion: 1,
        decidedByUserId: h.userId,
        decidedAt: new Date(),
        releaseState: 'ready',
      })
      .where(eq(githubFeedbackRevisions.id, revision!.id))
    const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, other.id))
    const source = await recordIntegrationOutput('github', h.fact(), {
      ...h.authority,
      connectionId: other.id,
      connectionRevision: connection!.materialRevision,
    })
    await captureGitHubFeedback(source.id, { authorizeSource: async () => true })
    await expect(recordCanonicalGitHubFeedback(revision!.id, source.id, async () => true)).rejects.toThrow(
      'feedback_source_unavailable'
    )
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.sourceKey} LIKE 'github-feedback:' || ${h.squadId} || ':%'`)
    ).toHaveLength(0)
  } finally {
    await h.close()
    await other.dispose()
  }
})

test('one root pass shares renewal limits across calls and retries, without duplicate provider reads', async () => {
  const pass = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const ids: string[] = []
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    for (let i = 0; i < 10; i++) {
      h.native.id = 30 + i
      ids.push((await publishIntegrationOutput('github', h.fact(), h.authority))!)
    }
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(inArray(githubOutputProofs.eventId, ids))
    h.read.mockClear()
    await pass.withGitHubOutputPass(async () => {
      await renewal.renewKnownGitHubOutputs(ids.slice(0, 5))
      await renewal.renewKnownGitHubOutputs(ids.slice(0, 5))
      await renewal.renewKnownGitHubOutputs(ids.slice(5))
    })
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(24)
    expect(
      await db
        .select()
        .from(githubOutputProofs)
        .where(sql`${githubOutputProofs.eventId} IN ${ids} AND ${githubOutputProofs.expiresAt} > clock_timestamp()`)
    ).toHaveLength(8)
  } finally {
    await h.close()
  }
}, 20_000)

test('production root reconcile releases a selected held revision to its original ordinary agent once', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  h.useRealSend()
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(held!.decision).toBe('pending')
    expect((await h.effects()).inbox).toBe(0)
    await h.allow(held!.id)
    await reconcileFlows()
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipts).toHaveLength(1)
    const [released] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
    expect(released!.releaseState).toBe('delivered')
    expect(receipts[0]!.acceptedAt).toBeTruthy()
    await reconcileFlows()
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    expect((await h.effects()).agents).toBe(1)
  } finally {
    await h.close()
  }
}, 20_000)

test('root reconcile shares one provider budget across many paused streams and eventually visits the tail', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  try {
    await h.trust()
    const ids: string[] = [],
      streamIds: string[] = []
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    for (let i = 0; i < 10; i++) {
      const streamId = await h.stream(true)
      streamIds.push(streamId)
      await db
        .update(workStreams)
        .set({ pause: { reason: 'Test', pausedAt: new Date().toISOString(), pausedBy: 'test' } as any })
        .where(eq(workStreams.id, streamId))
      h.native.id = 30 + i
      ids.push((await publishIntegrationOutput('github', h.fact(), h.authority))!)
    }
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(inArray(githubOutputProofs.eventId, ids))
    h.read.mockClear()
    await reconcileFlows()
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(24)
    await reconcileFlows()
    const tail = await db
      .select()
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, ids.at(-1)!))
    expect(tail[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect((await h.effects()).inbox).toBe(0)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
  } finally {
    await h.close()
  }
}, 120_000)

test('unmatched raw status aliases with existing safe proofs cost zero renewal work', async () => {
  const h = await fixture()
  try {
    await h.stream()
    await db
      .update(squads)
      .set({
        metadata: {
          integrationRules: {
            github: [
              {
                id: 'rule',
                enabled: true,
                source: { integration: 'github', output: 'pull_request.closed', version: 1 },
                filters: { audience: 'any' },
                predicates: [],
                action: { type: 'notify-manager' },
              },
            ],
          },
        },
      })
      .where(eq(squads.id, h.squadId))
    const fact = githubOutputAdapter.normalize({
      type: 'pull_request',
      githubObservation: { kind: 'webhook' },
      payload: {
        action: 'closed',
        repository: { id: 10, full_name: 'acme/project' },
        pull_request: {
          ...parent,
          state: 'closed',
          html_url: 'https://github.com/acme/project/pull/3',
          user: { id: 99, login: 'unknown', type: 'User' },
          title: 'UNREVIEWED_TITLE',
          body: 'UNREVIEWED_BODY',
          updated_at: '2026-10-02T10:00:00Z',
          closed_at: '2026-10-02T10:00:00Z',
        },
      },
    })[0]!
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { id: 20, number: 3, html_url: 'https://github.com/acme/project/pull/3' }) as T
    )
    const id = await publishIntegrationOutput('github', fact, h.authority)
    const [proof] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, id!))
    expect(proof).toBeTruthy()
    h.read.mockClear()
    await reconcileUnmatchedOutputs()
    await reconcileUnmatchedOutputs()
    expect(h.read.mock.calls).toHaveLength(0)
  } finally {
    await h.close()
  }
})

test('ambiguous current-content reads also consume the aggregate fixed provider budget', async () => {
  const { withGitHubOutputPass } = await import('./feedback-pass')
  const { prepareGitHubOutput } = await import('./feedback-routing')
  const h = await fixture()
  try {
    await h.trust()
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    const sources = []
    for (let i = 0; i < 8; i++) {
      h.native.id = 30 + i
      h.native.body = 'ORIGINAL'
      await publishIntegrationOutput('github', h.fact(), h.authority)
      h.native.body = 'EDITED AT SAME CLOCK'
      sources.push(await recordIntegrationOutput('github', h.fact(), h.authority))
    }
    h.read.mockClear()
    await withGitHubOutputPass(async () => {
      for (const source of sources) await prepareGitHubOutput(source)
    })
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(24)
  } finally {
    await h.close()
  }
}, 30_000)

for (const changed of ['manager', 'rule', 'material', 'resource'] as const) {
  test(`mounted selected release after ${changed} revocation delivers nothing and settles truthfully`, async () => {
    const { reconcileFlows } = await import('../../workflows/execution')
    const h = await fixture()
    h.useRealSend()
    try {
      await publishIntegrationOutput('github', h.fact(), h.authority)
      const [held] = await db
        .select()
        .from(githubFeedbackRevisions)
        .where(eq(githubFeedbackRevisions.squadId, h.squadId))
      await h.allow(held!.id)
      if (changed === 'manager') await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, h.squadId))
      if (changed === 'rule') await db.update(squads).set({ metadata: {} }).where(eq(squads.id, h.squadId))
      if (changed === 'material')
        await db
          .update(integrationConnections)
          .set({ materialRevision: crypto.randomUUID() })
          .where(eq(integrationConnections.id, h.authority.connectionId))
      if (changed === 'resource') h.read.mockResolvedValue(null)
      h.read.mockClear()
      await reconcileFlows()
      expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
      expect((await h.effects()).inbox).toBe(0)
      const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
      // Routing runs at release time: with no current manager or rule nobody receives it, and the
      // revision is terminal instead of retrying forever. Lost access stays retained for retry.
      expect(after!.releaseState).toBe(changed === 'rule' || changed === 'manager' ? 'obsolete' : 'retained')
      if (changed === 'rule' || changed === 'manager') expect(after!.reason).toBe('no_current_recipient')
      if (changed === 'material') expect(h.read.mock.calls).toHaveLength(0)
      else expect(h.read.mock.calls.length).toBeLessThanOrEqual(3)
    } finally {
      await h.close()
    }
  })
}

test('mounted release never substitutes later provider text for the exact human-approved snapshot', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  h.useRealSend()
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    await h.allow(held!.id)
    h.native.body = 'LATER_UNREVIEWED_TEXT'
    h.native.updated_at = '2026-10-02T10:01:00Z'
    await reconcileFlows()
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('HELD_SENTINEL')
    expect(notices[0]!.content).not.toContain('LATER_UNREVIEWED_TEXT')
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('mounted factory prepares provider evidence before authority locking and refuses expiry behind that lock', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture(),
    entered = barrier(),
    unblock = barrier(),
    waiting = barrier()
  h.useRealSend()
  let owner: Promise<unknown> | undefined, tick: Promise<unknown> | undefined
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    await h.allow(held!.id)
    h.read.mockClear()
    owner = db.transaction(async (tx) => {
      await lockGitHubTrustAuthority(tx)
      entered.resolve()
      await unblock.promise
    })
    await entered.promise
    setDatabaseQueryObserverForTest((query) => {
      if (query.includes('pg_advisory_xact_lock(438, 5)')) waiting.resolve()
    })
    tick = reconcileFlows()
    await waiting.promise
    // Both native reads finished while the factory was still waiting to acquire authority.
    expect(h.read.mock.calls).toHaveLength(2)
    setSystemTime(new Date(Date.now() + 90_000))
    unblock.resolve()
    await owner
    await tick
    expect(h.read.mock.calls).toHaveLength(2)
    expect((await h.effects()).inbox).toBe(0)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
    expect(after!.releaseState).toBe('retry')
  } finally {
    unblock.resolve()
    await Promise.allSettled([owner, tick].filter(Boolean))
    setDatabaseQueryObserverForTest(undefined)
    setSystemTime()
    await h.close()
  }
})

test('mounted release accepts newly routed feedback through the original actual flow participant in the same tick', async () => {
  const { reconcileFlows, getFlow } = await import('../../workflows/execution')
  const h = await fixture()
  try {
    const streamId = await h.stream(true)
    const [manager] = await db.select().from(agents).where(eq(agents.id, h.managerId))
    await db.transaction(async (tx) => {
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId))
      const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
      const definition = run!.state.definition
      definition.participants.worker!.agentTypeId = manager!.agentTypeId
      await tx.delete(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
      const attached = await attachFlow(tx, stream!, { kind: 'inline', definition })
      await dispatchFlow(tx, stream!, attached, [])
    })
    const original = (await getFlow(streamId))!.attemptAgents['1']!
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    await h.allow(held!.id)
    h.useRealSend()
    await reconcileFlows()
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, original))
    expect(receipts.filter((row) => row.clientId.startsWith('integration-output:'))).toHaveLength(1)
    const run = await getFlow(streamId)
    expect(run!.attemptAgents['1']).toBe(original)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
    expect(after!.releaseState).toBe('delivered')
    await reconcileFlows()
    expect(
      (await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, original))).filter((row) =>
        row.clientId.startsWith('integration-output:')
      )
    ).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('mounted retained canonical work with a fresh native proof does not reread its raw alias', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  try {
    await h.trust()
    const id = await publishIntegrationOutput('github', h.fact(), h.authority)
    expect(await hasAcceptedGitHubFeedbackReceipts(id!)).toBe(false)
    h.read.mockClear()
    await reconcileFlows()
    expect(h.read.mock.calls).toHaveLength(0)
    const [revision] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revision!.releaseState).toBe('retained')
  } finally {
    await h.close()
  }
})

test('exhausted root work slots select no GitHub delivery bodies before reservation', async () => {
  const { withGitHubOutputPass, reserveGitHubEvent, githubOutputPass } = await import('./feedback-pass')
  const { prepareOutputDeliveryPass } = await import('../outputs/runtime')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await db
      .update(workStreams)
      .set({ pause: { reason: 'Test', pausedAt: new Date().toISOString() } as any })
      .where(eq(workStreams.id, streamId))
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await withGitHubOutputPass(async () => {
      for (let i = 0; i < 25; i++) expect(reserveGitHubEvent(crypto.randomUUID())).toBe(true)
      const reads: string[] = []
      setDatabaseQueryObserverForTest((query) => {
        if (query.startsWith('select') && /"fact"(?:,|$)/.test(query.split(' from ')[0]!)) reads.push(query)
      })
      await prepareOutputDeliveryPass()
      expect(reads).toHaveLength(0)
      expect([...(githubOutputPass()!.deliveries?.values() ?? [])].flat()).toHaveLength(0)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
})

test('repeated known renewal in one root pass bounds body reads but rechecks source mutations', async () => {
  const { withGitHubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const id = (await publishIntegrationOutput('github', h.fact(), h.authority))!
    const [proof] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, id))
    await withGitHubOutputPass(async () => {
      let bodies = 0
      setDatabaseQueryObserverForTest((query) => {
        if (
          query.startsWith('select') &&
          /"fact"(?:,|$)/.test(query.split(' from ')[0]!) &&
          query.includes('from "integration_output_events"')
        )
          bodies++
      })
      for (let i = 0; i < 20; i++) await renewal.renewKnownGitHubOutputs([id])
      expect(bodies).toBeLessThanOrEqual(25)
      await db
        .update(integrationOutputEvents)
        .set({ fact: { ...h.fact(), body: 'CHANGED_AFTER_CACHE' } })
        .where(eq(integrationOutputEvents.id, proof!.sourceEventId))
      const { isGitHubOutputAdmitted } = await import('./feedback-routing')
      const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, id))
      expect(await isGitHubOutputAdmitted(db, event!)).toBe(false)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
})

test('exhausted root body budget withholds history before any full event row read', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await withGitHubOutputPass(async () => {
      githubOutputPass()!.bodyRows = 25
      const bodies: string[] = []
      setDatabaseQueryObserverForTest((query) => {
        if (query.startsWith('select') && /"fact"(?:,|$)/.test(query.split(' from ')[0]!)) bodies.push(query)
      })
      expect(await outputDeliveryHistory(streamId)).toHaveLength(0)
      expect(bodies).toHaveLength(0)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
})

test('more than 25 paused delivery heads cannot consume all body slots before source authorization', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await db
      .update(workStreams)
      .set({ pause: { reason: 'Test', pausedAt: new Date().toISOString() } as any })
      .where(eq(workStreams.id, streamId))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    const ids: string[] = []
    for (let i = 0; i < 26; i++) {
      h.native.id = 30 + i
      ids.push((await publishIntegrationOutput('github', h.fact(), h.authority))!)
    }
    await db
      .update(githubOutputProofs)
      .set({ expiresAt: new Date(0) })
      .where(inArray(githubOutputProofs.eventId, ids))
    h.read.mockClear()
    const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
    for (let tick = 0; tick < 4; tick++) {
      h.read.mockClear()
      let bodySelects = 0
      setDatabaseQueryObserverForTest((query) => {
        if (query.startsWith('select') && /"fact"(?:,|$)/.test(query.split(' from ')[0]!)) bodySelects++
      })
      await withGitHubOutputPass(async () => {
        await reconcileFlows()
        expect(githubOutputPass()!.bodyRows).toBeLessThanOrEqual(25)
      })
      setDatabaseQueryObserverForTest(undefined)
      // Every event SELECT in this tick is scalar or a single-ID body read; no hidden batch.
      expect(bodySelects).toBeLessThanOrEqual(25)
      if (tick === 0) expect(h.read.mock.calls.length).toBeGreaterThan(0)
      expect(h.read.mock.calls.length).toBeLessThanOrEqual(24)
    }
    const [tail] = await db
      .select()
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, ids.at(-1)!))
    expect(tail!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect((await h.effects()).inbox).toBe(0)
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
}, 120_000)

test('exhausted candidate WORK stops root selection before revision/source/history queries', async () => {
  const { withGitHubOutputPass, withGitHubCandidate, githubOutputPass } = await import('./feedback-pass')
  const { prepareOutputDeliveryPass, reconcileApprovedGitHubFeedback } = await import('../outputs/runtime')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await withGitHubOutputPass(async () => {
      for (let i = 0; i < 25; i++) await withGitHubCandidate(async () => {}, undefined)
      const queries: string[] = []
      setDatabaseQueryObserverForTest((query) => queries.push(query))
      await prepareOutputDeliveryPass()
      await reconcileApprovedGitHubFeedback()
      await reconcileUnmatchedOutputs()
      expect(await outputDeliveryHistory(streamId)).toEqual([])
      // Only the unchanged non-GitHub history query may run after GitHub exhaustion.
      expect(queries.filter((query) => !query.includes('"integration" <>'))).toEqual([])
      expect(githubOutputPass()!.lookaheadQueries).toBe(0)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
})

test('standalone cache-hit renewal attempts still exhaust root WORK and stop predicate reads', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const id = (await publishIntegrationOutput('github', h.fact(), h.authority))!
    await withGitHubOutputPass(async () => {
      for (let i = 0; i < 25; i++) await renewal.renewKnownGitHubOutputs([id])
      expect(githubOutputPass()!.work).toBe(25)
      const queries: string[] = []
      setDatabaseQueryObserverForTest((query) => queries.push(query))
      expect((await renewal.renewKnownGitHubOutputs([id])).deferred).toEqual([id])
      expect(queries).toEqual([])
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
})

test('root materialization counts reviewed revision images as well as canonical/source event bodies', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await db
      .update(workStreams)
      .set({ pause: { reason: 'Test', pausedAt: new Date().toISOString() } as any })
      .where(eq(workStreams.id, streamId))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    for (let i = 0; i < 9; i++) {
      h.native.id = 50 + i
      await publishIntegrationOutput('github', h.fact(), h.authority)
    }
    const images: string[] = []
    setDatabaseQueryObserverForTest((query) => {
      const projection = query.split(' from ')[0]!
      if (
        (query.startsWith('select') && (projection.includes('"envelope"') || /"fact"(?:,|$)/.test(projection))) ||
        (query.includes('returning') &&
          (query.split('returning')[1]!.includes('"envelope"') || query.split('returning')[1]!.includes('"fact"')))
      )
        images.push(query)
    })
    await withGitHubOutputPass(async () => {
      await reconcileFlows()
      expect(images.length).toBeGreaterThan(0)
      expect(images.length).toBeLessThanOrEqual(25)
      expect(githubOutputPass()!.bodyRows).toBeGreaterThanOrEqual(images.length)
      expect(githubOutputPass()!.work).toBeLessThanOrEqual(25)
      expect(githubOutputPass()!.lookaheadRows).toBeLessThanOrEqual(100)
      expect(githubOutputPass()!.lookaheadQueries).toBeLessThanOrEqual(12)
    })
    expect((await h.effects()).inbox).toBe(0)
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
}, 120_000)

test('ordinary GitHub mail drains charge per message before materializing a bounded page', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const id = (await publishIntegrationOutput('github', h.fact(), h.authority))!
    const [notice] = await db
      .select()
      .from(inbox)
      .where(sql`${inbox.metadata}->>'integrationEventId' = ${id}`)
    expect(notice).toBeDefined()
    const { id: _id, ...copy } = notice!
    await db
      .insert(inbox)
      .values(Array.from({ length: 26 }, () => ({ ...copy, id: crypto.randomUUID(), idempotencyKey: null })))
    const mailboxQueries: string[] = []
    setDatabaseQueryObserverForTest((query) => {
      if (
        query.startsWith('select') &&
        query.split(' from ')[0]!.includes('"content"') &&
        query.includes('from "inbox"') &&
        query.includes('"recipient_type" =')
      )
        mailboxQueries.push(query)
    })
    await withGitHubOutputPass(async () => {
      await deliverInboxMessagesToAgent(h.managerId)
      expect(
        mailboxQueries.every((query) => query.includes('limit') || query.includes('integration_output_events'))
      ).toBe(true)
      expect(githubOutputPass()!.work).toBeGreaterThan(0)
      expect(githubOutputPass()!.work).toBeLessThanOrEqual(25)
      expect(githubOutputPass()!.lookaheadRows).toBeLessThanOrEqual(100)
      expect(githubOutputPass()!.bodyRows).toBeLessThanOrEqual(25)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
}, 120_000)

test('GitHub work exhaustion does not change Linear history behavior', async () => {
  const { withGitHubOutputPass, withGitHubCandidate } = await import('./feedback-pass')
  const h = await fixture()
  try {
    const streamId = await h.stream(true)
    const [event] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'linear',
        sourceKey: crypto.randomUUID(),
        eventKey: crypto.randomUUID(),
        fact: { ...h.fact(), body: 'LINEAR_HISTORY' },
        authority: { kind: 'instance' },
      })
      .returning()
    await db.insert(integrationOutputDeliveries).values({
      eventId: event!.id,
      workStreamId: streamId,
      subscriptionId: 'linear',
      subscription: {
        id: 'linear',
        source: { integration: 'linear', output: 'issue.comment', version: 1 },
        deliver: { to: 'active', whenInactive: 'retain' },
      },
    })
    await withGitHubOutputPass(async () => {
      for (let i = 0; i < 25; i++) await withGitHubCandidate(async () => {}, undefined)
      expect((await outputDeliveryHistory(streamId)).map((row) => row.fact.body)).toContain('LINEAR_HISTORY')
    })
  } finally {
    await h.close()
  }
})

test('reviewed payload caching refreshes decisions and rejects retention edits in the same pass', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const { readFeedbackRevision } = await import('./feedback-pass-read')
  const h = await fixture()
  try {
    await h.trust()
    const eventId = (await publishIntegrationOutput('github', h.fact(), h.authority))!
    const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
    const revisionId = event!.fact.github!.revisionId!
    await withGitHubOutputPass(async () => {
      const original = await readFeedbackRevision(db, revisionId)
      expect(original!.decision).toBe('automatic')
      await db
        .update(githubFeedbackRevisions)
        .set({ decision: 'pending', releaseState: 'held' })
        .where(eq(githubFeedbackRevisions.id, revisionId))
      expect((await readFeedbackRevision(db, revisionId))!.decision).toBe('pending')
      expect(
        await isCurrentIntegrationNotification(
          db,
          h.managerId,
          (await db.select({ id: inbox.id }).from(inbox).where(eq(inbox.recipientId, h.managerId)))[0]!.id
        )
      ).toBe(false)
      await db.update(githubFeedbackRevisions).set({ envelope: null }).where(eq(githubFeedbackRevisions.id, revisionId))
      expect(await readFeedbackRevision(db, revisionId)).toBeUndefined()
      expect(githubOutputPass()!.bodyRows).toBeLessThanOrEqual(25)
    })
  } finally {
    await h.close()
  }
})

test('persisted notification caching rejects edited payload instead of substituting it into acceptance', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const { readOutputInbox } = await import('./feedback-pass-read')
  const h = await fixture()
  try {
    await h.trust()
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [notice] = await db.select({ id: inbox.id }).from(inbox).where(eq(inbox.recipientId, h.managerId))
    await withGitHubOutputPass(async () => {
      expect(await readOutputInbox(db, notice!.id)).toBeDefined()
      expect(await isCurrentIntegrationNotification(db, h.managerId, notice!.id)).toBe(true)
      await db.update(inbox).set({ content: 'UNSEEN_EDIT' }).where(eq(inbox.id, notice!.id))
      expect(await readOutputInbox(db, notice!.id)).toBeUndefined()
      expect(await isCurrentIntegrationNotification(db, h.managerId, notice!.id)).toBe(false)
      expect(githubOutputPass()!.bodyRows).toBeLessThanOrEqual(25)
    })
  } finally {
    await h.close()
  }
})

test('recording repeated GitHub sources charges root WORK before any insert or authority read', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    const fact = h.fact()
    await withGitHubOutputPass(async () => {
      for (let i = 0; i < 25; i++) await recordIntegrationOutput('github', fact, h.authority)
      const queries: string[] = []
      setDatabaseQueryObserverForTest((query) => queries.push(query))
      await expect(recordIntegrationOutput('github', fact, h.authority)).rejects.toThrow('github_output_pass_exhausted')
      expect(queries).toEqual([])
      expect(githubOutputPass()!.work).toBe(25)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await db.delete(integrationOutputEvents).where(sql`${integrationOutputEvents.authority}->>'squadId' = ${h.squadId}`)
    await h.close()
  }
})

test('recording sources reserves every returned logical image and uses only ID RETURNING', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const { reserveOutputBody } = await import('./feedback-pass-read')
  const h = await fixture()
  try {
    await withGitHubOutputPass(async () => {
      const images: string[] = []
      setDatabaseQueryObserverForTest((query) => {
        if (!query.includes('integration_output_events')) return
        if (
          (query.startsWith('select') && /"fact"(?:,|$)/.test(query.split(' from ')[0]!)) ||
          (query.includes('returning') && query.split('returning')[1]!.includes('"fact"'))
        )
          images.push(query)
      })
      const first = await recordIntegrationOutput('github', h.fact(), h.authority)
      expect(first.fact.body).toContain('HELD_SENTINEL')
      const again = await recordIntegrationOutput('github', h.fact(), h.authority)
      expect(again.id).toBe(first.id)
      expect(images).toHaveLength(1)
      expect(githubOutputPass()!.bodyRows).toBe(1)
      while (reserveOutputBody()) {
        /* Exhaust remaining logical body capacity. */
      }
      images.length = 0
      h.native.id++
      await expect(recordIntegrationOutput('github', h.fact(), h.authority)).rejects.toThrow(
        'github_output_pass_exhausted'
      )
      expect(images).toEqual([])
      expect(githubOutputPass()!.bodyRows).toBe(25)
    })
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await db.delete(integrationOutputEvents).where(sql`${integrationOutputEvents.authority}->>'squadId' = ${h.squadId}`)
    await h.close()
  }
})

test('history pagination traverses withheld equal-clock heads without skipping body-deferred records', async () => {
  const runtime = await import('../outputs/runtime')
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const h = await fixture()
  try {
    await h.trust()
    const streamId = await h.stream(true)
    await db
      .update(workStreams)
      .set({ pause: { reason: 'Test', pausedAt: new Date().toISOString() } as any })
      .where(eq(workStreams.id, streamId))
    h.read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path === '/repositories/10'
          ? { id: 10, full_name: 'acme/project' }
          : { ...h.native, id: Number(path.split('/').at(-1)) }) as T
    )
    const ids: string[] = []
    for (let i = 0; i < 26; i++) {
      h.native.id = 500 + i
      ids.push((await publishIntegrationOutput('github', h.fact(), h.authority))!)
    }
    await db
      .update(integrationOutputDeliveries)
      .set({ createdAt: new Date('2026-10-03T00:00:00Z') })
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
    // Only one tail review remains admitted after trust revocation. Held history must not
    // disappear silently merely because every item in the first visible page is filtered.
    const ordered = await db
      .select({ eventId: integrationOutputDeliveries.eventId })
      .from(integrationOutputDeliveries)
      .where(eq(integrationOutputDeliveries.workStreamId, streamId))
      .orderBy(sql`${integrationOutputDeliveries.id} DESC`)
    const tailId = ordered.at(-1)!.eventId
    const [tail] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, tailId))
    const revisionId = tail!.fact.github!.revisionId!
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'pending', releaseState: 'held' })
      .where(eq(githubFeedbackRevisions.id, revisionId))
    await h.allow(revisionId)
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    let cursor: string | undefined
    const seen: string[] = []
    let pages = 0
    do {
      const page = await withGitHubOutputPass(async () => {
        const page = await runtime.outputDeliveryHistoryPage(streamId, { cursor })
        expect(githubOutputPass()!.work).toBeLessThanOrEqual(25)
        expect(githubOutputPass()!.bodyRows).toBeLessThanOrEqual(25)
        expect(githubOutputPass()!.lookaheadQueries).toBeLessThanOrEqual(12)
        return page
      })
      if (pages === 0) {
        expect(page.items).toEqual([])
        expect(page.hasMore).toBe(true)
      }
      seen.push(...page.items.map((item) => item.fact.eventKey))
      if (!page.hasMore) break
      expect(page.nextCursor).toBeDefined()
      expect(page.nextCursor).not.toBe(cursor)
      cursor = page.nextCursor
      pages++
    } while (pages < 10)
    expect(pages).toBeLessThan(10)
    expect(seen).toEqual([revisionId])
    expect((await h.effects()).inbox).toBe(0)
    expect(h.read.mock.calls.length).toBe(52) // original 26 native verifications, no pagination sweeps
    const queries: string[] = []
    setDatabaseQueryObserverForTest((query) => queries.push(query))
    await expect(runtime.outputDeliveryHistoryPage(crypto.randomUUID(), { cursor })).rejects.toThrow(
      'invalid_output_history_cursor'
    )
    expect(queries).toEqual([])
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await h.close()
  }
}, 120_000)

test('production poll runner/plugin/durable cursor publisher holds feedback then releases the original real Agent once', async () => {
  // Isolate the HTTP preload so the singleton's captured transport cannot call a provider
  // or contaminate any other test. No runner/plugin/DB/Agent method is replaced.
  if (process.env.FICUS_TEST_GITHUB_POLL_CHILD !== '1') {
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--preload',
        './src/test-utils/github-poll-http-preload.ts',
        'src/services/integrations/github/feedback-routing.test.ts',
        '--test-name-pattern',
        'production poll runner',
      ],
      { env: { ...process.env, FICUS_TEST_GITHUB_POLL_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' }
    )
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) console.error(out + err)
      else console.info(err.trim().split('\n').slice(-8).join('\n'))
      expect(code).toBe(0)
    } finally {
      child.kill()
      await child.exited
    }
    return
  }
  expect((globalThis as typeof globalThis & { __githubPollHttpFenced?: boolean }).__githubPollHttpFenced).toBe(true)
  const { integrationEventPollingRuntime } = await import('../runtime')
  const { createTestGitHubConnection } = await import('../../../test-utils/github-connection')
  const { integrationEventPollingCursors, integrationEventPollingDispatches } = await import('../../../db')
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  let connection: Awaited<ReturnType<typeof createTestGitHubConnection>> | undefined
  let transport: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
  const resourceKey = () => `${h.squadId}:${connection!.id}:acme/project#3`
  try {
    // Real watch discovery and plugin resolve the encrypted assigned account; only HTTP is fake.
    h.native.id = 100_000 + Math.floor(Math.random() * 100_000_000)
    h.native.html_url = `https://github.com/acme/project/pull/3#issuecomment-${h.native.id}`
    h.read.mockRestore()
    await db.delete(integrationConnectionAssignments).where(eq(integrationConnectionAssignments.squadId, h.squadId))
    connection = await createTestGitHubConnection({ squadId: h.squadId })
    await h.stream(false)
    let comments: (typeof h.native)[] = []
    let serverDate = 'Fri, 02 Oct 2026 09:59:00 GMT'
    const paths: string[] = []
    transport = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer test-access-${connection!.id}`)
      const repo = { id: 10, full_name: 'acme/project' }
      const body =
        path === '/repositories/10' || path === '/repos/acme/project'
          ? repo
          : path === '/repos/acme/project/pulls/3'
            ? {
                id: 20,
                number: 3,
                state: 'open',
                merged: false,
                head: { sha: 'a'.repeat(40) },
                base: { repo },
                user: { id: 9, login: 'parent' },
                title: 'PARENT_SENTINEL',
                body: 'PARENT_BODY_SENTINEL',
              }
            : path === '/repos/acme/project/issues/3'
              ? { id: 20, number: 3, pull_request: {}, title: 'PARENT_SENTINEL' }
              : path === '/repos/acme/project/issues/3/comments'
                ? comments
                : path === `/repos/acme/project/issues/comments/${h.native.id}`
                  ? h.native
                  : path.endsWith('/reviews') || path.endsWith('/comments')
                    ? []
                    : undefined
      if (body === undefined) throw new Error(`Unexpected GitHub HTTP endpoint: ${path}`)
      return Response.json(body, { headers: { date: serverDate } })
    }) as typeof fetch)
    const transportState = globalThis as typeof globalThis & { __githubPollTestHttp?: typeof fetch }
    transportState.__githubPollTestHttp = globalThis.fetch
    const due = async () => {
      await db
        .update(integrationEventPollingCursors)
        .set({ nextPollAt: new Date(0) })
        .where(eq(integrationEventPollingCursors.resourceKey, resourceKey()))
      await integrationEventPollingRuntime.runOnce()
    }
    await integrationEventPollingRuntime.runOnce() // empty baseline, no backfill
    expect(paths).toHaveLength(5)
    expect((await h.effects()).inbox).toBe(0)
    comments = [h.native]
    serverDate = 'Fri, 02 Oct 2026 10:01:00 GMT'
    await due()
    const revisions = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revisions).toHaveLength(1)
    expect(revisions[0]!.decision).toBe('pending')
    expect(revisions[0]!.envelope!.body).toBe(`${h.native.html_url}\n\nHELD_SENTINEL`)
    expect((await h.effects()).inbox).toBe(0)
    const [cursor] = await db
      .select()
      .from(integrationEventPollingCursors)
      .where(eq(integrationEventPollingCursors.resourceKey, resourceKey()))
    expect(cursor!.leaseToken).toBeNull()
    expect(cursor!.cursor!.issueComments).toBeDefined()
    await due() // duplicate scan cannot create a second reviewed version
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(1)
    await h.allow(revisions[0]!.id)
    h.useRealSend()
    await reconcileFlows()
    await reconcileFlows()
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.messageId).toBeTruthy()
    expect(receipts[0]!.executionId).toBeTruthy()
    expect(receipts[0]!.acceptedAt).toBeTruthy()
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(notice!.content).toContain('HELD_SENTINEL')
    expect(notice!.content).not.toContain('PARENT_SENTINEL')
    h.native.body = 'UNAPPROVED_EDIT_SENTINEL'
    h.native.updated_at = '2026-10-02T10:02:00Z'
    serverDate = 'Fri, 02 Oct 2026 10:03:00 GMT'
    await due()
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(2)
    await reconcileFlows()
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    expect(JSON.stringify(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId)))).not.toContain(
      'UNAPPROVED_EDIT_SENTINEL'
    )
    await h.trust() // future trust must NOT replay the held edit
    await reconcileFlows()
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(1)
    // Poll edits lack verified editor identity even when the original author is trusted.
    // A genuinely NEW native comment with an unchanged creation clock is unambiguous.
    h.native.id++
    h.native.html_url = `https://github.com/acme/project/pull/3#issuecomment-${h.native.id}`
    h.native.body = 'TRUSTED_FRESH_FEEDBACK'
    h.native.created_at = '2026-10-02T10:04:00Z'
    h.native.updated_at = h.native.created_at
    serverDate = 'Fri, 02 Oct 2026 10:05:00 GMT'
    await due()
    await reconcileFlows()
    const resumed = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(resumed).toHaveLength(2)
    expect(resumed.every((receipt) => receipt.executionId === receipts[0]!.executionId)).toBe(true)
    expect((await h.effects()).agents).toBe(1)
    await due()
    await reconcileFlows()
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(2)
  } finally {
    delete (globalThis as typeof globalThis & { __githubPollTestHttp?: typeof fetch }).__githubPollTestHttp
    transport?.mockRestore()
    if (connection) {
      // Poll logical-event keys differ from output normalization keys. Delete only dispatches
      // owned by this isolated fixture squad, never all provider dispatch history.
      await db
        .delete(integrationEventPollingDispatches)
        .where(sql`${h.squadId}::uuid = ANY(${integrationEventPollingDispatches.activitySquadIds})`)
      await db
        .delete(integrationEventPollingCursors)
        .where(eq(integrationEventPollingCursors.resourceKey, resourceKey()))
      await db
        .delete(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${connection.id}`)
      await connection.dispose()
    }
    await h.close()
  }
}, 120_000)

test('native webhook refinement charges a new full image and exhausted capacity cannot alter the source', async () => {
  const { withGitHubOutputPass, githubOutputPass } = await import('./feedback-pass')
  const { reserveOutputBody } = await import('./feedback-pass-read')
  const h = await fixture()
  try {
    const native = githubOutputAdapter.normalize({
      type: 'dependabot_alert',
      githubObservation: { kind: 'webhook' },
      payload: {
        action: 'created',
        repository: { id: 10, full_name: 'acme/project' },
        alert: {
          number: 7,
          state: 'open',
          updated_at: '2026-10-02T10:00:00Z',
          dependency: { package: { name: 'widget', ecosystem: 'npm' } },
          security_advisory: { ghsa_id: 'GHSA-abcd-efgh-ijkl', severity: 'high' },
        },
      },
    })[0]!
    const observed = { ...native, data: { ...native.data, action: 'observed' } }
    let sourceId = ''
    await withGitHubOutputPass(async () => {
      sourceId = (await recordIntegrationOutput('github', observed, h.authority)).id
      while (reserveOutputBody()) {
        /* No capacity for a changed immutable source image. */
      }
      const mutations: string[] = []
      setDatabaseQueryObserverForTest((query) => {
        if (query.startsWith('update "integration_output_events"')) mutations.push(query)
      })
      await expect(recordIntegrationOutput('github', native, h.authority)).rejects.toThrow(
        'github_output_pass_exhausted'
      )
      expect(mutations).toEqual([])
    })
    setDatabaseQueryObserverForTest(undefined)
    const [unchanged] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, sourceId))
    expect(unchanged!.fact.data.action).toBe('observed')
    await withGitHubOutputPass(async () => {
      await recordIntegrationOutput('github', observed, h.authority)
      const refined = await recordIntegrationOutput('github', native, h.authority)
      expect(refined.id).toBe(sourceId)
      expect(refined.fact.data.action).toBe('created')
      expect(githubOutputPass()!.bodyRows).toBe(2)
      expect(githubOutputPass()!.work).toBe(2)
    })
    expect(h.read.mock.calls).toHaveLength(0) // recording is not a polling or native-discovery path
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await db.delete(integrationOutputEvents).where(sql`${integrationOutputEvents.authority}->>'squadId' = ${h.squadId}`)
    await h.close()
  }
})

async function grantSquadUpdate(squadId: string, userId: string) {
  const roleId = crypto.randomUUID()
  await db.insert(roles).values({ id: roleId, slug: roleId, name: roleId, permissions: ['squads:update'] })
  await db.insert(roleAssignments).values({ subjectType: 'user', subjectId: userId, roleId, scope: 'squad', squadId })
  return async () => {
    await db.delete(roleAssignments).where(eq(roleAssignments.roleId, roleId))
    await db.delete(roles).where(eq(roles.id, roleId))
  }
}
const filterOf = async (squadId: string) =>
  (await db.select({ enabled: squads.githubAuthorFilter }).from(squads).where(eq(squads.id, squadId)))[0]!.enabled

test('author filter OFF routes an untrusted comment exactly as before: no hold, capture or provider witness', async () => {
  const h = await fixture()
  try {
    expect(await filterOf(h.squadId)).toBe(true) // squads created after rollout default ON
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, h.squadId))
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.metadata).toMatchObject({ source: 'integration-notification', integrationEventId: eventId })
    expect(messages[0]!.content).toContain('HELD_SENTINEL')
    expect(
      await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    ).toHaveLength(0)
    expect(await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.sourceEventId, eventId!))).toEqual([])
    expect(h.read).not.toHaveBeenCalled()
    // Webhook/poll duplicates and retries stay single-delivery.
    expect(await publishIntegrationOutput('github', h.fact(), h.authority)).toBe(eventId)
    await reconcileUnmatchedOutputs()
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(1)
    // Connection authority is still exact when the filter is off.
    await db
      .update(integrationConnections)
      .set({ materialRevision: crypto.randomUUID() })
      .where(eq(integrationConnections.id, h.authority.connectionId))
    expect(await isCurrentIntegrationNotification(db, h.managerId, messages[0]!.id)).toBe(false)
  } finally {
    await h.close()
  }
})

test('only an enabled human with squads:update can switch the author filter; agents and generic updates cannot', async () => {
  const h = await fixture()
  const revoke = { run: async () => {} }
  try {
    const refused: Array<Parameters<typeof setGitHubAuthorFilter>[0]> = [
      { type: 'agent', agentId: h.managerId, squadId: h.squadId, userId: h.userId },
      { type: 'system', systemTokenId: crypto.randomUUID(), name: 'admin', scopes: ['*'] },
      { type: 'legacy' },
      undefined,
      { type: 'user', userId: h.userId }, // human without squads:update in this squad
    ]
    for (const identity of refused)
      await expect(setGitHubAuthorFilter(identity, h.squadId, false)).rejects.toMatchObject({ status: 403 })
    await expect(Squad.update(h.squadId, { githubAuthorFilter: false } as never)).rejects.toThrow(
      'Reserved GitHub author filter'
    )
    expect(await filterOf(h.squadId)).toBe(true)
    revoke.run = await grantSquadUpdate(h.squadId, h.userId)
    expect(await setGitHubAuthorFilter({ type: 'user', userId: h.userId }, h.squadId, false)).toEqual({
      enabled: false,
      released: 0,
    })
    expect(await filterOf(h.squadId)).toBe(false)
    const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, h.squadId))
    const filterAudit = audit.filter((row) => row.action.startsWith('github.author_filter.'))
    expect(filterAudit.filter((row) => row.outcome === 'denied')).toHaveLength(refused.length)
    expect(filterAudit.filter((row) => row.outcome === 'allowed').map((row) => row.actorKey)).toEqual([
      `user:${h.userId}`,
    ])
  } finally {
    await revoke.run()
    await h.close()
  }
})

test('turning the filter OFF releases held events once through normal routing; turning it ON never re-holds them', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  h.useRealSend()
  const revoke = await grantSquadUpdate(h.squadId, h.userId)
  try {
    const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
    expect((await h.effects()).inbox).toBe(0)
    const human = { type: 'user' as const, userId: h.userId }
    expect(await setGitHubAuthorFilter(human, h.squadId, false)).toEqual({ enabled: false, released: 1 })
    const [released] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(released).toMatchObject({ decision: 'allow_once', reason: 'filter_disabled', decidedByUserId: h.userId })
    await reconcileFlows()
    await reconcileFlows()
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))
    expect(receipts).toHaveLength(1)
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('HELD_SENTINEL')
    expect(notices[0]!.metadata?.integrationEventId).not.toBe(eventId) // the reviewed canonical event
    expect(await setGitHubAuthorFilter(human, h.squadId, true)).toEqual({ enabled: true, released: 0 })
    expect(await publishIntegrationOutput('github', h.fact(), h.authority)).toBe(eventId)
    await reconcileFlows()
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(1)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, released!.id))
    expect(after!.decision).toBe('allow_once')
  } finally {
    await revoke()
    await h.close()
  }
})

test('approved held feedback reaches the CURRENT manager when ownership changed while it was held', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const h = await fixture()
  h.useRealSend()
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    const [old] = await db.select().from(agents).where(eq(agents.id, h.managerId))
    const [replacement] = await db
      .insert(agents)
      .values({ squadId: h.squadId, agentTypeId: old!.agentTypeId, name: 'Replacement', status: 'idle' })
      .returning()
    await db.update(squads).set({ managerAgentId: replacement!.id }).where(eq(squads.id, h.squadId))
    await h.allow(held!.id)
    // Shared root budgets may defer acceptance to a later tick; delivery is still exactly once.
    for (let tick = 0; tick < 3; tick++) await reconcileFlows()
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(0)
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, h.managerId))).toHaveLength(0)
    const [notice] = await db.select().from(inbox).where(eq(inbox.recipientId, replacement!.id))
    expect(notice!.content).toContain('HELD_SENTINEL')
    const receipts = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.agentId, replacement!.id))
    expect(receipts).toHaveLength(1)
    // Settled now, or on the next release attempt from the durable receipt; never terminal/dropped.
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
    expect(['delivered', 'retained']).toContain(after!.releaseState)
  } finally {
    await h.close()
  }
})

for (const first of ['off', 'on'] as const)
  test(`switching the filter ${first === 'off' ? 'ON after OFF' : 'OFF after ON'} never delivers one observation twice`, async () => {
    const h = await fixture()
    try {
      if (first === 'off') await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, h.squadId))
      else await h.trust()
      const eventId = await publishIntegrationOutput('github', h.fact(), h.authority)
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(1)
      await db
        .update(squads)
        .set({ githubAuthorFilter: first === 'on' ? false : true })
        .where(eq(squads.id, h.squadId))
      const again = await publishIntegrationOutput('github', h.fact(), h.authority)
      // OFF-first returns the same raw observation; ON-first resolves to its reviewed canonical event.
      if (first === 'off') expect(again).toBe(eventId)
      await reconcileUnmatchedOutputs()
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, h.managerId))).toHaveLength(1)
      if (first === 'off')
        expect(
          await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
        ).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

test('a human deny stays final when the filter is later turned OFF', async () => {
  const { reconcileFlows } = await import('../../workflows/execution')
  const { moderateGitHubFeedback } = await import('./feedback-moderation')
  const h = await fixture()
  const revoke = await grantSquadUpdate(h.squadId, h.userId)
  try {
    await publishIntegrationOutput('github', h.fact(), h.authority)
    const [held] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    const human = { type: 'user' as const, userId: h.userId }
    await moderateGitHubFeedback(human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [{ revisionId: held!.id, contentHash: held!.contentHash, decisionVersion: held!.decisionVersion }],
    })
    expect(await setGitHubAuthorFilter(human, h.squadId, false)).toEqual({ enabled: false, released: 0 })
    await publishIntegrationOutput('github', h.fact(), h.authority)
    await reconcileUnmatchedOutputs()
    await reconcileFlows()
    expect((await h.effects()).inbox).toBe(0)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, held!.id))
    expect(after!.decision).toBe('deny')
  } finally {
    await revoke()
    await h.close()
  }
})
