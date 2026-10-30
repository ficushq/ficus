import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT, type WorkflowDefinition } from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  squads,
  workflowAttemptAttachments,
  workStreamFlowRuns,
  workStreams,
  worktreeCleanupJobs,
} from '../db'
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
import { workflowAttachmentBlobPath, workflowAttachmentDirectory } from '../services/attachments/blob-storage'
import { getSettingsStore } from '../services/settings'
import { downloadDisposition } from '../services/attachments/http'
import { attachmentStore } from '../services/amtp/adapters'
import { AgentFileAttachment } from '../entities/AgentFileAttachment'
import { InboxAttachment } from '../entities/InboxAttachment'
import { WorkStream } from '../entities/WorkStream'
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
const streams: string[] = []
/** A fresh active stream whose entry agent step (attempt 1) is bound to `bound`; it becomes `streamId`. */
async function startRun() {
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
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workflow-attachments-route-'))
  process.env.HOME_DIR = home
  await startRun()
})
afterEach(async () => {
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
  await rm(home, { recursive: true, force: true })
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', String(10 * 1024 * 1024))
  await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', String(10 * 1024 * 1024 * 1024))
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
/** The blob files on disk for the current stream, which must always match its rows. */
async function blobs() {
  return (await readdir(workflowAttachmentDirectory(streamId)).catch(() => [] as string[])).sort()
}
async function rowIds() {
  return (await rows()).map((row) => row.id).sort()
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
    revision: 1,
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
  // Refused uploads leave no bytes behind.
  expect(await blobs()).toEqual(await rowIds())
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

test('re-uploading a path is idempotent, and changed content replaces the file without using a slot', async () => {
  const first = await upload(bound.token, { path: 'docs/design.md' })
  expect(first.status).toBe(201)
  const original = await first.json()
  const retry = await upload(bound.token, { path: 'docs/design.md' })
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual(original)
  expect(await rows()).toHaveLength(1)
  expect(await blobs()).toEqual([original.id])

  const changed = await upload(bound.token, { path: 'docs/design.md', content: '# Design v2\n\nThe new plan.' })
  expect(changed.status).toBe(201)
  const replacement = await changed.json()
  expect(replacement.id).not.toBe(original.id)
  expect(replacement.byteSize).toBe(26)
  // A replacement keeps the original's place among the attempt's files.
  expect(replacement.createdAt).toBe(original.createdAt)
  expect(await blobs()).toEqual([replacement.id])
  const [row] = await rows()
  expect(row!.id).toBe(replacement.id)
  expect(await readFile(row!.storagePath, 'utf8')).toBe('# Design v2\n\nThe new plan.')
  // The replaced bytes are gone, and its id no longer resolves.
  expect(await Bun.file(workflowAttachmentBlobPath(streamId, original.id)).exists()).toBe(false)
  expect((await get(`/attachments/${original.id}`, admin.token)).status).toBe(404)
})

test('a full attempt still accepts retries and replacements of its existing paths, but no new path', async () => {
  for (let index = 0; index < WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT; index++)
    expect((await upload(bound.token, { name: `note-${index}.txt`, content: `note ${index}` })).status).toBe(201)
  expect((await upload(bound.token, { name: 'note-3.txt', content: 'note 3' })).status).toBe(200)
  expect((await upload(bound.token, { name: 'note-4.txt', content: 'note 4, revised' })).status).toBe(201)
  expect((await upload(bound.token, { name: 'note-new.txt' })).status).toBe(409)
  expect(await rows()).toHaveLength(WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
})

test('a path with control characters is refused', async () => {
  for (const path of ['docs/a\u0000b.md', 'docs/a\nb.md', 'docs/\u007f.md']) {
    const response = await upload(bound.token, { path })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('Attachment path contains control characters')
  }
  expect(await rows()).toEqual([])
})

test('a paused or finished work stream accepts no attachments, as it accepts no handoff', async () => {
  await db
    .update(workStreams)
    .set({ pause: { id: randomUUID(), pausedAt: new Date().toISOString(), reason: null, parkAt: null, agentIds: [] } })
    .where(eq(workStreams.id, streamId))
  const paused = await upload(bound.token)
  expect(paused.status).toBe(409)
  expect((await paused.json()).error).toBe('Work stream is paused; resume before advancing')
  await db.update(workStreams).set({ pause: null, status: 'done' }).where(eq(workStreams.id, streamId))
  const done = await upload(bound.token)
  expect(done.status).toBe(409)
  expect((await done.json()).error).toBe('Stream is terminal')
  expect(await rows()).toEqual([])
})

test('an upload takes the squad and stream locks before the run lock, as completion does', async () => {
  // Hold what advanceFlow holds before it reaches for the run row, then reach for the run row.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let streamLocked!: () => void
  const locked = new Promise<void>((resolve) => (streamLocked = resolve))
  const completion = db.transaction(async (tx) => {
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId)).for('update')
    await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    streamLocked()
    await held
    await tx
      .select({ id: workStreamFlowRuns.workStreamId })
      .from(workStreamFlowRuns)
      .where(eq(workStreamFlowRuns.workStreamId, streamId))
      .for('update')
  })
  await locked
  const uploading = upload(bound.token)
  // Readiness boundary: the upload is parked on a row lock held by the completion.
  const deadline = Date.now() + 10_000
  for (;;) {
    const [{ waiting }] = (await db.execute(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )) as unknown as Array<{ waiting: number }>
    if (waiting > 0) break
    if (Date.now() > deadline) throw new Error('upload never waited on the completion lock')
    await Bun.sleep(10)
  }
  const writtenBeforeLocks = await blobs()
  release()
  // Taking the run row after the stream lock must not deadlock against the waiting upload.
  await completion
  expect((await uploading).status).toBe(201)
  // The bytes were written before the upload queued for locks, so no lock is held during file I/O.
  expect(writtenBeforeLocks).toEqual(await rowIds())
})

test('missing bytes read as unavailable, and download names are header-safe', async () => {
  const doc = await (await upload(bound.token, { name: "résumé's plan.md" })).json()
  const read = await get(`/attachments/${doc.id}`, admin.token)
  expect(read.status).toBe(200)
  expect(read.headers.get('content-disposition')).toBe(
    `attachment; filename="r_sum__s_plan.md"; filename*=UTF-8''r%C3%A9sum%C3%A9's%20plan.md`
  )
  // Quotes and line breaks never reach the header unencoded.
  expect(downloadDisposition('a"b\r\nc.md')).toBe(`attachment; filename="a_b__c.md"; filename*=UTF-8''a%22b%0D%0Ac.md`)
  await rm(workflowAttachmentBlobPath(streamId, doc.id))
  const missing = await get(`/attachments/${doc.id}`, admin.token)
  expect(missing.status).toBe(409)
  expect(await missing.json()).toEqual({ error: 'Attachment unavailable' })
})

test('handoff files count toward the instance attachment quota, replacements by their size change', async () => {
  const base = await AgentFileAttachment.totalStorageBytes()
  await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', String(base + 30))
  expect((await upload(bound.token, { path: 'docs/design.md' })).status).toBe(201) // 19 bytes: base + 19
  const over = await upload(bound.token, { name: 'more.txt', content: 'x'.repeat(12) }) // would be base + 31
  expect(over.status).toBe(400)
  expect(await over.json()).toEqual({ error: 'INBOX_STORAGE_QUOTA_EXCEEDED' })
  expect(await blobs()).toEqual(await rowIds())
  // 26 new bytes replace 19: base + 26 fits, though base + 19 + 26 would not.
  const replaced = await upload(bound.token, { path: 'docs/design.md', content: '# Design v2\n\nThe new plan.' })
  expect(replaced.status).toBe(201)
  // Sending the stored bytes again is free.
  expect((await upload(bound.token, { path: 'docs/design.md', content: '# Design v2\n\nThe new plan.' })).status).toBe(
    200
  )
  expect(await rows()).toHaveLength(1)
})

test('chat-file, inbox and federation quota checks all see handoff file bytes', async () => {
  const before = await Promise.all([
    AgentFileAttachment.totalStorageBytes(),
    InboxAttachment.totalStorageBytes(),
    attachmentStore.totalStoredBytes(),
  ])
  expect((await upload(bound.token)).status).toBe(201)
  const after = await Promise.all([
    AgentFileAttachment.totalStorageBytes(),
    InboxAttachment.totalStorageBytes(),
    attachmentStore.totalStoredBytes(),
  ])
  expect(after.map((total, index) => total - before[index]!)).toEqual([19, 19, 19])
  // And one total serves all three, so they agree.
  expect(new Set(after).size).toBe(1)
})

test('deleting a work stream removes its handoff files and their directory', async () => {
  const first = await (await upload(bound.token, { path: 'docs/design.md' })).json()
  const second = await (await upload(bound.token, { name: 'notes.txt', content: 'notes' })).json()
  const directory = dirname(workflowAttachmentBlobPath(streamId, first.id))
  expect((await readdir(directory)).sort()).toEqual([first.id, second.id].sort())
  // The directory belongs to the stream: anything else in it goes too.
  await writeFile(join(directory, 'stray'), 'left by an interrupted upload')
  await (await WorkStream.mustFind(streamId)).delete()
  expect(await rows()).toEqual([])
  expect(await Bun.file(directory).exists()).toBe(false)
  expect(await readdir(dirname(directory))).toEqual([])
})

test('a work stream delete that rolls back keeps its handoff files', async () => {
  const doc = await (await upload(bound.token)).json()
  // A worktree removal in flight refuses the delete inside its transaction.
  await db.insert(worktreeCleanupJobs).values({ workStreamId: streamId, status: 'removing' })
  await expect((await WorkStream.mustFind(streamId)).delete()).rejects.toThrow('Worktree cleanup removal')
  expect(await rows()).toHaveLength(1)
  expect(await readFile(workflowAttachmentBlobPath(streamId, doc.id), 'utf8')).toBe('# Design\n\nThe plan.')
  await db.delete(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
})

test('a handoff file that cannot be removed does not fail the work stream delete', async () => {
  const doc = await (await upload(bound.token)).json()
  const directory = dirname(workflowAttachmentBlobPath(streamId, doc.id))
  await chmod(directory, 0o500)
  try {
    await (await WorkStream.mustFind(streamId)).delete()
    expect(await WorkStream.find(streamId)).toBeNull()
    // The bytes stay behind (logged), and the delete still committed.
    expect(await readdir(directory)).toEqual([doc.id])
  } finally {
    await chmod(directory, 0o700)
  }
})

test('replacing a file keeps its tab position among the attempt files', async () => {
  const design = await (await upload(bound.token, { path: 'docs/design.md' })).json()
  const notes = await (await upload(bound.token, { name: 'notes.txt', content: 'notes' })).json()
  const replaced = await (await upload(bound.token, { path: 'docs/design.md', content: '# Design v2' })).json()
  const detail = await (await get('', admin.token)).json()
  expect(detail.attachments['1'].map((file: { id: string }) => file.id)).toEqual([replaced.id, notes.id])
  expect(replaced.createdAt).toBe(design.createdAt)
})
