import { attachFlow } from '../services/workflows/execution'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { eq, like } from 'drizzle-orm'
import { type WorkflowDefinition } from '@ficus/shared'
import { db, agentTypes, squads, workflows, workStreamFlowRuns, workStreams } from '../db'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils/rbac'
import { WorkflowSync } from '../services/config-sync/workflow-sync'
import { workflowsRouter } from './workflows'

const app = new Hono().use('*', identityMiddleware).route('/api/workflows', workflowsRouter)
const prefix = `style-api-${randomUUID()}`
const profile = `${prefix}-profile`
const systemProfile = `${prefix}-system-profile`
let admin: TestUser, reader: TestUser, creator: TestUser, outsider: TestUser
let squadId: string
let definition: WorkflowDefinition
const sync = new WorkflowSync()
function request(path: string, user?: TestUser, method = 'GET', body?: unknown) {
  return app.request(`/api/workflows${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? authHeaders(user.token) : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  reader = await createTestUser({ prefix })
  creator = await createTestUser({ prefix })
  outsider = await createTestUser({ prefix })
  const readRole = await createTestRole({ prefix, permissions: ['workflows:read'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'system' })
  const createRole = await createTestRole({ prefix, permissions: ['workstreams:create'] })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'API tests' }).returning()
  squadId = squad!.id
  await assignRole({ userId: creator.id, roleId: createRole.id, scope: 'squad', squadId })
  definition = sync.parse(
    await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text()
  ).definition
  definition.participants.worker!.agentTypeId = profile
  await db.insert(agentTypes).values([
    { id: profile, name: 'API test worker', model: '', systemPrompt: 'Test.' },
    { id: systemProfile, name: 'API test system runner', model: '', systemPrompt: 'Test.', systemOnly: true },
  ])
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(workflows).where(like(workflows.id, `${prefix}%`))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
})

describe('workflow API authorization and catalog lifecycle', () => {
  test('every catalog endpoint denies unauthenticated and unprivileged users', async () => {
    for (const [path, method, body] of [
      ['', 'GET', undefined],
      ['/missing', 'GET', undefined],
      ['', 'POST', { id: `${prefix}-unauthorized`, definition }],
      ['/missing', 'PUT', { revision: 'old', preset: { id: 'missing', definition } }],
      ['/missing', 'DELETE', { revision: 'old' }],
      ['/missing/disabled', 'POST', { revision: 'old', disabled: true }],
      ['/missing/revert', 'POST', { revision: 'old' }],
      ['/missing/export', 'GET', undefined],
      ['/missing/template-diff', 'GET', undefined],
    ] as const) {
      expect((await request(path, undefined, method, body)).status).toBe(401)
      expect((await request(path, outsider, method, body)).status).toBe(path === '' ? 403 : 404)
    }
    expect((await request('', reader)).status).toBe(200)
    expect((await request('', reader, 'POST', { id: `${prefix}-read-only`, definition })).status).toBe(403)
  })
  test('create, edit, disable, export and delete enforce revisions', async () => {
    const id = `${prefix}-lifecycle`
    const created = await request('', admin, 'POST', { id, definition })
    expect(created.status).toBe(201)
    const first = await created.json()
    expect(first.hasTemplate).toBe(false)
    expect((await request('', admin, 'POST', { id, definition })).status).toBe(409)
    const edited = await request(`/${id}`, admin, 'PUT', {
      revision: first.revision,
      preset: { id, definition, description: 'Updated' },
    })
    expect(edited.status).toBe(200)
    const second = await edited.json()
    expect(second.revision).not.toBe(first.revision)
    expect((await request(`/${id}`, admin, 'DELETE', { revision: first.revision })).status).toBe(409)
    const exported = await request(`/${id}/export`, reader)
    expect(exported.status).toBe(200)
    expect(sync.parse(await exported.text())).toEqual({ id, definition, description: 'Updated' })
    expect((await request(`/${id}/revert`, admin, 'POST', { revision: second.revision })).status).toBe(400)
    const disabled = await request(`/${id}/disabled`, admin, 'POST', { revision: second.revision, disabled: true })
    expect(disabled.status).toBe(200)
    const third = await disabled.json()
    expect(third.disabled).toBe(true)
    expect((await request('/resolve', admin, 'POST', { squadId, source: { kind: 'preset', id } })).status).toBe(400)
    expect((await request(`/${id}`, admin, 'DELETE', { revision: third.revision })).status).toBe(200)
    expect((await request(`/${id}`, admin)).status).toBe(404)
  })
  test('inline preview requires stream-create permission for the target squad, not catalog publishing rights', async () => {
    const payload = { squadId, source: { kind: 'inline', definition } }
    expect((await request('/resolve', undefined, 'POST', payload)).status).toBe(401)
    expect((await request('/resolve', outsider, 'POST', payload)).status).toBe(403)
    expect((await request('/resolve', reader, 'POST', payload)).status).toBe(403)
    const preview = await request('/resolve', creator, 'POST', payload)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ source: { kind: 'inline' }, definition })
    expect((await request('/resolve', creator, 'POST', { ...payload, squadId: randomUUID() })).status).toBe(403)
    expect((await request('/resolve', admin, 'POST', { ...payload, squadId: randomUUID() })).status).toBe(404)
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squadId))).toHaveLength(0)
    expect(
      await db
        .select()
        .from(workStreamFlowRuns)
        .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
        .where(eq(workStreams.squadId, squadId))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(workflows)
        .where(like(workflows.id, `${prefix}%`))
    ).toHaveLength(0)
  })
  test('preset preview checks catalog access and rejects stale revisions and unknown customizations', async () => {
    const id = `${prefix}-preview`
    const created = await request('', admin, 'POST', { id, definition })
    expect(created.status).toBe(201)
    const { revision } = await created.json()
    const payload = { squadId, source: { kind: 'preset', id, revision } }
    expect((await request('/resolve', creator, 'POST', payload)).status).toBe(404)
    expect((await request('/resolve', admin, 'POST', payload)).status).toBe(200)
    expect(
      (await request('/resolve', admin, 'POST', { ...payload, source: { ...payload.source, revision: 'stale' } }))
        .status
    ).toBe(409)
    expect(
      (
        await request('/resolve', admin, 'POST', {
          ...payload,
          source: { ...payload.source, customizations: [{ op: 'remove-step', id: 'unknown' }] },
        })
      ).status
    ).toBe(400)
    const invalid = structuredClone(definition)
    invalid.participants.worker!.agentTypeId = `${prefix}-missing`
    expect((await request('', admin, 'POST', { id: `${prefix}-missing-profile`, definition: invalid })).status).toBe(
      400
    )
  })
})

describe('workflow catalog scopes', () => {
  test('squad-scoped publication is visible only with permission in that squad', async () => {
    const owner = await createTestUser({ prefix })
    const role = await createTestRole({
      prefix,
      permissions: ['workflows:read', 'workflows:create', 'workflows:update', 'workstreams:create'],
    })
    await assignRole({ userId: owner.id, roleId: role.id, scope: 'squad', squadId })
    const id = `${prefix}-scoped`
    const scope = { kind: 'squad', squadId }
    const result = await request('', owner, 'POST', { id, scope, definition })
    expect(result.status).toBe(201)
    const created = await result.json()
    expect((await request(`/${id}`, owner)).status).toBe(200)
    expect((await request(`/${id}`, outsider)).status).toBe(404)
    expect((await request('', outsider)).status).toBe(403)
    expect((await request('', owner, 'POST', { id: `${prefix}-forbidden-global`, definition })).status).toBe(403)
    expect(
      (
        await request(`/${id}`, owner, 'PUT', {
          revision: created.revision,
          preset: { id, scope: { kind: 'instance' }, definition },
        })
      ).status
    ).toBe(400)
    expect((await request('/resolve', owner, 'POST', { squadId, source: { kind: 'preset', id } })).status).toBe(200)
  })
  test('private presets cannot be read or mutated by another user, including through exports', async () => {
    const id = `${prefix}-private`
    expect(
      (await request('', admin, 'POST', { id, scope: { kind: 'user', userId: admin.id }, definition })).status
    ).toBe(201)
    expect((await request(`/${id}`, admin)).status).toBe(200)
    expect((await request(`/${id}`, reader)).status).toBe(404)
    expect((await request(`/${id}/export`, reader)).status).toBe(404)
    const list = (await (await request('', reader)).json()) as Array<{ id: string }>
    expect(list.some((entry) => entry.id === id)).toBe(false)
    expect((await request('/resolve', creator, 'POST', { squadId, source: { kind: 'preset', id } })).status).toBe(404)
  })
})

test('catalog preview rejects profiles with a dedicated non-worker runner', async () => {
  const invalid = structuredClone(definition)
  invalid.participants.worker!.agentTypeId = systemProfile
  const response = await request('/resolve', admin, 'POST', {
    squadId,
    source: { kind: 'inline', definition: invalid },
  })
  expect(response.status).toBe(400)
  expect((await response.json()).error).toContain('worker agent type')
})

test('reviewer directory requires squad read access and exposes only eligible reviewers', async () => {
  expect((await request(`/reviewers?squadId=${squadId}`)).status).toBe(401)
  expect((await request(`/reviewers?squadId=${squadId}`, outsider)).status).toBe(403)
  const eligible = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['workstreams:read', 'workstreams:review'] })
  await assignRole({ userId: eligible.id, roleId: role.id, scope: 'squad', squadId })
  const response = await request(`/reviewers?squadId=${squadId}`, eligible)
  expect(response.status).toBe(200)
  const people = (await response.json()) as Array<{ id: string; name: string }>
  expect(people.some((person) => person.id === eligible.id)).toBe(true)
  expect(people.some((person) => person.id === outsider.id)).toBe(false)
  expect(people.find((person) => person.id === eligible.id)).not.toHaveProperty('email')
})

test('delivery guidance arrives on completion-ready advance/read and disappears after completion', async () => {
  await db.update(agentTypes).set({ model: 'anthropic:claude-sonnet-4-5' }).where(eq(agentTypes.id, profile))
  const flow = structuredClone(definition)
  flow.steps = [
    {
      id: 'approve',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Check the result.',
      output: 'A verdict.',
      outcomes: { approved: { next: 'finish' } },
    },
  ]
  flow.entry = 'approve'
  flow.completion.mode = 'pr-merge'
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: `${prefix}-delivery` })
    .returning()
  try {
    await db.transaction(async (tx) => {
      await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    })
    const initial = await request(`/runs/${stream!.id}`, admin)
    expect(initial.status).toBe(200)
    expect(await initial.json()).not.toHaveProperty('deliveryInstructions')
    const payload = {
      requestId: randomUUID(),
      command: { expectedVersion: 0, attemptId: 1, action: 'complete', outcome: 'approved', evidence: 'Reviewed.' },
    }
    const response = await request(`/runs/${stream!.id}/advance`, admin, 'POST', payload)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.stateStatus).toBe('completion-ready')
    expect(result.deliveryInstructions).toContain('Leave merging to the human')
    expect(result.deliveryInstructions).toContain(`ficus workstream finish ${stream!.id} --version 1`)
    // The completion-ready self-check names the current binding state and the exact repair.
    expect(result.deliveryInstructions).toContain('codeHost is not configured for this work stream')
    expect(result.deliveryInstructions).toContain(
      `ficus workstream set-meta ${stream!.id} codeHost '{"integration":"github","repository":"<owner/repo>"}'`
    )
    expect((await (await request(`/runs/${stream!.id}`, admin)).json()).deliveryInstructions).toBe(
      result.deliveryInstructions
    )
    // With the PR bound, the self-check reports the bound delivery pull request instead.
    await db
      .update(workStreams)
      .set({
        metadata: {
          codeHost: {
            integration: 'github',
            repository: 'example/repo',
            changeRequest: { number: 42, url: 'https://github.com/example/repo/pull/42' },
          },
        },
      })
      .where(eq(workStreams.id, stream!.id))
    const bound = await (await request(`/runs/${stream!.id}`, admin)).json()
    expect(bound.deliveryInstructions).toContain('bound to example/repo#42')
    expect(bound.deliveryInstructions).toContain('(https://github.com/example/repo/pull/42)')
    expect(bound.deliveryInstructions).toContain(`ficus workstream finish ${stream!.id}`)
    expect(bound.deliveryInstructions).not.toContain('codeHost.changeRequest is absent')
    // With integration/repository but no PR, the exact bind command carries this stream's id.
    await db
      .update(workStreams)
      .set({
        metadata: {
          codeHost: { integration: 'github', repository: 'example/repo' },
          git: { branch: 'work/example' },
        },
      })
      .where(eq(workStreams.id, stream!.id))
    const unbound = await (await request(`/runs/${stream!.id}`, admin)).json()
    expect(unbound.deliveryInstructions).toContain('codeHost.changeRequest is absent')
    expect(unbound.deliveryInstructions).toContain(
      `ficus workstream set-meta ${stream!.id} codeHost.changeRequest '{"number":<pr-number>,"url":"<pr-url>"}'`
    )
    expect(unbound.deliveryInstructions).toContain("stream's branch work/example")
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream!.id))
    expect(await (await request(`/runs/${stream!.id}`, admin)).json()).not.toHaveProperty('deliveryInstructions')
    const replay = await request(`/runs/${stream!.id}/advance`, admin, 'POST', payload)
    expect(replay.status).toBe(200)
    expect(await replay.json()).not.toHaveProperty('deliveryInstructions')
  } finally {
    await db.delete(workStreams).where(eq(workStreams.id, stream!.id))
  }
})

test('deliverable auto-completion explicitly reports done instead of sending the agent back to finish', async () => {
  await db.update(agentTypes).set({ model: 'anthropic:claude-sonnet-4-5' }).where(eq(agentTypes.id, profile))
  const flow = structuredClone(definition)
  flow.steps = [
    {
      id: 'approve',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Check the result.',
      output: 'A verdict.',
      outcomes: { approved: { next: 'finish' } },
    },
  ]
  flow.entry = 'approve'
  flow.completion.mode = 'deliverable'
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: `${prefix}-delivery` })
    .returning()
  try {
    await db.transaction(async (tx) => {
      await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    })
    const initial = await request(`/runs/${stream!.id}`, admin)
    expect(initial.status).toBe(200)
    expect(await initial.json()).not.toHaveProperty('deliveryInstructions')
    const payload = {
      requestId: randomUUID(),
      command: { expectedVersion: 0, attemptId: 1, action: 'complete', outcome: 'approved', evidence: 'Reviewed.' },
    }
    const response = await request(`/runs/${stream!.id}/advance`, admin, 'POST', payload)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.stateStatus).toBe('completion-ready')
    expect(result.workStreamStatus).toBe('done')
    expect(result).not.toHaveProperty('deliveryInstructions')
    const current = await (await request(`/runs/${stream!.id}`, admin)).json()
    expect(current.workStreamStatus).toBe('done')
    const replay = await (await request(`/runs/${stream!.id}/advance`, admin, 'POST', payload)).json()
    expect(replay.workStreamStatus).toBe('done')
    expect(replay).not.toHaveProperty('deliveryInstructions')
  } finally {
    await db.delete(workStreams).where(eq(workStreams.id, stream!.id))
  }
})

test('flow inspection exposes effective active outcomes separately from the initial human brief', async () => {
  const flow = structuredClone(definition)
  flow.steps = [
    {
      id: 'approval',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Original instructions',
      output: 'Original verdict',
      outcomes: { approved: { next: 'finish' } },
    },
  ]
  flow.entry = 'approval'
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  try {
    await db.transaction(async (tx) => {
      await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    })
    const response = await request(`/runs/${stream!.id}/advance`, admin, 'POST', {
      requestId: randomUUID(),
      command: {
        action: 'revise',
        expectedVersion: 0,
        attemptId: 1,
        active: 'keep',
        reason: 'New human verdict',
        operations: [
          {
            op: 'put-step',
            step: { ...flow.steps[0]!, instructions: 'Future brief', outcomes: { accepted: { next: 'finish' } } },
          },
        ],
      },
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    const inspected = await (await request(`/runs/${stream!.id}`, admin)).json()
    expect(inspected.activeOutcomes).toEqual(result.outcomeUpdates)
    expect(inspected.activeOutcomes).toEqual([
      { attemptId: 1, stepId: 'approval', agentId: null, version: 1, outcomes: { accepted: { next: 'finish' } } },
    ])
    expect(inspected.state.attempts[0].step).toEqual(flow.steps[0])
  } finally {
    await db.delete(workStreams).where(eq(workStreams.id, stream!.id))
  }
})

test('saving a preset with decision steps says when no decision model will answer them', async () => {
  const { decisionChain } = await import('../services/decisions/service')
  const decide: WorkflowDefinition = {
    ...definition,
    name: 'Decide',
    participants: {},
    entry: 'triage',
    steps: [
      {
        id: 'triage',
        kind: 'decision',
        instructions: 'Is it a bug?',
        questions: { is_bug: { type: 'yesno', instructions: 'It reports a bug.' } },
        routes: [{ when: { type: 'yesno', question: 'is_bug', op: 'at-least', probability: 0.7 }, outcome: 'done' }],
        otherwise: 'done',
        unavailable: 'done',
        outcomes: { done: { next: 'finish' } },
      },
    ],
  } as unknown as WorkflowDefinition
  const response = await request('', admin, 'POST', { id: `${prefix}-decide`, definition: decide })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { warnings?: string[] }
  if (decisionChain('workflow-steps').length) expect(body.warnings).toBeUndefined()
  else expect(body.warnings).toEqual([expect.stringContaining("decision step 'triage' will not be asked")])

  // Flows without decision steps never warn.
  const plain = await request('', admin, 'POST', { id: `${prefix}-plain`, definition })
  expect(((await plain.json()) as { warnings?: string[] }).warnings).toBeUndefined()
})
