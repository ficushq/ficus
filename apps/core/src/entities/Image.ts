import { randomUUID } from 'crypto'
import { writeFile, readFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { images } from '../db/schema'
import { getHomeDir } from '../lib/utils/home'
import type { InferSelectModel } from 'drizzle-orm'
import type { Agent } from './Agent'
import {
  InvalidAttachmentError,
  resolveAttachmentScope,
  type AttachmentScope,
} from '../services/attachments/agent-scope'
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
} from '@ficus/shared'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ImageRow = InferSelectModel<typeof images>
export type ImageStatus = ImageRow['status']

export interface ImageContent {
  type: 'image'
  data: string // base64
  mimeType: string
}

export interface CreateImageInput {
  content: ImageContent
  agentId?: string
  /** Scope a non-agent image (e.g. a squad avatar) to its squad for cleanup. */
  squadId?: string
  uploadedByUserId?: string
}

const IMAGES_DIR = 'images'

function getImagesDir(): string {
  return join(getHomeDir(), IMAGES_DIR)
}

function getImagePath(filename: string): string {
  return join(getImagesDir(), filename)
}

/**
 * Image entity class.
 * Combines database record with file operations.
 */
export class Image implements ImageRow {
  // Row fields
  declare id: string
  declare filename: string
  declare mimeType: string
  declare size: number
  declare agentId: string | null
  declare squadId: string | null
  declare uploadedByUserId: string | null
  declare status: ImageStatus
  declare usedAt: Date | null
  declare createdAt: Date

  constructor(data: ImageRow) {
    Object.assign(this, data)
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Ensure the images directory exists.
   */
  static async ensureImagesDir(): Promise<void> {
    const dir = getImagesDir()
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  }

  /**
   * Find an image by ID.
   */
  static async find(id: string): Promise<Image | null> {
    const [row] = await db.select().from(images).where(eq(images.id, id))
    return row ? new Image(row) : null
  }

  /**
   * Find an image by ID, throwing if not found.
   */
  static async mustFind(id: string): Promise<Image> {
    const image = await this.find(id)
    if (!image) throw new Error(`Image ${id} not found`)
    return image
  }

  /**
   * Save a single image to disk and create database record.
   */
  static async create(input: CreateImageInput): Promise<Image> {
    await this.ensureImagesDir()

    const buffer = Buffer.from(input.content.data, 'base64')

    if (buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error(`Image exceeds maximum size of ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024}MB`)
    }

    const id = randomUUID()
    const ext = input.content.mimeType.split('/')[1] || 'bin'
    const filename = `${id}.${ext}`

    // Write file to disk
    await writeFile(getImagePath(filename), buffer)

    // Create database record
    const [row] = await db
      .insert(images)
      .values({
        id,
        filename,
        mimeType: input.content.mimeType,
        size: buffer.length,
        agentId: input.agentId ?? null,
        squadId: input.squadId ?? null,
        uploadedByUserId: input.uploadedByUserId ?? null,
        status: 'pending',
      })
      .returning()

    return new Image(row)
  }

  /**
   * Save multiple images to disk and create database records.
   * Returns array of Image entities.
   */
  static async createMany(
    imageContents: ImageContent[],
    context?: { agentId?: string; squadId?: string; uploadedByUserId?: string }
  ): Promise<Image[]> {
    await this.ensureImagesDir()

    let totalSize = 0
    const results: Image[] = []

    for (const img of imageContents) {
      const buffer = Buffer.from(img.data, 'base64')

      if (buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(`Image exceeds maximum size of ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024}MB`)
      }

      totalSize += buffer.length
      if (totalSize > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES) {
        throw new Error(`Total images exceed maximum size of ${MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024}MB`)
      }

      const id = randomUUID()
      const ext = img.mimeType.split('/')[1] || 'bin'
      const filename = `${id}.${ext}`

      // Write file to disk
      await writeFile(getImagePath(filename), buffer)

      // Create database record
      const [row] = await db
        .insert(images)
        .values({
          id,
          filename,
          mimeType: img.mimeType,
          size: buffer.length,
          agentId: context?.agentId ?? null,
          squadId: context?.squadId ?? null,
          uploadedByUserId: context?.uploadedByUserId ?? null,
          status: 'pending',
        })
        .returning()

      results.push(new Image(row))
    }

    return results
  }

  static async claimForTarget(imageIds: string[], target: Agent, actorUserId: string): Promise<Image[]> {
    // Scope resolution reads the agent ancestry on the pool — resolve BEFORE
    // opening the transaction (pool reads inside a held transaction are
    // hold-and-wait; see db/connection.ts DEFAULT_POOL_MAX).
    if (new Set(imageIds).size !== imageIds.length || imageIds.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) {
      throw new InvalidAttachmentError()
    }
    if (imageIds.length === 0) return []
    const scope = await resolveAttachmentScope(target)
    return db.transaction((tx) => this.claimForTargetInTransaction(tx, imageIds, target, actorUserId, scope))
  }

  static async claimForTargetInTransaction(
    tx: DbTransaction,
    imageIds: string[],
    target: Agent,
    actorUserId: string,
    /**
     * Pre-resolved attachment scope. Callers holding an open transaction MUST
     * resolve it before the transaction opens and pass it here — resolving it
     * inside the transaction issues pool reads while a connection is held.
     */
    scope: AttachmentScope
  ): Promise<Image[]> {
    if (new Set(imageIds).size !== imageIds.length || imageIds.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) {
      throw new InvalidAttachmentError()
    }
    if (imageIds.length === 0) return []
    for (const id of [...imageIds].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`)
    }
    const rows = await tx.select().from(images).where(inArray(images.id, imageIds)).for('update')
    if (
      rows.length !== imageIds.length ||
      rows.reduce((total, row) => total + row.size, 0) > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES
    ) {
      throw new InvalidAttachmentError()
    }

    for (const row of rows) {
      if (row.agentId === null) {
        // Only pending uploads are staging records. Used squad assets (for
        // example avatars or images whose agent was deleted) are never claimable.
        if (row.status !== 'pending' || row.uploadedByUserId !== actorUserId || row.squadId !== target.squadId) {
          throw new InvalidAttachmentError()
        }
      } else if (
        !scope.ownerAgentIds.includes(row.agentId) ||
        (row.squadId !== null && row.squadId !== target.squadId)
      ) {
        throw new InvalidAttachmentError()
      }
    }

    const unbound = rows.filter((row) => row.agentId === null).map((row) => row.id)
    if (unbound.length) await tx.update(images).set({ agentId: target.id }).where(inArray(images.id, unbound))
    const byId = new Map(rows.map((row) => [row.id, new Image({ ...row, agentId: row.agentId ?? target.id })]))
    return imageIds.map((id) => byId.get(id)!)
  }

  static async loadManyForAgent(imageIds: string[], target: Agent): Promise<ImageContent[]> {
    if (new Set(imageIds).size !== imageIds.length) throw new InvalidAttachmentError()
    if (imageIds.length === 0) return []
    const scope = await resolveAttachmentScope(target)
    const rows = await db.select().from(images).where(inArray(images.id, imageIds))
    if (
      rows.length !== imageIds.length ||
      rows.some((row) => !row.agentId || !scope.ownerAgentIds.includes(row.agentId))
    ) {
      throw new InvalidAttachmentError()
    }
    const byId = new Map(rows.map((row) => [row.id, row]))
    return Promise.all(
      imageIds.map(async (id) => {
        const row = byId.get(id)!
        const buffer = await readFile(getImagePath(row.filename))
        return { type: 'image' as const, data: buffer.toString('base64'), mimeType: row.mimeType }
      })
    )
  }

  /**
   * Load images from disk by their IDs.
   * Returns ImageContent array ready for Pi SDK.
   */
  static async loadMany(imageIds: string[]): Promise<ImageContent[]> {
    if (imageIds.length === 0) return []

    const rows = await db.select().from(images).where(inArray(images.id, imageIds))

    const results: ImageContent[] = []

    for (const row of rows) {
      const buffer = await readFile(getImagePath(row.filename))
      results.push({
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: row.mimeType,
      })
    }

    return results
  }

  /**
   * Mark multiple images as used.
   */
  static async markManyUsed(imageIds: string[]): Promise<void> {
    if (imageIds.length === 0) return
    await db.update(images).set({ status: 'used', usedAt: new Date() }).where(inArray(images.id, imageIds))
  }

  /**
   * Mark multiple images as failed.
   */
  static async markManyFailed(imageIds: string[]): Promise<void> {
    if (imageIds.length === 0) return
    await db.update(images).set({ status: 'failed' }).where(inArray(images.id, imageIds))
  }

  /**
   * Delete multiple images (files and database records).
   */
  static async deleteMany(imageIds: string[]): Promise<void> {
    if (imageIds.length === 0) return

    const rows = await db.transaction(async (tx) => {
      for (const id of [...imageIds].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`)
      }
      return tx.delete(images).where(inArray(images.id, imageIds)).returning({ filename: images.filename })
    })
    for (const row of rows) {
      try {
        await unlink(getImagePath(row.filename))
      } catch {
        // The metadata deletion is authoritative; orphan cleanup is best-effort.
      }
    }
  }

  /**
   * Get image records by IDs.
   */
  static async findMany(imageIds: string[]): Promise<Image[]> {
    if (imageIds.length === 0) return []

    const rows = await db.select().from(images).where(inArray(images.id, imageIds))
    return rows.map((row) => new Image(row))
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the file path for this image.
   */
  getFilePath(): string {
    return getImagePath(this.filename)
  }

  /**
   * Get the image file as a Buffer.
   */
  async getBuffer(): Promise<Buffer> {
    return readFile(this.getFilePath())
  }

  /**
   * Load this image's content (for Pi SDK).
   */
  async loadContent(): Promise<ImageContent> {
    const buffer = await this.getBuffer()
    return {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType: this.mimeType,
    }
  }

  /**
   * Mark this image as used.
   */
  async markUsed(): Promise<this> {
    await db.update(images).set({ status: 'used', usedAt: new Date() }).where(eq(images.id, this.id))
    this.status = 'used'
    this.usedAt = new Date()
    return this
  }

  /**
   * Mark this image as failed.
   */
  async markFailed(): Promise<this> {
    await db.update(images).set({ status: 'failed' }).where(eq(images.id, this.id))
    this.status = 'failed'
    return this
  }

  /**
   * Delete this image (file and database record).
   */
  async delete(): Promise<void> {
    // Delete file
    try {
      await unlink(this.getFilePath())
    } catch {
      // Ignore if already deleted
    }

    // Delete database record
    await db.delete(images).where(eq(images.id, this.id))
  }

  /**
   * Reload this image from the database.
   */
  async reload(): Promise<this> {
    const fresh = await Image.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJson() {
    return {
      id: this.id,
      filename: this.filename,
      mimeType: this.mimeType,
      size: this.size,
      agentId: this.agentId,
      squadId: this.squadId,
      status: this.status,
      usedAt: this.usedAt,
      createdAt: this.createdAt,
    }
  }
}
