import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentFileAttachments,
  agents,
  images,
  inbox,
  inboxAttachments,
  squads,
  workflowAttemptAttachments,
  workStreams,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { getSettingsStore } from '../settings'
import { totalAttachmentStorageBytes } from '../attachments/storage-quota'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { summarizeSquadStoredFiles, summarizeStoredFiles } from './stored-files'

const owned = { squads: [] as string[], agents: [] as string[], images: [] as string[], inbox: [] as string[] }

afterEach(async () => {
  // Own every fixture row; never sweep another test's data.
  if (owned.images.length) await db.delete(images).where(inArray(images.id, owned.images))
  if (owned.inbox.length) await db.delete(inbox).where(inArray(inbox.id, owned.inbox))
  if (owned.squads.length) await db.delete(workStreams).where(inArray(workStreams.squadId, owned.squads))
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
  const stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'handoff fixture' })
  await db.insert(workflowAttemptAttachments).values({
    workStreamId: stream.id,
    attemptId: 1,
    filename: 'report.md',
    path: 'out/report.md',
    contentType: 'text/markdown',
    byteSize: 40,
    sha256: '0'.repeat(64),
    storagePath: '/tmp/fixture',
    uploadedByAgentId: agent.id,
  })
  // Not attributable to a squad: a person's inbox and an orphaned image.
  await inboxFile('user', randomUUID(), 11)
  await image(5, {})

  const summary = await summarizeStoredFiles()
  const mine = summary.squads.find((item) => item.id === squad.id)
  expect(mine).toEqual({
    id: squad.id,
    name: squad.name,
    bytes: 220,
    sources: { agentFiles: 150, inboxAttachments: 20, workflowAttachments: 40, images: 10 },
  })
  expect(summary.unattributed.bytes - before.unattributed.bytes).toBe(16)
  expect(summary.unattributed.sources.inboxAttachments - (before.unattributed.sources.inboxAttachments ?? 0)).toBe(11)
  expect(summary.unattributed.sources.images - (before.unattributed.sources.images ?? 0)).toBe(5)
  // Images are stored by Ficus but do not count toward the attachment quota.
  expect(summary.quotaUsedBytes - before.quotaUsedBytes).toBe(221)
  // The bar uses the same shared total the quota check enforces.
  expect(summary.quotaUsedBytes).toBe(await totalAttachmentStorageBytes())
  expect(summary.totalBytes - before.totalBytes).toBe(236)
  expect(summary.sources.map(({ key, countsTowardQuota }) => [key, countsTowardQuota])).toEqual([
    ['agentFiles', true],
    ['inboxAttachments', true],
    ['workflowAttachments', true],
    ['images', false],
    ['retainedFiles', true],
    ['retainedImages', false],
  ])
  expect(summary.quotaBytes).toBe(Number(getSettingsStore().getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES')))
})

test('a squad summary counts only that squad and leaves the instance quota out', async () => {
  const squad = await Squad.create({ name: `stored-files-own-${randomUUID()}`, purpose: 'stored files fixture' })
  const other = await Squad.create({ name: `stored-files-other-${randomUUID()}`, purpose: 'stored files fixture' })
  owned.squads.push(squad.id, other.id)
  const agent = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id, persist: false })
  const foreign = await Agent.create({ agentTypeId: 'consultant', squadId: other.id, persist: false })
  owned.agents.push(agent.id, foreign.id)

  await agentFile(agent.id, 100)
  await image(7, { squadId: squad.id })
  await image(3, { agentId: agent.id })
  await inboxFile('agent', agent.id, 20)
  // Another squad's files and unattributed files never reach this squad's totals.
  await agentFile(foreign.id, 9_000)
  await image(8_000, { squadId: other.id })
  await image(700, { agentId: foreign.id })
  await inboxFile('agent', foreign.id, 600)
  await inboxFile('user', randomUUID(), 50)
  await image(40, {})

  const summary = await summarizeSquadStoredFiles(squad.id)
  expect(summary).toEqual({
    bytes: 130,
    sources: [
      { key: 'agentFiles', label: 'Agent file attachments', countsTowardQuota: true, bytes: 100 },
      { key: 'inboxAttachments', label: 'Inbox attachments', countsTowardQuota: true, bytes: 20 },
      { key: 'workflowAttachments', label: 'Workflow handoff files', countsTowardQuota: true, bytes: 0 },
      { key: 'images', label: 'Images', countsTowardQuota: false, bytes: 10 },
    ],
  })
  expect(Object.keys(summary)).not.toContain('quotaUsedBytes')
  expect((await summarizeSquadStoredFiles(other.id)).bytes).toBe(18_300)
  // The instance-wide summary is unchanged by the squad filter.
  const all = await summarizeStoredFiles()
  expect(all.squads.find((item) => item.id === squad.id)?.bytes).toBe(130)
  expect(all.squads.find((item) => item.id === other.id)?.bytes).toBe(18_300)
})
