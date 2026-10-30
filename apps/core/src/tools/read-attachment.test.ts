import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import { agents, agentTypes, db, images, inbox, squads, workflowAttemptAttachments, workStreams } from '../db'
import { Agent } from '../entities/Agent'
import { Image } from '../entities/Image'
import { InboxAttachment } from '../entities/InboxAttachment'
import {
  sha256Hex,
  workflowAttachmentBlobPath,
  writeWorkflowAttachmentBlob,
} from '../services/attachments/blob-storage'
import { attachStreamAsset } from '../services/work-streams/asset-attachments'
import { agentIdentity, ATTACHMENT_UNAVAILABLE, createReadAttachmentTool, renderAttachment } from './read-attachment'

// Synthetic data only. A real 1x1 PNG so the read tool's image pipeline decodes it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const prefix = `read-attachment-${randomUUID()}`
const profile = `${prefix}-profile`
const originalHome = process.env.HOME_DIR
let home: string
let squadA: string, squadB: string
let consultant: Agent, worker: Agent, sibling: Agent, foreign: Agent
const streams: string[] = []
const visionModel = { input: ['text', 'image'] }

beforeAll(async () => {
  const created = await db
    .insert(squads)
    .values([
      { name: `${prefix} A`, purpose: 'read_attachment tests' },
      { name: `${prefix} B`, purpose: 'read_attachment tests' },
    ])
    .returning()
  squadA = created[0]!.id
  squadB = created[1]!.id
  await db.insert(agentTypes).values({
    id: profile,
    name: 'Reader',
    model: 'x',
    systemPrompt: 'Test.',
    extraScopes: ['workstreams:read', 'workstreams:respond', 'agents:read', 'inbox:read'],
  })
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: profile, squadId: squadA },
      { agentTypeId: profile, squadId: squadA },
      { agentTypeId: profile, squadId: squadA },
      { agentTypeId: profile, squadId: squadB },
    ])
    .returning({ id: agents.id })
  ;[consultant, worker, sibling, foreign] = (await Promise.all(rows.map((row) => Agent.find(row.id)))) as Agent[]
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'read-attachment-'))
  process.env.HOME_DIR = home
})

afterEach(async () => {
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
  await rm(home, { recursive: true, force: true })
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await db.delete(images).where(inArray(images.agentId, [consultant.id, sibling.id]))
  await db.delete(inbox).where(inArray(inbox.recipientId, [worker.id, sibling.id]))
  await db.delete(agents).where(eq(agents.agentTypeId, profile))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
  await db.delete(squads).where(inArray(squads.id, [squadA, squadB]))
})

async function conversationImage(agentId: string) {
  const [image] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    agentId,
  })
  await Image.markManyUsed([image!.id])
  return image!
}

async function stream(squadId: string, ownerAgentId?: string) {
  const [row] = await db
    .insert(workStreams)
    .values({ squadId, title: prefix, status: 'active', ownerAgentId: ownerAgentId ?? null })
    .returning()
  streams.push(row!.id)
  return row!
}

/** Call the registered tool as `agent` would, with a vision model. */
async function read(agent: Agent, source: Record<string, string>, model: { input: string[] } = visionModel) {
  const tool = createReadAttachmentTool({ agentId: agent.id })
  type Execute = (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  }>
  return (tool.execute as unknown as Execute)('call-1', { source }, undefined, undefined, { model })
}

async function refused(agent: Agent, source: Record<string, string>) {
  const error = await read(agent, source).then(
    () => null,
    (failure: unknown) => failure as Error
  )
  expect(error?.message).toBe(ATTACHMENT_UNAVAILABLE)
}

test('the tool’s identity is the one the agent’s own CLI token resolves to', () => {
  expect(agentIdentity(worker)).toEqual({ type: 'agent', agentId: worker.id, squadId: squadA })
})

test('a new worker sees an image shared with its stream as an image block, with no file written anywhere', async () => {
  const image = await conversationImage(consultant.id)
  const target = await stream(squadA, consultant.id)
  const { attachment } = await attachStreamAsset({
    identity: agentIdentity(consultant),
    streamId: target.id,
    source: { kind: 'image', imageId: image.id },
  })
  const before = (await readdir(home, { recursive: true })).sort()
  const result = await read(worker, { kind: 'workstream-asset', workStreamId: target.id, attachmentId: attachment.id })
  expect(result.content[0]!.text).toContain(`Read attachment ${image.filename}`)
  const block = result.content[1]!
  expect(block.type).toBe('image')
  expect(block.mimeType).toBe('image/png')
  expect(Buffer.from(block.data!, 'base64').subarray(0, 8)).toEqual(PNG.subarray(0, 8))
  // The result converts to a model message carrying the image, as the read tool's results do.
  const [message] = convertToLlm([
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read_attachment',
      content: result.content,
      isError: false,
      timestamp: 0,
    },
  ] as Parameters<typeof convertToLlm>[0])
  expect(JSON.stringify(message)).toContain('"type":"image"')
  expect((await readdir(home, { recursive: true })).sort()).toEqual(before)
  // An agent of another squad, and guessed IDs, get the one refusal.
  await refused(foreign, { kind: 'workstream-asset', workStreamId: target.id, attachmentId: attachment.id })
  await refused(worker, { kind: 'workstream-asset', workStreamId: target.id, attachmentId: randomUUID() })
  await refused(worker, { kind: 'workstream-asset', workStreamId: target.id, attachmentId: image.id })
})

test('an agent re-reads an image from its own conversation; a sibling cannot', async () => {
  const image = await conversationImage(consultant.id)
  const before = (await Image.find(image.id))!
  const result = await read(consultant, { kind: 'conversation-image', imageId: image.id })
  expect(result.content[1]!.type).toBe('image')
  await refused(sibling, { kind: 'conversation-image', imageId: image.id })
  await refused(consultant, { kind: 'conversation-image', imageId: randomUUID() })
  await refused(consultant, { kind: 'conversation-image', imageId: 'not-a-uuid' })
  // Viewing changes nothing about the image.
  expect(await Image.find(image.id)).toEqual(before)
})

test('handoff files are readable to the stream’s squad only', async () => {
  const target = await stream(squadA)
  const id = randomUUID()
  const bytes = new TextEncoder().encode('# Review notes\n\nAll synthetic.')
  await writeWorkflowAttachmentBlob(target.id, id, bytes)
  await db.insert(workflowAttemptAttachments).values({
    id,
    workStreamId: target.id,
    attemptId: 1,
    filename: 'notes.md',
    path: 'notes.md',
    contentType: 'text/markdown',
    byteSize: bytes.byteLength,
    sha256: sha256Hex(bytes),
    storagePath: workflowAttachmentBlobPath(target.id, id),
    uploadedByAgentId: worker.id,
  })
  const result = await read(worker, { kind: 'workflow-attachment', workStreamId: target.id, attachmentId: id })
  expect(result.content).toHaveLength(1)
  expect(result.content[0]!.text).toContain('All synthetic.')
  await refused(foreign, { kind: 'workflow-attachment', workStreamId: target.id, attachmentId: id })
})

test('inbox attachments follow the inbox rule, and a sender-declared image type is not trusted', async () => {
  const [message] = await db
    .insert(inbox)
    .values({ recipientType: 'agent', recipientId: worker.id, senderType: 'system', content: 'Screenshot attached' })
    .returning()
  const real = await InboxAttachment.create({
    messageId: message!.id,
    filename: 'screen.png',
    contentType: 'image/png',
    bytes: PNG,
  })
  const fake = await InboxAttachment.create({
    messageId: message!.id,
    filename: 'fake.png',
    contentType: 'image/png',
    bytes: new TextEncoder().encode('not an image'),
  })
  expect((await read(worker, { kind: 'inbox-attachment', attachmentId: real.id })).content[1]!.type).toBe('image')
  const declared = await read(worker, { kind: 'inbox-attachment', attachmentId: fake.id })
  expect(declared.content.map((block) => block.type)).toEqual(['text'])
  expect(declared.content[0]!.text).toContain('cannot be shown here')
  // Another agent's inbox (same squad) is not readable without the cross-agent inbox permission.
  await refused(sibling, { kind: 'inbox-attachment', attachmentId: real.id })
  await refused(foreign, { kind: 'inbox-attachment', attachmentId: real.id })
})

test('a model without image input is told so, with the download command instead of an empty image', async () => {
  const image = await conversationImage(consultant.id)
  const result = await read(consultant, { kind: 'conversation-image', imageId: image.id }, { input: ['text'] })
  expect(result.content.map((block) => block.type)).toEqual(['text'])
  expect(result.content[0]!.text).toContain('cannot read images')
  expect(result.content[0]!.text).toContain(`ficus image get ${image.id} --out PATH`)
})

test('long text is cut and binary files are described, never decoded', async () => {
  const long = await renderAttachment(
    {
      filename: 'log.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('line\n'.repeat(3000)),
      download: 'ficus inbox download X --out PATH',
    },
    { supportsImages: true }
  )
  expect(long.content[0]).toMatchObject({ type: 'text' })
  const text = (long.content[0] as { text: string }).text
  expect(text).toContain('truncated')
  expect(text.split('\n').filter((line) => line === 'line').length).toBe(2000)
  const binary = await renderAttachment(
    {
      filename: 'archive.zip',
      contentType: 'application/zip',
      bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      download: 'ficus inbox download X --out PATH',
    },
    { supportsImages: true }
  )
  expect((binary.content[0] as { text: string }).text).toContain('cannot be shown here')
})
