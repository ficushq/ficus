import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { eq, like } from 'drizzle-orm'
import { WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT, type WorkflowDefinition } from '@ficus/shared'
import { db, agents, agentTypes, squads, workflowAttemptAttachments, workStreamFlowRuns, workStreams } from '../db'
import { identityMiddleware } from '../middleware/identity'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestAgentToken,
  type TestUser,
} from '../test-utils/rbac'
import { WorkflowSync } from '../services/config-sync/workflow-sync'
import { attachFlow } from '../services/workflows/execution'
import { workflowAttachmentBlobPath } from '../services/attachments/blob-storage'
import { getSettingsStore } from '../services/settings'
import { workflowsRouter } from './workflows'

const app = new Hono().use('*', identityMiddleware).route('/api/workflows', workflowsRouter)
const prefix = `wf-attach-${randomUUID()}`
const profile = `${prefix}-profile`
const originalHome = process.env.HOME_DIR
let home: string
let admin: TestUser, outsider: TestUser
let squadId: string
let definition: WorkflowDefinition
let bound: TestAgentToken, other: TestAgentToken
let streamId: string

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  outsider = await createTestUser({ prefix })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Attachment tests' }).returning()
  squadId = squad!.id
  definition = new WorkflowSync().parse(
    await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text()
  ).definition
  definition.participants.worker!.agentTypeId = profile
  await db.insert(agentTypes).values({ id: profile, name: 'Attachment worker', model: 'x', systemPrompt: 'Test.' })
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
  home = await mkdtemp(join(tmpdir(), 'workflow-attachments-route-'))
  process.env.HOME_DIR = home
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  streamId = stream!.id
  await db.transaction(async (tx) => {
    await attachFlow(tx, stream!, { kind: 'inline', definition })
  })
  // Attempt 1 is the entry agent step, bound to `bound`.
  await db
    .update(workStreamFlowRuns)
    .set({ attemptAgents: { '1': bound.agentId } })
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
})
afterEach(async () => {
  await db.delete(workStreams).where(eq(workStreams.id, streamId))
  await rm(home, { recursive: true, force: true })
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', String(10 * 1024 * 1024))
})
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await db.delete(agents).where(eq(agents.agentTypeId, profile))
  await cleanupTestRbac(prefix)
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
})

function upload(
  token: string | undefined,
  { name = 'design.md', content = '# Design\n\nThe plan.', path, attemptId = 1 } = {} as {
    name?: string
    content?: string
    path?: string
    attemptId?: number
  }
) {
  const form = new FormData()
  form.append('file', new File([content], name, { type: 'text/html' }))
  if (path !== undefined) form.append('path', path)
  return app.request(`/api/workflows/runs/${streamId}/attempts/${attemptId}/attachments`, {
    method: 'POST',
    headers: token ? authHeaders(token) : {},
    body: form,
  })
}
function get(path: string, token?: string) {
  return app.request(`/api/workflows/runs/${streamId}${path}`, { headers: token ? authHeaders(token) : {} })
}
async function rows() {
  return db.select().from(workflowAttemptAttachments).where(eq(workflowAttemptAttachments.workStreamId, streamId))
}

test('only the agent bound to an open attempt can attach files, and the snapshot is stored', async () => {
  expect((await upload(undefined)).status).toBe(401)
  expect((await upload(other.token)).status).toBe(403)
  expect((await upload(admin.token)).status).toBe(403)
  expect((await upload(bound.token, { attemptId: 99 })).status).toBe(404)
  expect(await rows()).toEqual([])

  const response = await upload(bound.token, { path: 'docs/design.md' })
  expect(response.status).toBe(201)
  const attachment = await response.json()
  expect(attachment).toEqual({
    id: expect.any(String),
    attemptId: 1,
    filename: 'design.md',
    path: 'docs/design.md',
    // Derived from the name, never the client's declared type.
    contentType: 'text/markdown',
    byteSize: 19,
    createdAt: expect.any(String),
  })
  const [row] = await rows()
  expect(row).toMatchObject({ attemptId: 1, uploadedByAgentId: bound.agentId })
  expect(row!.storagePath).toBe(workflowAttachmentBlobPath(streamId, attachment.id))
  expect(await readFile(row!.storagePath, 'utf8')).toBe('# Design\n\nThe plan.')
})

test('a closed attempt, an empty file, an oversized file and an eleventh file are rejected', async () => {
  expect((await upload(bound.token, { content: '' })).status).toBe(400)
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', '8')
  const tooLarge = await upload(bound.token, { content: '0123456789' })
  expect(tooLarge.status).toBe(413)
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', String(10 * 1024 * 1024))
  expect(await rows()).toEqual([])

  for (let index = 0; index < WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT; index++)
    expect((await upload(bound.token, { name: `note-${index}.txt`, content: `note ${index}` })).status).toBe(201)
  const eleventh = await upload(bound.token, { name: 'one-more.txt' })
  expect(eleventh.status).toBe(409)
  expect((await eleventh.json()).error).toContain(`at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT}`)
  expect(await rows()).toHaveLength(WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)

  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
  run!.state.attempts[0]!.status = 'completed'
  await db.update(workStreamFlowRuns).set({ state: run!.state }).where(eq(workStreamFlowRuns.workStreamId, streamId))
  const closed = await upload(bound.token, { name: 'late.md' })
  expect(closed.status).toBe(409)
  expect((await closed.json()).error).toBe('This attempt is no longer open')
})

test('the run detail lists attachments per attempt, and reading one streams verified bytes safely', async () => {
  const html = await (
    await upload(bound.token, { name: 'mock.html', content: '<script>alert(1)</script>', path: 'out/mock.html' })
  ).json()
  const doc = await (await upload(bound.token, { path: 'docs/design.md' })).json()

  const detail = await (await get('', admin.token)).json()
  expect(detail.attachments).toEqual({ '1': [html, doc] })
  expect(html.contentType).toBe('application/octet-stream')

  expect((await get(`/attachments/${doc.id}`)).status).toBe(401)
  expect((await get(`/attachments/${doc.id}`, outsider.token)).status).toBe(403)
  expect((await get(`/attachments/${randomUUID()}`, admin.token)).status).toBe(404)
  expect((await get('/attachments/not-a-uuid', admin.token)).status).toBe(404)

  const read = await get(`/attachments/${doc.id}`, admin.token)
  expect(read.status).toBe(200)
  expect(await read.text()).toBe('# Design\n\nThe plan.')
  expect(read.headers.get('content-type')).toBe('text/markdown')
  expect(read.headers.get('x-content-type-options')).toBe('nosniff')
  expect(read.headers.get('content-disposition')).toBe(`attachment; filename="design.md"; filename*=UTF-8''design.md`)
  const risky = await get(`/attachments/${html.id}`, admin.token)
  expect(risky.headers.get('content-type')).toBe('application/octet-stream')
  expect(risky.headers.get('content-disposition')).toStartWith('attachment;')

  // Bytes that no longer match the recorded digest are refused, not served.
  await writeFile(workflowAttachmentBlobPath(streamId, doc.id), '# Dezign\n\nThe plan.')
  const corrupt = await get(`/attachments/${doc.id}`, admin.token)
  expect(corrupt.status).toBe(409)
  expect(await corrupt.json()).toEqual({ error: 'Attachment unavailable' })
})

test('attachments of another work stream are not readable through this one', async () => {
  const doc = await (await upload(bound.token)).json()
  const [elsewhere] = await db
    .insert(workStreams)
    .values({ squadId, title: `${prefix}-other` })
    .returning()
  try {
    const response = await app.request(`/api/workflows/runs/${elsewhere!.id}/attachments/${doc.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(404)
  } finally {
    await db.delete(workStreams).where(eq(workStreams.id, elsewhere!.id))
  }
})
