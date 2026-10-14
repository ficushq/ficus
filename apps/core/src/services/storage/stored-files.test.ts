import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agentFileAttachments, agents, images, inbox, inboxAttachments, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { getSettingsStore } from '../settings'
import { summarizeStoredFiles } from './stored-files'

const owned = { squads: [] as string[], agents: [] as string[], images: [] as string[], inbox: [] as string[] }

afterEach(async () => {
  // Own every fixture row; never sweep another test's data.
  if (owned.images.length) await db.delete(images).where(inArray(images.id, owned.images))
  if (owned.inbox.length) await db.delete(inbox).where(inArray(inbox.id, owned.inbox))
  if (owned.agents.length) await db.delete(agents).where(inArray(agents.id, owned.agents))
  if (owned.squads.length) await db.delete(squads).where(inArray(squads.id, owned.squads))
  owned.squads = []
  owned.agents = []
  owned.images = []
  owned.inbox = []
})

async function agentFile(agentId: string, byteSize: number) {
  await db.insert(agentFileAttachments).values({
    id: randomUUID(),
    agentId,
    sandboxId: `agent_${agentId}`,
    uploadedByType: 'user',
    uploadedById: 'fixture',
    originalName: 'notes.txt',
    storedName: `${randomUUID()}.txt`,
    privatePath: '/private/notes.txt',
    contentType: 'text/plain',
    byteSize,
    sha256: '0'.repeat(64),
  })
}

async function image(byteSize: number, owner: { agentId?: string; squadId?: string }) {
  const [row] = await db
    .insert(images)
    .values({ filename: `${randomUUID()}.png`, mimeType: 'image/png', size: byteSize, ...owner })
    .returning({ id: images.id })
  owned.images.push(row.id)
}

async function inboxFile(recipientType: 'agent' | 'user', recipientId: string, byteSize: number) {
  const [message] = await db
    .insert(inbox)
    .values({ recipientType, recipientId, senderType: 'system', content: 'attachment fixture' })
    .returning({ id: inbox.id })
  owned.inbox.push(message.id)
  await db.insert(inboxAttachments).values({
    messageId: message.id,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    byteSize,
    sha256: '0'.repeat(64),
    storagePath: '/tmp/fixture',
  })
}

test('totals core-host files per squad, keeps unattributed files separate, and compares the quota', async () => {
  const before = await summarizeStoredFiles()
  const squad = await Squad.create({ name: `stored-files-${randomUUID()}`, purpose: 'stored files fixture' })
  owned.squads.push(squad.id)
  const agent = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id, persist: false })
  owned.agents.push(agent.id)

  await agentFile(agent.id, 100)
  await agentFile(agent.id, 50)
  await image(7, { squadId: squad.id })
  await image(3, { agentId: agent.id })
  await inboxFile('agent', agent.id, 20)
  // Not attributable to a squad: a person's inbox and an orphaned image.
  await inboxFile('user', randomUUID(), 11)
  await image(5, {})

  const summary = await summarizeStoredFiles()
  const mine = summary.squads.find((item) => item.id === squad.id)
  expect(mine).toEqual({
    id: squad.id,
    name: squad.name,
    bytes: 180,
    sources: { agentFiles: 150, inboxAttachments: 20, images: 10 },
  })
  expect(summary.unattributed.bytes - before.unattributed.bytes).toBe(16)
  expect(summary.unattributed.sources.inboxAttachments - (before.unattributed.sources.inboxAttachments ?? 0)).toBe(11)
  expect(summary.unattributed.sources.images - (before.unattributed.sources.images ?? 0)).toBe(5)
  // Images are stored by Ficus but do not count toward the attachment quota.
  expect(summary.quotaUsedBytes - before.quotaUsedBytes).toBe(181)
  expect(summary.totalBytes - before.totalBytes).toBe(196)
  expect(summary.sources.map(({ key, countsTowardQuota }) => [key, countsTowardQuota])).toEqual([
    ['agentFiles', true],
    ['inboxAttachments', true],
    ['images', false],
  ])
  expect(summary.quotaBytes).toBe(Number(getSettingsStore().getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES')))
})
