import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { inArray } from 'drizzle-orm'
import { MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES } from '@ficus/shared'
import { db, images } from '../../db'
import type { Agent } from '../../entities/Agent'
import { Image, getImagePath } from '../../entities/Image'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** How many images the Assistant may hand on in one delegation or message. */
export const MAX_FORWARDED_IMAGES = 10

/** A forwarding request the Assistant may not make; the message is safe to show the model. */
export class ImageForwardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageForwardError'
  }
}

export interface ForwardedImages {
  /** The copies' IDs, for the delivered inbox message's `metadata.imageIds`. */
  ids: string[]
  /** Insert the copies' rows. Run it inside the transaction that commits the inbox message. */
  insert: (tx: DbTransaction) => Promise<void>
  /** Remove the copies' blobs when that transaction did not commit them (it failed, or lost an idempotent race). */
  discard: () => Promise<void>
}

/**
 * Copy images the Assistant received so another agent can see them.
 *
 * An image is bound to the conversation that received it, and the attachment scope only lets an agent
 * read images owned within its own sandbox's parent chain. A squad consultant has no parent link to
 * the Assistant, so instead of loosening that rule each forwarded image becomes a new image (its own
 * row and blob) bound to the recipient, uploaded by the same user and recorded as forwarded from the
 * original. Only images bound to `sourceAgentId` (the conversation's own agent) qualify. The caller
 * has already authorized `target`.
 *
 * Blobs are written now; rows are inserted by `insert` in the delivery transaction, so a delivery that
 * never commits leaves no rows (and `discard` removes the blobs).
 */
export async function prepareForwardedImages(input: {
  sourceAgentId: string | null
  imageIds: string[]
  target: Agent
  userId: string
}): Promise<ForwardedImages> {
  const { imageIds, target } = input
  if (new Set(imageIds).size !== imageIds.length) throw new ImageForwardError('Each image can be forwarded once.')
  if (imageIds.length > MAX_FORWARDED_IMAGES)
    throw new ImageForwardError(`Forward at most ${MAX_FORWARDED_IMAGES} images at a time.`)
  if (imageIds.length === 0) return { ids: [], insert: async () => {}, discard: async () => {} }

  const rows = input.sourceAgentId ? await Image.findMany(imageIds) : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of imageIds) {
    const row = byId.get(id)
    // The same answer for "doesn't exist" and "someone else's", so IDs can't be probed.
    if (!row || row.agentId !== input.sourceAgentId)
      throw new ImageForwardError(`Image ${id} is not one this conversation received.`)
  }
  if (rows.reduce((total, row) => total + row.size, 0) > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES)
    throw new ImageForwardError(
      `These images are larger than ${MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MB together; forward fewer.`
    )
  if (target.supportsSelectedModelImages() === false)
    throw new ImageForwardError("That agent's model cannot read images.")

  const copies = imageIds.map((id) => {
    const original = byId.get(id)!
    const copyId = randomUUID()
    const ext = original.filename.includes('.') ? original.filename.split('.').pop() : 'bin'
    return { original, values: { id: copyId, filename: `${copyId}.${ext}` } }
  })
  const written: string[] = []
  const discard = async () => {
    await Promise.all(written.map((filename) => unlink(getImagePath(filename)).catch(() => {})))
  }
  try {
    await Image.ensureImagesDir()
    for (const copy of copies) {
      await copyFile(getImagePath(copy.original.filename), getImagePath(copy.values.filename))
      written.push(copy.values.filename)
    }
  } catch {
    await discard()
    throw new ImageForwardError('An image could not be read.')
  }

  return {
    ids: copies.map((copy) => copy.values.id),
    insert: async (tx) => {
      // The originals must still belong to this conversation when the delivery commits.
      const current = await tx
        .select({ id: images.id, agentId: images.agentId })
        .from(images)
        .where(inArray(images.id, imageIds))
        .for('share')
      if (current.length !== imageIds.length || current.some((row) => row.agentId !== input.sourceAgentId))
        throw new ImageForwardError('An image is no longer available to forward.')
      await tx.insert(images).values(
        copies.map(({ original, values }) => ({
          ...values,
          mimeType: original.mimeType,
          size: original.size,
          agentId: target.id,
          squadId: target.squadId ?? null,
          uploadedByUserId: input.userId,
          forwardedFromImageId: original.id,
          status: 'pending' as const,
        }))
      )
    },
    discard,
  }
}

/** Run one delivery with forwarded copies: keep them only when this call committed a new message. */
export async function withForwardedImages<T extends { created: boolean }>(
  forwarded: ForwardedImages | null,
  send: () => Promise<T>
): Promise<T> {
  try {
    const result = await send()
    // An idempotent replay adopted the earlier message, which carries its own copies.
    if (!result.created) await forwarded?.discard()
    return result
  } catch (error) {
    await forwarded?.discard()
    throw error
  }
}
