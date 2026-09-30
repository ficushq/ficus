import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { createBlankWorkflow, type WorkflowDefinition } from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  squads,
  workStreams,
  inbox,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationConnections,
  integrationConnectionAssignments,
} from '../../../db'
import { Agent } from '../../../entities/Agent'
import { attachFlow, dispatchFlow } from '../../workflows/execution'
import type { VerifiedIngressEvent } from '../types'
import type { IntegrationOutputAuthority } from './types'
import { publishIntegrationOutputs } from './runtime'
import { githubOutputAdapter } from './github'
import { changeRequestHeadFromFact, matchStreamBranch } from './delivery-binding'

const prefix = `delivery-binding-${randomUUID()}`
const repository = `${prefix}/repo`
const squadIds: string[] = []
let squadId: string
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>
const instance: IntegrationOutputAuthority = { kind: 'instance' }

function pull(
  number: number,
  options: { head: string; base?: string; headRepository?: string; state?: string; merged?: boolean }
) {
  return {
    id: number * 1000,
    number,
    html_url: `https://github.com/${repository}/pull/${number}`,
    state: options.state ?? 'open',
    merged: options.merged ?? false,
    title: 'Delivery',
    updated_at: new Date().toISOString(),
    user: { login: 'tauagent', type: 'Bot' },
    head: { ref: options.head, sha: 'a'.repeat(40), repo: { full_name: options.headRepository ?? repository } },
    base: { ref: options.base ?? 'main', repo: { full_name: repository } },
  }
}
const sender = { login: 'reviewer', type: 'User' }
const opened = (pr: ReturnType<typeof pull>, action = 'opened'): VerifiedIngressEvent => ({
  type: 'pull_request',
  payload: { action, number: pr.number, pull_request: pr, repository: { full_name: repository }, sender },
  metadata: {},
})
const reviewed = (pr: ReturnType<typeof pull>): VerifiedIngressEvent => ({
  type: 'pull_request_review',
  payload: {
    action: 'submitted',
    pull_request: pr,
    review: {
      id: randomUUID(),
      state: 'changes_requested',
      body: 'Please rename this.',
      submitted_at: new Date().toISOString(),
      html_url: `${pr.html_url}#review`,
      user: sender,
      commit_id: 'a'.repeat(40),
    },
    repository: { full_name: repository },
    sender,
  },
  metadata: {},
})
const commented = (number: number): VerifiedIngressEvent => ({
  type: 'issue_comment',
  payload: {
    action: 'created',
    issue: { number, title: 'Delivery', pull_request: { url: 'x' } },
    comment: {
      id: randomUUID(),
      body: 'One more thing.',
      created_at: new Date().toISOString(),
      html_url: `https://github.com/${repository}/pull/${number}#comment`,
      user: sender,
    },
    repository: { full_name: repository },
    sender,
  },
  metadata: {},
})

async function create(
  branch: string,
  options: {
    squad?: string
    baseBranch?: string
    changeRequest?: number
    mode?: WorkflowDefinition['completion']['mode']
    repository?: string
  } = {}
) {
  const flow = createBlankWorkflow()
  flow.participants.worker!.agentTypeId = prefix
  flow.completion = { mode: options.mode ?? 'pr-merge', followChanges: true }
  return db.transaction(async (tx) => {
    const [stream] = await tx
      .insert(workStreams)
      .values({
        squadId: options.squad ?? squadId,
        title: prefix,
        status: 'active',
        metadata: {
          git: { branch, baseBranch: options.baseBranch ?? 'main' },
          codeHost: {
            integration: 'github',
            repository: options.repository ?? repository,
            ...(options.changeRequest
              ? {
                  changeRequest: {
                    number: options.changeRequest,
                    url: `https://github.com/${repository}/pull/${options.changeRequest}`,
                  },
                }
              : {}),
          },
        },
      })
      .returning()
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    await dispatchFlow(tx, stream!, run, [])
    return stream!.id
  })
}
async function changeRequest(id: string) {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, id))
  return (stream!.metadata as { codeHost?: { changeRequest?: unknown } }).codeHost?.changeRequest
}
async function routed(id: string) {
  const rows = await db
    .select({ subscriptionId: integrationOutputDeliveries.subscriptionId })
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.workStreamId, id))
  return rows.map((row) => row.subscriptionId).sort()
}
const publish = (event: VerifiedIngressEvent, authority: IntegrationOutputAuthority = instance) =>
  publishIntegrationOutputs('github', event, authority)

beforeAll(async () => {
  await db.insert(agentTypes).values({
    id: prefix,
    name: 'Delivery binding fixture worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
  for (const name of [prefix, `${prefix}-other`])
    squadIds.push((await db.insert(squads).values({ name, purpose: 'Delivery binding fixtures' }).returning())[0]!.id)
  squadId = squadIds[0]!
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, queued: true, status: 'queued' })
})
afterAll(async () => {
  send?.mockRestore()
  const owned = await db.select({ id: agents.id }).from(agents).where(inArray(agents.squadId, squadIds))
  if (owned.length)
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        owned.map((row) => row.id)
      )
    )
  await db
    .delete(integrationOutputEvents)
    .where(sql`${integrationOutputEvents.fact}->'data'->>'repository' = ${repository}`)
  await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
  await db.delete(agents).where(inArray(agents.squadId, squadIds))
  await db.delete(squads).where(inArray(squads.id, squadIds))
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
})

describe('pull-request head identity', () => {
  const [fact] = githubOutputAdapter.normalize(opened(pull(5, { head: 'work/x' })))

  test('pull request facts carry the head branch, head repository, and base', () => {
    expect(changeRequestHeadFromFact('github', fact!)).toEqual({
      integration: 'github',
      repository,
      number: 5,
      url: `https://github.com/${repository}/pull/5`,
      headBranch: 'work/x',
      headRepository: repository,
      baseBranch: 'main',
      merged: false,
      state: 'open',
    })
  })

  test('issue comments and facts without a head repository cannot identify a branch', () => {
    expect(changeRequestHeadFromFact('github', githubOutputAdapter.normalize(commented(5))[0]!)).toBeNull()
    const legacy = { ...fact!, data: { ...fact!.data, headRepository: undefined } }
    expect(changeRequestHeadFromFact('github', legacy)).toBeNull()
  })

  test('a stream matches only on integration, repository, branch, and a known base', () => {
    const head = changeRequestHeadFromFact('github', fact!)!
    const metadata = { git: { branch: 'work/x', baseBranch: 'main' }, codeHost: { integration: 'github', repository } }
    expect(matchStreamBranch(metadata, head).kind).toBe('unbound')
    expect(matchStreamBranch({ ...metadata, git: { branch: 'work/x' } }, head).kind).toBe('unbound')
    expect(matchStreamBranch({ ...metadata, git: { branch: 'work/y', baseBranch: 'main' } }, head).kind).toBe('none')
    expect(matchStreamBranch({ ...metadata, git: { branch: 'work/x', baseBranch: 'dev' } }, head).kind).toBe('none')
    expect(
      matchStreamBranch({ ...metadata, codeHost: { integration: 'github', repository: 'other/repo' } }, head).kind
    ).toBe('none')
    expect(
      matchStreamBranch(
        { ...metadata, codeHost: { integration: 'github', repository, changeRequest: { number: 9 } } },
        head
      )
    ).toEqual({ kind: 'bound', number: 9 })
    // The legacy github shape resolves too, so it can bind (canonically) like finish does.
    expect(matchStreamBranch({ git: metadata.git, github: { repo: repository } }, head).kind).toBe('unbound')
  })
})

describe('binding a delivery pull request when it is observed', () => {
  test('an opened pull request binds its stream and the opened event itself is delivered', async () => {
    const id = await create('work/opened')
    await publish(opened(pull(101, { head: 'work/opened' })))
    expect(await changeRequest(id)).toEqual({ number: 101, url: `https://github.com/${repository}/pull/101` })
    expect(await routed(id)).toEqual(['code-host-updated'])
  })

  test('a review arriving before any pull request update binds and is delivered', async () => {
    const id = await create('work/review-first')
    await publish(reviewed(pull(102, { head: 'work/review-first' })))
    expect(await changeRequest(id)).toEqual({ number: 102, url: `https://github.com/${repository}/pull/102` })
    expect(await routed(id)).toEqual(['code-host-reviewed'])
  })

  test('a comment that arrived before the binding is routed once the pull request binds', async () => {
    const id = await create('work/comment-first')
    await publish(commented(103))
    expect(await changeRequest(id)).toBeUndefined()
    expect(await routed(id)).toEqual([])
    const event = opened(pull(103, { head: 'work/comment-first' }))
    await publish(event)
    expect(await changeRequest(id)).toEqual({ number: 103, url: `https://github.com/${repository}/pull/103` })
    expect(await routed(id)).toEqual(['code-host-comment', 'code-host-updated'])
    // Redelivery stays idempotent: one delivery per event and subscription.
    await publish(event)
    expect(await routed(id)).toEqual(['code-host-comment', 'code-host-updated'])
  })

  test('an existing binding is never overwritten by another pull request from the branch', async () => {
    const id = await create('work/manual', { changeRequest: 104 })
    await publish(opened(pull(105, { head: 'work/manual' })))
    expect(await changeRequest(id)).toEqual({ number: 104, url: `https://github.com/${repository}/pull/104` })
    expect(await routed(id)).toEqual([])
  })

  test('fork heads, wrong bases, other repositories, closed-unmerged, and non-PR flows never bind', async () => {
    const fork = await create('work/fork')
    await publish(opened(pull(106, { head: 'work/fork', headRepository: 'someone/fork' })))
    const base = await create('work/base', { baseBranch: 'release' })
    await publish(opened(pull(107, { head: 'work/base' })))
    const elsewhere = await create('work/elsewhere', { repository: `${prefix}/other` })
    await publish(opened(pull(108, { head: 'work/elsewhere' })))
    const closed = await create('work/closed')
    await publish(opened(pull(109, { head: 'work/closed', state: 'closed' }), 'closed'))
    const deliverable = await create('work/deliverable', { mode: 'deliverable' })
    await publish(opened(pull(110, { head: 'work/deliverable' })))
    for (const id of [fork, base, elsewhere, closed, deliverable]) expect(await changeRequest(id)).toBeUndefined()
  })

  test('a merged pull request observed before binding still binds', async () => {
    const id = await create('work/merged')
    await publish(opened(pull(111, { head: 'work/merged', state: 'closed', merged: true }), 'closed'))
    expect(await changeRequest(id)).toEqual({ number: 111, url: `https://github.com/${repository}/pull/111` })
  })

  test('streams on distinct branches each bind their own pull request', async () => {
    const first = await create('work/first')
    const second = await create('work/second')
    await publish(opened(pull(112, { head: 'work/first' })))
    await publish(opened(pull(113, { head: 'work/second' })))
    expect(((await changeRequest(first)) as { number: number }).number).toBe(112)
    expect(((await changeRequest(second)) as { number: number }).number).toBe(113)
  })

  test('two streams claiming the same branch leave the pull request unbound for finish', async () => {
    const first = await create('work/shared')
    const second = await create('work/shared')
    await publish(opened(pull(114, { head: 'work/shared' })))
    expect(await changeRequest(first)).toBeUndefined()
    expect(await changeRequest(second)).toBeUndefined()
  })

  test('polling-shaped synchronize events bind exactly like webhooks', async () => {
    // The poller emits synthetic pull_request events carrying the REST pull object.
    const id = await create('work/polled')
    const event = opened(pull(115, { head: 'work/polled' }), 'synchronize')
    event.metadata = { synthetic: true }
    await publish(event)
    expect(await changeRequest(id)).toEqual({ number: 115, url: `https://github.com/${repository}/pull/115` })
    expect(await routed(id)).toEqual(['code-host-updated'])
  })

  test("a squad's connection never binds another squad's stream on the same branch", async () => {
    const own = await create('work/cross')
    const foreign = await create('work/cross', { squad: squadIds[1] })
    const revision = randomUUID()
    const [connection] = await db
      .insert(integrationConnections)
      .values({
        providerKey: 'github',
        adapterVersion: 1,
        displayName: prefix,
        configuration: {},
        credentialRef: `fixture:${prefix}`,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        materialRevision: revision,
        validatedRevision: revision,
        validationExpiresAt: new Date(Date.now() + 60000),
      })
      .returning()
    try {
      await db
        .insert(integrationConnectionAssignments)
        .values({ squadId, providerKey: 'github', connectionId: connection!.id })
      await publish(opened(pull(116, { head: 'work/cross' })), {
        kind: 'connection',
        connectionId: connection!.id,
        squadId,
      })
      expect(((await changeRequest(own)) as { number: number }).number).toBe(116)
      expect(await changeRequest(foreign)).toBeUndefined()
    } finally {
      await db
        .delete(integrationConnectionAssignments)
        .where(eq(integrationConnectionAssignments.connectionId, connection!.id))
      await db
        .delete(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${connection!.id}`)
      await db.delete(integrationConnections).where(eq(integrationConnections.id, connection!.id))
    }
  })
})
