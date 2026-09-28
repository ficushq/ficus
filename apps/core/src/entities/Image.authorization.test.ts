import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db } from '../db'
import { agents, images, squads, users } from '../db/schema'
import { Agent } from './Agent'
import { Image } from './Image'
import { InvalidAttachmentError } from '../services/attachments/agent-scope'
import { MAX_IMAGE_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES } from '@ficus/shared'

const agentIds: string[] = []
const imageIds: string[] = []
const squadIds: string[] = []
const userIds: string[] = []

async function createSquad(): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({ name: `image-auth-${crypto.randomUUID()}`, purpose: 'test' })
    .returning({ id: squads.id })
  squadIds.push(row.id)
  return row.id
}

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `image-auth-${crypto.randomUUID()}@test.local`, displayName: 'Image owner' })
    .returning({ id: users.id })
  userIds.push(row.id)
  return row.id
}

async function createAgent(options: { parentAgentId?: string; squadId?: string } = {}): Promise<Agent> {
  const [row] = await db
    .insert(agents)
    .values({ agentTypeId: 'engineer', ...options })
    .returning({ id: agents.id })
  agentIds.push(row.id)
  return (await Agent.find(row.id))!
}

async function createImage(options: {
  agentId?: string | null
  uploadedByUserId?: string | null
  squadId?: string | null
  size?: number
}): Promise<string> {
  const [row] = await db
    .insert(images)
    .values({
      filename: `${crypto.randomUUID()}.png`,
      mimeType: 'image/png',
      size: options.size ?? 1,
      agentId: options.agentId ?? null,
      squadId: options.squadId ?? null,
      uploadedByUserId: options.uploadedByUserId ?? null,
    })
    .returning({ id: images.id })
  imageIds.push(row.id)
  return row.id
}

afterEach(async () => {
  if (imageIds.length) await db.delete(images).where(inArray(images.id, imageIds.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)))
})

describe('Image target authorization', () => {
  test('allows target and ancestor images, but denies siblings', async () => {
    const parent = await createAgent()
    const child = await createAgent({ parentAgentId: parent.id })
    const sibling = await createAgent({ parentAgentId: parent.id })
    await expect(
      Image.claimForTarget(
        [await createImage({ agentId: parent.id }), await createImage({ agentId: child.id })],
        child,
        'actor'
      )
    ).resolves.toHaveLength(2)
    await expect(Image.claimForTarget([await createImage({ agentId: sibling.id })], child, 'actor')).rejects.toThrow(
      InvalidAttachmentError
    )
  })

  test('claims staged images only for the same uploader and squad', async () => {
    const actor = await createUser()
    const squadId = await createSquad()
    const target = await createAgent({ squadId })
    const staged = await createImage({ uploadedByUserId: actor, squadId })

    await expect(Image.claimForTarget([staged], target, actor)).resolves.toHaveLength(1)
    expect(await Image.find(staged)).toMatchObject({ agentId: target.id, squadId })
  })

  test('rejects a wrong actor or cross-squad staged image', async () => {
    const actor = await createUser()
    const otherActor = await createUser()
    const squadId = await createSquad()
    const otherSquadId = await createSquad()
    const target = await createAgent({ squadId })
    const wrongActor = await createImage({ uploadedByUserId: otherActor, squadId })
    const crossSquad = await createImage({ uploadedByUserId: actor, squadId: otherSquadId })

    await expect(Image.claimForTarget([wrongActor], target, actor)).rejects.toThrow(InvalidAttachmentError)
    await expect(Image.claimForTarget([crossSquad], target, actor)).rejects.toThrow(InvalidAttachmentError)
    expect((await Image.find(wrongActor))?.agentId).toBeNull()
    expect((await Image.find(crossSquad))?.agentId).toBeNull()
  })

  test('rejects duplicates, unknown IDs, excessive count, and excessive total bytes', async () => {
    const target = await createAgent()
    const ownedId = await createImage({ agentId: target.id })
    await expect(Image.claimForTarget([ownedId, ownedId], target, 'actor')).rejects.toThrow(InvalidAttachmentError)
    await expect(Image.claimForTarget([crypto.randomUUID()], target, 'actor')).rejects.toThrow(InvalidAttachmentError)
    await expect(
      Image.claimForTarget(
        Array.from({ length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE + 1 }, () => crypto.randomUUID()),
        target,
        'actor'
      )
    ).rejects.toThrow(InvalidAttachmentError)

    const tooLarge = await createImage({ agentId: target.id, size: MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES + 1 })
    await expect(Image.claimForTarget([tooLarge], target, 'actor')).rejects.toThrow(InvalidAttachmentError)
  })

  test('leaves every staged row unbound when a mixed set is invalid', async () => {
    const actor = await createUser()
    const squadId = await createSquad()
    const target = await createAgent({ squadId })
    const valid = await createImage({ uploadedByUserId: actor, squadId })
    const invalid = await createImage({ uploadedByUserId: await createUser(), squadId })

    await expect(Image.claimForTarget([valid, invalid], target, actor)).rejects.toThrow(InvalidAttachmentError)
    expect((await Image.find(valid))?.agentId).toBeNull()
    expect((await Image.find(invalid))?.agentId).toBeNull()
  })

  test('allows idempotent reclaims by the same target', async () => {
    const actor = await createUser()
    const squadId = await createSquad()
    const target = await createAgent({ squadId })
    const staged = await createImage({ uploadedByUserId: actor, squadId })

    await Image.claimForTarget([staged], target, actor)
    await expect(Image.claimForTarget([staged], target, actor)).resolves.toHaveLength(1)
  })

  test('allows only one of two different targets to claim a staged image concurrently', async () => {
    const actor = await createUser()
    const squadId = await createSquad()
    const first = await createAgent({ squadId })
    const second = await createAgent({ squadId })
    const staged = await createImage({ uploadedByUserId: actor, squadId })

    const results = await Promise.allSettled([
      Image.claimForTarget([staged], first, actor),
      Image.claimForTarget([staged], second, actor),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
