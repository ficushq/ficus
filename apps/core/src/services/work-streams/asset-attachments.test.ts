import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { WORK_STREAM_INPUT_ASSET_LIMIT } from '@ficus/shared'
import {
  agents,
  agentTypes,
  db,
  images,
  retainedAssets,
  squads,
  workStreamAssetAttachments,
  workStreams,
} from '../../db'
import { Image } from '../../entities/Image'
import { WorkStream } from '../../entities/WorkStream'
import { cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../../test-utils/rbac'
import type { AgentIdentity, Identity } from '../rbac'
import { canReadImage } from '../images/access'
import { totalAttachmentStorageBytes } from '../attachments/storage-quota'
import {
  AssetAttachmentError,
  attachStreamAsset,
  insertCreationAssets,
  listStreamAssets,
  prepareCreationAssets,
  readStreamAsset,
  releaseRetainedAsset,
  removeStreamAsset,
  runRetainedAssetCleanup,
} from './asset-attachments'

// Synthetic data only: squads, agents, users and a generated 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const prefix = `ws-assets-${randomUUID()}`
const profile = `${prefix}-profile`
const originalHome = process.env.HOME_DIR
let home: string
let squadA: string, squadB: string
let consultant: AgentIdentity, worker: AgentIdentity, sibling: AgentIdentity, foreign: AgentIdentity
let owner: TestUser, otherAdmin: TestUser, outsider: TestUser
let privateAgentId: string
const streams: string[] = []

const agentIdentity = (agentId: string, squadId: string | null): AgentIdentity => ({ type: 'agent', agentId, squadId })
const user = (account: TestUser): Identity => ({ type: 'user', userId: account.id })

beforeAll(async () => {
  owner = await createTestAdmin({ prefix })
  otherAdmin = await createTestAdmin({ prefix })
  outsider = await createTestUser({ prefix })
  const created = await db
    .insert(squads)
    .values([
      { name: `${prefix} A`, purpose: 'Asset tests' },
      { name: `${prefix} B`, purpose: 'Asset tests' },
    ])
    .returning()
  squadA = created[0]!.id
  squadB = created[1]!.id
  // The scopes a squad worker holds through its role, granted on this synthetic type alone.
  await db.insert(agentTypes).values({
    id: profile,
    name: 'Asset worker',
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
      { agentTypeId: profile, squadId: null, ownerUserId: owner.id },
    ])
    .returning({ id: agents.id })
  consultant = agentIdentity(rows[0]!.id, squadA)
  worker = agentIdentity(rows[1]!.id, squadA)
  sibling = agentIdentity(rows[2]!.id, squadA)
  foreign = agentIdentity(rows[3]!.id, squadB)
  privateAgentId = rows[4]!.id
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ws-assets-'))
  process.env.HOME_DIR = home
})

afterEach(async () => {
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
  await runRetainedAssetCleanup({ maxAssets: 200 })
  await rm(home, { recursive: true, force: true })
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await db.delete(images).where(inArray(images.agentId, [consultant.agentId, privateAgentId, sibling.agentId]))
  await db.delete(agents).where(eq(agents.agentTypeId, profile))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
  await db.delete(squads).where(inArray(squads.id, [squadA, squadB]))
  await cleanupTestRbac(prefix)
})

/** An image a conversation received and delivered (the only images that can be shared). */
async function conversationImage(agentId: string) {
  const [image] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    agentId,
  })
  await Image.markManyUsed([image!.id])
  return (await Image.find(image!.id))!
}

/** A work stream in `squadId`, with `worker` bound as its assignee. */
async function stream(squadId = squadA) {
  const [row] = await db
    .insert(workStreams)
    .values({ squadId, title: prefix, status: 'active', assigneeAgentId: squadId === squadA ? worker.agentId : null })
    .returning()
  streams.push(row!.id)
  return row!
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure
  )
  expect(error).toBeInstanceOf(AssetAttachmentError)
  return { status: (error as AssetAttachmentError).status, message: (error as Error).message }
}

test('an agent shares an image from its own conversation by ID; repeats return the same share', async () => {
  const image = await conversationImage(consultant.agentId)
  const target = await stream()
  // The consultant writes the stream as its owner would; here it is bound as owner.
  await db.update(workStreams).set({ ownerAgentId: consultant.agentId }).where(eq(workStreams.id, target.id))
  const first = await attachStreamAsset({
    identity: consultant,
    streamId: target.id,
    source: { kind: 'image', imageId: image.id },
  })
  expect(first.created).toBe(true)
  expect(first.attachment).toMatchObject({
    workStreamId: target.id,
    attemptId: null,
    source: { kind: 'image', imageId: image.id },
    contentType: 'image/png',
    byteSize: PNG.length,
  })
  // The share has its own ID: a source ID is never a share ID.
  expect(first.attachment.id).not.toBe(image.id)
  const again = await attachStreamAsset({
    identity: consultant,
    streamId: target.id,
    source: { kind: 'image', imageId: image.id },
  })
  expect(again).toEqual({ attachment: first.attachment, created: false })
  expect((await listStreamAssets(target.id)).inputs.map((entry) => entry.id)).toEqual([first.attachment.id])

  const read = await readStreamAsset(target.id, first.attachment.id)
  expect(read!.bytes.equals(PNG)).toBe(true)
  // Another stream's share, and guessed IDs, read as absent.
  const elsewhere = await stream()
  expect(await readStreamAsset(elsewhere.id, first.attachment.id)).toBeNull()
  expect(await readStreamAsset(target.id, image.id)).toBeNull()
  expect(await readStreamAsset(target.id, randomUUID())).toBeNull()
})

test('sources outside the caller’s conversation or squad are refused with one non-enumerating answer', async () => {
  const image = await conversationImage(consultant.agentId)
  const target = await stream()
  // The sibling may write this stream, so only the source decides.
  await db
    .update(workStreams)
    .set({ agentIds: [sibling.agentId] })
    .where(eq(workStreams.id, target.id))
  const answers = [
    // A sibling in the same squad has its own conversation.
    await refusal(
      attachStreamAsset({ identity: sibling, streamId: target.id, source: { kind: 'image', imageId: image.id } })
    ),
    // A guessed ID.
    await refusal(
      attachStreamAsset({ identity: worker, streamId: target.id, source: { kind: 'image', imageId: randomUUID() } })
    ),
  ]
  // A staged upload (never sent) is not a conversation image.
  const [staged] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    squadId: squadA,
    uploadedByUserId: owner.id,
  })
  answers.push(
    await refusal(
      attachStreamAsset({ identity: user(owner), streamId: target.id, source: { kind: 'image', imageId: staged!.id } })
    )
  )
  // The consultant's own image cannot be carried into another squad's stream.
  const foreignStream = await stream(squadB)
  answers.push(
    await refusal(
      attachStreamAsset({
        identity: user(owner),
        streamId: foreignStream.id,
        source: { kind: 'image', imageId: image.id },
      })
    )
  )
  for (const answer of answers)
    expect(answer).toEqual({ status: 404, message: 'Image or file not found, or you cannot share it' })
  // Writing the target needs the stream-edit rule, checked before the source is looked at: an
  // unbound squad agent and a stranger are refused whatever they name.
  const unbound = await stream()
  expect(
    await refusal(
      attachStreamAsset({ identity: sibling, streamId: unbound.id, source: { kind: 'image', imageId: image.id } })
    )
  ).toEqual({ status: 403, message: 'Forbidden' })
  expect(
    (
      await refusal(
        attachStreamAsset({
          identity: user(outsider),
          streamId: target.id,
          source: { kind: 'image', imageId: image.id },
        })
      )
    ).status
  ).toBe(403)
  expect((await listStreamAssets(target.id)).inputs).toEqual([])
  await Image.deleteMany([staged!.id])
})

test('a private conversation’s image is its owner’s alone to read and to share, even against another administrator', async () => {
  const image = await conversationImage(privateAgentId)
  expect(await canReadImage(user(owner), image)).toBe(true)
  expect(await canReadImage(user(otherAdmin), image)).toBe(false)
  expect(await canReadImage(user(outsider), image)).toBe(false)
  const target = await stream()
  expect(
    await refusal(
      attachStreamAsset({
        identity: user(otherAdmin),
        streamId: target.id,
        source: { kind: 'image', imageId: image.id },
      })
    )
  ).toEqual({ status: 404, message: 'Image or file not found, or you cannot share it' })
  const shared = await attachStreamAsset({
    identity: user(owner),
    streamId: target.id,
    source: { kind: 'image', imageId: image.id },
  })
  expect(shared.created).toBe(true)
  // The explicit share is what lets the stream's readers see it; the source itself stays private.
  expect(await canReadImage(user(otherAdmin), image)).toBe(false)
})

test('a staged upload is readable only by its uploader, and squad images by squad readers', async () => {
  const [staged] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    squadId: squadA,
    uploadedByUserId: owner.id,
  })
  const [unscoped] = await Image.createMany([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }], {
    uploadedByUserId: outsider.id,
  })
  try {
    expect(await canReadImage(user(owner), staged!)).toBe(true)
    expect(await canReadImage(user(otherAdmin), staged!)).toBe(false)
    expect(await canReadImage(user(otherAdmin), unscoped!)).toBe(false)
    const squadImage = await conversationImage(consultant.agentId)
    expect(await canReadImage(worker, squadImage)).toBe(true)
    expect(await canReadImage(foreign, squadImage)).toBe(false)
    expect(await canReadImage(user(otherAdmin), squadImage)).toBe(true)
  } finally {
    await Image.deleteMany([staged!.id, unscoped!.id])
  }
})

test('a shared image outlives its chat row and is unlinked with its last share, never before', async () => {
  const image = await conversationImage(consultant.agentId)
  const path = image.getFilePath()
  const first = await stream()
  const second = await stream()
  for (const target of [first, second])
    await db.update(workStreams).set({ ownerAgentId: consultant.agentId }).where(eq(workStreams.id, target.id))
  const a = await attachStreamAsset({
    identity: consultant,
    streamId: first.id,
    source: { kind: 'image', imageId: image.id },
  })
  const b = await attachStreamAsset({
    identity: consultant,
    streamId: second.id,
    source: { kind: 'image', imageId: image.id },
  })
  // One retained record for one source, however many streams share it; nothing was copied.
  expect(await db.select().from(retainedAssets).where(eq(retainedAssets.sourceId, image.id))).toHaveLength(1)

  await Image.deleteMany([image.id])
  expect(await Image.find(image.id)).toBeNull()
  expect(existsSync(path)).toBe(true)
  expect((await readStreamAsset(first.id, a.attachment.id))!.bytes.equals(PNG)).toBe(true)

  // Deleting one stream releases its share; the other still reads the bytes.
  streams.splice(streams.indexOf(first.id), 1)
  await (await WorkStream.find(first.id))!.delete()
  expect(existsSync(path)).toBe(true)
  expect((await readStreamAsset(second.id, b.attachment.id))!.bytes.equals(PNG)).toBe(true)

  // The last share goes: with its chat row gone too, the exact blob is removed.
  await db.update(workStreams).set({ ownerAgentId: worker.agentId }).where(eq(workStreams.id, second.id))
  await removeStreamAsset({ identity: worker, streamId: second.id, shareId: b.attachment.id })
  expect(existsSync(path)).toBe(false)
  expect(await db.select().from(retainedAssets).where(eq(retainedAssets.sourceId, image.id))).toEqual([])
  // Removal keeps the record of what was shared, and is idempotent.
  const [kept] = await db
    .select()
    .from(workStreamAssetAttachments)
    .where(eq(workStreamAssetAttachments.id, b.attachment.id))
  expect(kept!.removedAt).not.toBeNull()
  await removeStreamAsset({ identity: worker, streamId: second.id, shareId: b.attachment.id })
  expect(await readStreamAsset(second.id, b.attachment.id)).toBeNull()
})

test('while the chat row exists, releasing a share drops only the bookkeeping; the sweep catches orphaned records', async () => {
  const image = await conversationImage(consultant.agentId)
  const target = await stream()
  await db.update(workStreams).set({ ownerAgentId: consultant.agentId }).where(eq(workStreams.id, target.id))
  const shared = await attachStreamAsset({
    identity: consultant,
    streamId: target.id,
    source: { kind: 'image', imageId: image.id },
  })
  // A cascade that skipped the release (for example a squad's streams) leaves an unused record.
  await db.delete(workStreamAssetAttachments).where(eq(workStreamAssetAttachments.id, shared.attachment.id))
  const [asset] = await db.select().from(retainedAssets).where(eq(retainedAssets.sourceId, image.id))
  expect(asset).toBeDefined()
  await runRetainedAssetCleanup({ maxAssets: 200 })
  expect(await db.select().from(retainedAssets).where(eq(retainedAssets.id, asset!.id))).toEqual([])
  // The chat still owns its bytes.
  expect(existsSync(image.getFilePath())).toBe(true)
  expect(await releaseRetainedAsset(asset!.id)).toBe('released')
})

test('a stream holds a bounded number of stored inputs', async () => {
  const target = await stream()
  await db.update(workStreams).set({ ownerAgentId: consultant.agentId }).where(eq(workStreams.id, target.id))
  for (let index = 0; index < WORK_STREAM_INPUT_ASSET_LIMIT; index++) {
    const image = await conversationImage(consultant.agentId)
    await attachStreamAsset({ identity: consultant, streamId: target.id, source: { kind: 'image', imageId: image.id } })
  }
  const extra = await conversationImage(consultant.agentId)
  const answer = await refusal(
    attachStreamAsset({ identity: consultant, streamId: target.id, source: { kind: 'image', imageId: extra.id } })
  )
  expect(answer.status).toBe(409)
  expect((await listStreamAssets(target.id)).inputs).toHaveLength(WORK_STREAM_INPUT_ASSET_LIMIT)
})

test('creation-time inputs are checked first and inserted in order inside the creation transaction', async () => {
  const first = await conversationImage(consultant.agentId)
  const second = await conversationImage(consultant.agentId)
  const sources = [
    { kind: 'image' as const, imageId: second.id },
    { kind: 'image' as const, imageId: first.id },
  ]
  expect((await refusal(prepareCreationAssets(consultant, [sources[0]!, sources[0]!], squadA))).status).toBe(400)
  expect((await refusal(prepareCreationAssets(sibling, sources, squadA))).status).toBe(404)
  const prepared = await prepareCreationAssets(consultant, sources, squadA)
  const target = await stream()
  await db.transaction((tx) => insertCreationAssets(tx, consultant, target, prepared))
  expect((await listStreamAssets(target.id)).inputs.map((entry) => entry.source)).toEqual(sources)
})

test('retained chat-file bytes count toward the attachment quota only once their chat row is gone', async () => {
  const before = await totalAttachmentStorageBytes()
  const image = await conversationImage(consultant.agentId)
  const target = await stream()
  await db.update(workStreams).set({ ownerAgentId: consultant.agentId }).where(eq(workStreams.id, target.id))
  await attachStreamAsset({ identity: consultant, streamId: target.id, source: { kind: 'image', imageId: image.id } })
  // Images are reported but never counted toward the shared file quota, retained or not.
  await Image.deleteMany([image.id])
  expect(await totalAttachmentStorageBytes()).toBe(before)
})
