import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { eq, inArray, like } from 'drizzle-orm'
import {
  WORKFLOW_REVIEW_REVISED_MESSAGE,
  WORKFLOW_REVIEW_REVISIONS_REQUIRED_MESSAGE,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@ficus/shared'
import { brief } from '@ficus/shared/test-fixtures/workflow-review'
import {
  db,
  agents,
  agentTypes,
  inbox,
  squads,
  workStreamFlowRuns,
  workStreamFlowTransitions,
  workStreams,
} from '../db'
import { identityMiddleware } from '../middleware/identity'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  type TestAgentToken,
  type TestUser,
} from '../test-utils/rbac'
import { attachFlow, getFlow } from '../services/workflows/execution'
import { getSettingsStore } from '../services/settings'
import { listOpenWaits } from '../services/work-streams/waits'
import { workflowsRouter } from './workflows'

const app = new Hono().use('*', identityMiddleware).route('/api/workflows', workflowsRouter)
const prefix = `wf-amend-${randomUUID()}`
const profile = `${prefix}-profile`
const originalHome = process.env.HOME_DIR
let home: string
let admin: TestUser
let squadId: string
let bound: TestAgentToken, other: TestAgentToken
let streamId: string
const streams: string[] = []

const definition: WorkflowDefinition = workflowDefinitionSchema.parse({
  schemaVersion: 1,
  name: 'Design with approval',
  participants: { worker: { agentTypeId: profile, session: 'reuse-within-stream' } },
  entry: 'design',
  routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
  limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
  steps: [
    {
      id: 'design',
      participant: 'worker',
      instructions: 'Write the design.',
      output: 'Design.',
      outcomes: { completed: { next: 'approval' } },
    },
    {
      id: 'approval',
      kind: 'human-approval',
      instructions: 'Approve the design.',
      output: 'Decision.',
      outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'design' } },
    },
  ],
  completion: { mode: 'review-approval' },
})

const revisedBrief = {
  ...brief,
  recommendation: 'Approve because the fallback preserves existing reads, and the rollback note is now included.',
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Amend tests' }).returning()
  squadId = squad!.id
  await db.insert(agentTypes).values({
    id: profile,
    name: 'Amend worker',
    model: 'x',
    systemPrompt: 'Test.',
    extraScopes: ['workstreams:respond'],
  })
  const [boundAgent, otherAgent] = await db
    .insert(agents)
    .values([
      { agentTypeId: profile, squadId },
      { agentTypeId: profile, squadId },
    ])
    .returning({ id: agents.id })
  bound = await createTestAgentToken({ agentId: boundAgent!.id, squadId })
  other = await createTestAgentToken({ agentId: otherAgent!.id, squadId })
})
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workflow-amend-route-'))
  process.env.HOME_DIR = home
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  streamId = stream!.id
  streams.push(streamId)
  await db.transaction(async (tx) => {
    await attachFlow(tx, stream!, { kind: 'inline', definition })
  })
  await db
    .update(workStreamFlowRuns)
    .set({ attemptAgents: { '1': bound.agentId } })
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
})
afterEach(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [bound.agentId, other.agentId]))
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
  await rm(home, { recursive: true, force: true })
})
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await db.delete(agents).where(eq(agents.agentTypeId, profile))
  await cleanupTestRbac(prefix)
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', String(10 * 1024 * 1024))
})

function upload(token: string, path: string, content: string, attemptId = 1) {
  const form = new FormData()
  form.append('file', new File([content], path.split('/').pop()!))
  form.append('path', path)
  return app.request(`/api/workflows/runs/${streamId}/attempts/${attemptId}/attachments`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  })
}
function advance(token: string, command: Record<string, unknown>, requestId: string = randomUUID()) {
  return app.request(`/api/workflows/runs/${streamId}/advance`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, command }),
  })
}
async function detail() {
  return (await app.request(`/api/workflows/runs/${streamId}`, { headers: authHeaders(admin.token) })).json()
}
async function version() {
  return (await getFlow(streamId))!.version
}
async function openWaits() {
  return listOpenWaits(db, streamId)
}
/** The design attempt completes with two files and the approval gate opens. */
async function atGate() {
  expect((await upload(bound.token, 'docs/design.md', '# Design v1')).status).toBe(201)
  expect((await upload(bound.token, 'docs/plan.md', '# Plan')).status).toBe(201)
  const response = await advance(bound.token, {
    action: 'complete',
    expectedVersion: await version(),
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Design evidence, commit abc1234.',
    decisionBrief: brief,
  })
  expect(response.status).toBe(200)
  expect((await getFlow(streamId))!.state.attempts[1]).toMatchObject({ stepId: 'approval', status: 'running' })
}
const amendCommand = async (extra: Record<string, unknown> = {}) => ({
  action: 'amend',
  expectedVersion: await version(),
  attemptId: 1,
  evidence: 'Revised design evidence, commit def5678.',
  decisionBrief: revisedBrief,
  ...extra,
})

test('the attempt agent amends while the gate is open; the gate and its wait are untouched', async () => {
  await atGate()
  const waitsBefore = await openWaits()
  const gateBefore = (await getFlow(streamId))!.state.attempts[1]
  const inboxBefore = await db.select().from(inbox).where(eq(inbox.recipientId, bound.agentId))
  // A changed file and a new file are staged for revision 2; an unchanged file keeps its id.
  const changed = await (await upload(bound.token, 'docs/design.md', '# Design v2')).json()
  expect(changed.revision).toBe(2)
  const unchanged = await upload(bound.token, 'docs/plan.md', '# Plan')
  expect(unchanged.status).toBe(200)
  expect((await unchanged.json()).revision).toBe(1)
  const added = await (await upload(bound.token, 'docs/rollback.md', '# Rollback')).json()
  // Staged files are not current until the amend lands.
  expect((await detail()).attachments['1'].map((f: { path: string }) => f.path)).toEqual([
    'docs/design.md',
    'docs/plan.md',
  ])

  const requestId = randomUUID()
  const command = await amendCommand({ attachmentPaths: ['docs/design.md', 'docs/plan.md', 'docs/rollback.md'] })
  const response = await advance(bound.token, command, requestId)
  expect(response.status).toBe(200)
  const result = await response.json()
  // A retry with the same request id returns the same receipt.
  expect(await (await advance(bound.token, command, requestId)).json()).toEqual(result)

  const run = (await getFlow(streamId))!
  expect(run.version).toBe(command.expectedVersion + 1)
  expect(run.state.attempts).toHaveLength(2)
  expect(run.state.attempts[1]).toEqual(gateBefore!)
  expect(await openWaits()).toEqual(waitsBefore)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, bound.agentId))).toHaveLength(inboxBefore.length)
  const receipts = await db
    .select()
    .from(workStreamFlowTransitions)
    .where(eq(workStreamFlowTransitions.workStreamId, streamId))
  expect(receipts.filter((r) => (r.command as { action: string }).action === 'amend')).toHaveLength(1)

  const attempt = run.state.attempts[0]!
  expect(attempt.resultRevision).toBe(2)
  expect(attempt.resultRevisedAt).toEqual(expect.any(String))
  const view = await detail()
  const current = view.attachments['1'] as Array<{ id: string; path: string }>
  expect(current.map((f) => f.path)).toEqual(['docs/design.md', 'docs/plan.md', 'docs/rollback.md'])
  expect(current.map((f) => f.id)).toEqual([changed.id, attempt.attachmentIds![1], added.id])
  // The first revision and its replaced file stay readable and downloadable.
  expect(attempt.earlierResults).toHaveLength(1)
  expect(attempt.earlierResults![0]).toMatchObject({ revision: 1, evidence: 'Design evidence, commit abc1234.' })
  expect(attempt.earlierResults![0]!.decisionBrief!.value).toEqual(brief)
  const earlier = view.earlierAttachments['1'] as Array<{ id: string; path: string }>
  expect(earlier.map((f) => f.path)).toEqual(['docs/design.md'])
  const old = await app.request(`/api/workflows/runs/${streamId}/attachments/${earlier[0]!.id}`, {
    headers: authHeaders(admin.token),
  })
  expect(await old.text()).toBe('# Design v1')
})

test('amend can remove a file of the current revision and refuses an unknown path', async () => {
  await atGate()
  const missing = await advance(bound.token, await amendCommand({ removeAttachmentPaths: ['docs/none.md'] }))
  expect(missing.status).toBe(409)
  expect((await missing.json()).error).toBe("No attachment 'docs/none.md' in revision 1 of attempt 1")
  const response = await advance(bound.token, await amendCommand({ removeAttachmentPaths: ['docs/plan.md'] }))
  expect(response.status).toBe(200)
  const view = await detail()
  expect(view.attachments['1'].map((f: { path: string }) => f.path)).toEqual(['docs/design.md'])
  expect(view.earlierAttachments['1'].map((f: { path: string }) => f.path)).toEqual(['docs/plan.md'])
})

test('amend is refused for another caller, a stale version and a closed gate', async () => {
  await atGate()
  for (const token of [other.token, admin.token]) {
    const response = await advance(token, await amendCommand())
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('Only the agent that completed attempt 1 can amend it.')
  }
  const stale = await advance(bound.token, await amendCommand({ expectedVersion: (await version()) - 1 }))
  expect(stale.status).toBe(409)
  expect((await stale.json()).error).toBe('Stale flow version')
  const wrongAttempt = await advance(bound.token, await amendCommand({ attemptId: 2 }))
  expect(wrongAttempt.status).toBe(403)

  const approve = await advance(admin.token, {
    action: 'complete',
    expectedVersion: await version(),
    attemptId: 2,
    outcome: 'approved',
    evidence: '',
    reviewedRevisions: [{ attemptId: 1, revision: 1 }],
  })
  expect(approve.status).toBe(200)
  const closed = await advance(bound.token, await amendCommand())
  expect(closed.status).toBe(409)
  expect((await closed.json()).error).toBe(
    "Human approval 'approval' is no longer open, so attempt 1 can no longer be amended."
  )
  // Nor can it stage files for a revision that can no longer land.
  expect((await upload(bound.token, 'docs/late.md', 'late')).status).toBe(409)
})

test('a decision on a stale revision is refused with nothing decided; the latest revision is recorded', async () => {
  await atGate()
  expect((await advance(bound.token, await amendCommand())).status).toBe(200)
  const before = await getFlow(streamId)
  const waits = await openWaits()
  const stale = await advance(admin.token, {
    action: 'complete',
    expectedVersion: await version(),
    attemptId: 2,
    outcome: 'approved',
    evidence: 'Looks good.',
    reviewedRevisions: [{ attemptId: 1, revision: 1 }],
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ error: WORKFLOW_REVIEW_REVISED_MESSAGE, code: 'WORKFLOW_REVIEW_REVISED' })
  // A client that names no revisions cannot prove what was read once the work was amended, even at
  // the current version (it may have refetched quietly), so it fails closed.
  for (const expectedVersion of [before!.version - 1, before!.version]) {
    const old = await advance(admin.token, {
      action: 'complete',
      expectedVersion,
      attemptId: 2,
      outcome: 'approved',
      evidence: '',
    })
    expect(old.status).toBe(409)
    expect(await old.json()).toEqual({
      error: WORKFLOW_REVIEW_REVISIONS_REQUIRED_MESSAGE,
      code: 'WORKFLOW_REVIEW_REVISED',
    })
  }
  expect((await getFlow(streamId))!.state).toEqual(before!.state)
  expect(await openWaits()).toEqual(waits)

  const decided = await advance(admin.token, {
    action: 'complete',
    expectedVersion: await version(),
    attemptId: 2,
    outcome: 'changes-requested',
    evidence: 'Use the other cache.',
    reviewedRevisions: [{ attemptId: 1, revision: 2 }],
  })
  expect(decided.status).toBe(200)
  const gate = (await getFlow(streamId))!.state.attempts[1]!
  expect(gate.status).toBe('returned')
  expect(gate.reviewedRevisions).toEqual([{ attemptId: 1, revision: 2 }])
})

test('a decision that names no revisions still works on a gate whose work was never amended', async () => {
  await atGate()
  const response = await advance(admin.token, {
    action: 'complete',
    expectedVersion: await version(),
    attemptId: 2,
    outcome: 'approved',
    evidence: '',
  })
  expect(response.status).toBe(200)
  expect((await getFlow(streamId))!.state.attempts[1]!.reviewedRevisions).toEqual([{ attemptId: 1, revision: 1 }])
})

test('uploading the original bytes again after staging a change keeps the original file', async () => {
  await atGate()
  const original = (await detail()).attachments['1'].find((f: { path: string }) => f.path === 'docs/design.md')
  expect((await upload(bound.token, 'docs/design.md', '# Design v2')).status).toBe(201)
  const restored = await upload(bound.token, 'docs/design.md', '# Design v1')
  expect(restored.status).toBe(200)
  expect((await restored.json()).id).toBe(original.id)
  expect((await advance(bound.token, await amendCommand({ attachmentPaths: ['docs/design.md'] }))).status).toBe(200)
  const current = (await detail()).attachments['1'] as Array<{ id: string; path: string }>
  expect(current.find((f) => f.path === 'docs/design.md')!.id).toBe(original.id)
  const download = await app.request(`/api/workflows/runs/${streamId}/attachments/${original.id}`, {
    headers: authHeaders(admin.token),
  })
  expect(await download.text()).toBe('# Design v1')
})

test('files staged for a refused amend are not published by a later amend that does not name them', async () => {
  await atGate()
  expect((await upload(bound.token, 'docs/stray.md', '# Stray')).status).toBe(201)
  // Refused after the upload: the version is stale.
  const refused = await advance(bound.token, await amendCommand({ expectedVersion: (await version()) - 1 }))
  expect(refused.status).toBe(409)
  expect((await advance(bound.token, await amendCommand())).status).toBe(200)
  expect((await detail()).attachments['1'].map((f: { path: string }) => f.path)).toEqual([
    'docs/design.md',
    'docs/plan.md',
  ])
  // Naming a file that was never uploaded is refused.
  const unknown = await advance(bound.token, await amendCommand({ attachmentPaths: ['docs/never.md'] }))
  expect(unknown.status).toBe(409)
  expect((await unknown.json()).error).toContain("No file was uploaded for 'docs/never.md'")
})
