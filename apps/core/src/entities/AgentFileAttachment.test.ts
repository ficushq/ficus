import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import {
  agentFileAttachments,
  agents,
  executions,
  inbox,
  inboxAttachments,
  messageAgentFileAttachments,
  messages,
} from '../db/schema'
import { getSettingsStore } from '../services/settings'
import { agentAttachmentRoot } from '@ficus/shared'
import { vmWorkspaceLayout } from '../services/sandbox/workspace-layout'
import { boxHome } from '../services/machines/box-paths'
import { AgentFileAttachment } from './AgentFileAttachment'
import { Agent } from './Agent'
import { InvalidAttachmentError } from '../services/attachments/agent-scope'

const ATTACHMENT_ID = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
const UPLOADER_ID = '94cf6eb0-e505-4a10-ad43-20763cfdf0de'
let home: string
let agentId: string
const originalHome = process.env.HOME_DIR

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-file-entity-'))
  process.env.HOME_DIR = home
  ;[{ id: agentId }] = await db.insert(agents).values({ agentTypeId: 'engineer' }).returning({ id: agents.id })
  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})

afterEach(async () => {
  await db.delete(messages).where(eq(messages.agentId, agentId))
  await db.delete(agentFileAttachments).where(eq(agentFileAttachments.agentId, agentId))
  await db.delete(agents).where(eq(agents.id, agentId))
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await rm(home, { recursive: true, force: true })
})

async function create(bytes = new TextEncoder().encode('hello')) {
  const sandboxId = await (await Agent.find(agentId))!.getSandboxId()
  return AgentFileAttachment.create({
    id: ATTACHMENT_ID,
    agentId,
    sandboxId,
    uploadedByType: 'user',
    uploadedById: UPLOADER_ID,
    originalName: 'quarterly report.pdf',
    contentType: 'application/pdf',
    bytes,
  })
}

describe('AgentFileAttachment', () => {
  test('stores immutable metadata and returns a narrow JSON shape', async () => {
    const attachment = await create()
    expect(attachment.privatePath).toBe(`/private/chat-attachments/${ATTACHMENT_ID}/quarterly_report.pdf`)
    expect(attachment.toJson()).toEqual({
      id: ATTACHMENT_ID,
      path: attachment.privatePath,
      displayName: 'quarterly report.pdf',
      contentType: 'application/pdf',
      byteSize: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
  })

  test('is idempotent for the same upload and rejects conflicting UUID reuse', async () => {
    const first = await create()
    const second = await AgentFileAttachment.create({
      id: ATTACHMENT_ID,
      agentId,
      sandboxId: first.sandboxId,
      uploadedByType: first.uploadedByType,
      uploadedById: first.uploadedById,
      originalName: first.originalName,
      contentType: first.contentType,
      bytes: new TextEncoder().encode('hello'),
    })
    expect(second.id).toBe(first.id)
    await expect(create(new TextEncoder().encode('different'))).rejects.toThrow('ATTACHMENT_ID_CONFLICT')
  })

  test('serializes concurrent identical and conflicting creates', async () => {
    const input = {
      id: crypto.randomUUID(),
      agentId,
      sandboxId: await (await Agent.find(agentId))!.getSandboxId(),
      uploadedByType: 'user',
      uploadedById: UPLOADER_ID,
      originalName: 'race.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('same'),
    }
    const [first, second] = await Promise.all([AgentFileAttachment.create(input), AgentFileAttachment.create(input)])
    expect(first.id).toBe(second.id)

    const conflictId = crypto.randomUUID()
    const results = await Promise.allSettled([
      AgentFileAttachment.create({ ...input, id: conflictId, bytes: new TextEncoder().encode('first') }),
      AgentFileAttachment.create({ ...input, id: conflictId, bytes: new TextEncoder().encode('second') }),
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  })

  test('serializes the shared quota across concurrent distinct IDs', async () => {
    const lockClient = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
    const lockConnection = await lockClient.reserve()
    await lockConnection`select pg_advisory_lock(hashtext('attachment-storage-quota'))`
    const [{ total: agentBytes }] = await db
      .select({ total: sql<number>`coalesce(sum(${agentFileAttachments.byteSize}), 0)` })
      .from(agentFileAttachments)
    const [{ total: inboxBytes }] = await db
      .select({ total: sql<number>`coalesce(sum(${inboxAttachments.byteSize}), 0)` })
      .from(inboxAttachments)
    await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', String(Number(agentBytes) + Number(inboxBytes) + 7))
    const sandboxId = await (await Agent.find(agentId))!.getSandboxId()
    const base = {
      agentId,
      sandboxId,
      uploadedByType: 'user',
      uploadedById: UPLOADER_ID,
      originalName: 'race.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('12345'),
    }
    let settled = 0
    const creations = [
      AgentFileAttachment.create({ ...base, id: crypto.randomUUID() }),
      AgentFileAttachment.create({ ...base, id: crypto.randomUUID() }),
    ].map((promise) => promise.finally(() => settled++))
    try {
      await Bun.sleep(25)
      expect(settled).toBe(0)
    } finally {
      await lockConnection`select pg_advisory_unlock(hashtext('attachment-storage-quota'))`
      lockConnection.release()
      await lockClient.end()
    }
    const results = await Promise.allSettled(creations)
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  })

  test('applies the total quota across inbox and agent attachments', async () => {
    const [{ id: messageId }] = await db
      .insert(inbox)
      .values({ recipientType: 'user', recipientId: 'quota', senderType: 'system', content: 'hi' })
      .returning({ id: inbox.id })
    await db.insert(inboxAttachments).values({
      messageId,
      filename: 'existing',
      contentType: 'text/plain',
      byteSize: 4,
      sha256: '0'.repeat(64),
      storagePath: '/unused',
    })
    await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', '8')
    await expect(create()).rejects.toThrow('INBOX_STORAGE_QUOTA_EXCEEDED')
    await db.delete(inbox).where(eq(inbox.id, messageId))
  })

  test('rejects uploading reservations without creating a message or execution', async () => {
    const id = crypto.randomUUID()
    const sandboxId = await (await Agent.find(agentId))!.getSandboxId()
    await db.insert(agentFileAttachments).values({
      id,
      agentId,
      sandboxId,
      uploadedByType: 'user',
      uploadedById: UPLOADER_ID,
      originalName: 'reserved.txt',
      storedName: 'reserved.txt',
      privatePath: `/private/chat-attachments/${id}/reserved.txt`,
      contentType: 'text/plain',
      byteSize: 1,
      sha256: '0'.repeat(64),
      status: 'uploading',
    })
    await db
      .update(agents)
      .set({ status: 'waiting-input', questionData: { question: 'Continue?' } })
      .where(eq(agents.id, agentId))
    const [waitingExecution] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
    const agent = (await Agent.find(agentId))!
    await expect(agent.sendMessage(`read @/private/chat-attachments/${id}/reserved.txt`)).rejects.toThrow(
      InvalidAttachmentError
    )
    expect(await db.select().from(messages).where(eq(messages.agentId, agentId))).toEqual([])
    expect((await db.select().from(executions).where(eq(executions.id, waitingExecution.id)))[0].status).toBe('running')
    const unchangedAgent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]
    expect(unchangedAgent.status).toBe('waiting-input')
    expect(unchangedAgent.questionData).toEqual({ question: 'Continue?' })
    expect((await AgentFileAttachment.findById(id))?.status).toBe('uploading')
  })

  test('fences stale owners from publishing or deleting a replacement reservation', async () => {
    const id = crypto.randomUUID()
    const ownerA = crypto.randomUUID()
    const ownerB = crypto.randomUUID()
    const sandboxId = await (await Agent.find(agentId))!.getSandboxId()
    await db.insert(agentFileAttachments).values({
      id,
      agentId,
      sandboxId,
      uploadedByType: 'user',
      uploadedById: UPLOADER_ID,
      originalName: 'fenced.txt',
      storedName: 'fenced.txt',
      privatePath: `/private/chat-attachments/${id}/fenced.txt`,
      contentType: 'text/plain',
      byteSize: 1,
      sha256: '0'.repeat(64),
      status: 'uploading',
      uploadAttemptId: ownerB,
    })
    const published = await AgentFileAttachment.markUploadReady(id, ownerA)
    const deleted = await AgentFileAttachment.deleteUploadReservation(id, ownerA)
    expect(published).toBeNull()
    expect(deleted).toBe(false)
    const replacement = await AgentFileAttachment.findById(id)
    expect(replacement?.status).toBe('uploading')
    expect(replacement?.uploadAttemptId).toBe(ownerB)
  })

  test('atomically associates exact references and marks uploads used', async () => {
    const attachment = await create()
    const agent = (await Agent.find(agentId))!
    const message = await agent.recordMessage({ role: 'human', content: `read @${attachment.privatePath}` })
    expect(
      await db.select().from(messageAgentFileAttachments).where(eq(messageAgentFileAttachments.messageId, message.id))
    ).toEqual([{ messageId: message.id, attachmentId: attachment.id }])
    expect((await AgentFileAttachment.findById(attachment.id))?.status).toBe('used')
  })

  // The vm runtime has no /private mount either: a box works out of its unix
  // user's HOME, and the box executor rebases /private onto ~/.private, so the
  // stored path must already BE that box-native path.
  test('derives the vm root from the box home', async () => {
    const sandboxId = `agent_${agentId}`
    expect(agentAttachmentRoot(vmWorkspaceLayout({ sandboxId }).privateMount)).toBe(
      `${boxHome(sandboxId)}/.private/chat-attachments`
    )
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      const attachment = await create()
      expect(attachment.privatePath).toBe(
        `${boxHome(sandboxId)}/.private/chat-attachments/${ATTACHMENT_ID}/quarterly_report.pdf`
      )
    } finally {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    }
  })

  // On host the agent-visible path is <HOME_DIR>/private/<sandboxId>/... — the
  // message text the composer produces there must be linked and consumed just
  // like a container `/private` reference.
  test('associates a host-runtime reference outside /private', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    try {
      const attachment = await create()
      expect(attachment.privatePath.startsWith(home)).toBe(true)
      const agent = (await Agent.find(agentId))!
      const message = await agent.recordMessage({ role: 'human', content: `read @${attachment.privatePath} now` })
      expect(
        await db.select().from(messageAgentFileAttachments).where(eq(messageAgentFileAttachments.messageId, message.id))
      ).toEqual([{ messageId: message.id, attachmentId: attachment.id }])
      expect((await AgentFileAttachment.findById(attachment.id))?.status).toBe('used')
    } finally {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    }
  })

  test('rejects foreign or path-mismatched references without persisting a message', async () => {
    const attachment = await create()
    const agent = (await Agent.find(agentId))!
    await expect(
      agent.recordMessage({ role: 'human', content: `read @${attachment.privatePath}.extra` })
    ).rejects.toThrow('INVALID_ATTACHMENT')
    expect(await db.select().from(messages).where(eq(messages.agentId, agentId))).toEqual([])
    expect((await AgentFileAttachment.findById(attachment.id))?.status).toBe('pending')
  })

  test('only deletes pending unassociated uploads', async () => {
    const attachment = await create()
    expect(await attachment.deletePending()).toBe(true)
    expect(await db.select().from(agentFileAttachments).where(eq(agentFileAttachments.id, ATTACHMENT_ID))).toEqual([])
  })
})
