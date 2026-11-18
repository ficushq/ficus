import { count, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  publicVoiceBytes,
  renderProfileAlone,
  type PublicVoiceProfile,
  type PublicVoiceProfileJson,
  type PublicVoiceSurfaces,
} from '@ficus/shared'
import { db, publicVoices, squads } from '../db'

export type PublicVoiceRow = InferSelectModel<typeof publicVoices>

export interface UpsertPublicVoiceInput {
  id: string
  name: string
  description?: string | null
  base: string
  surfaces?: PublicVoiceSurfaces
}

/**
 * A named voice profile (see docs/wiki/public-voice.md). Cached like
 * SharedPrompt: runners resolve the voice on every turn.
 */
export class PublicVoice implements PublicVoiceRow {
  declare id: string
  declare name: string
  declare description: string | null
  declare base: string
  declare surfaces: PublicVoiceSurfaces
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: unknown
  declare disabled: boolean
  declare createdAt: Date
  declare updatedAt: Date

  private static cache = new Map<string, PublicVoice>()
  private static allCached: PublicVoice[] | null = null
  private static lastCacheRefresh = 0
  private static cacheTimeout = 60_000

  constructor(row: PublicVoiceRow) {
    Object.assign(this, row)
    this.surfaces = (row.surfaces as PublicVoiceSurfaces | null) ?? {}
  }

  private static isCacheValid(): boolean {
    return Date.now() - this.lastCacheRefresh < this.cacheTimeout
  }

  static invalidateCache(): void {
    this.cache.clear()
    this.allCached = null
    this.lastCacheRefresh = 0
  }

  static async list(options: { includeDisabled?: boolean } = {}): Promise<PublicVoice[]> {
    if (!this.isCacheValid() || !this.allCached) {
      const rows = await db.select().from(publicVoices).orderBy(publicVoices.id)
      this.allCached = rows.map((row) => new PublicVoice(row))
      this.cache.clear()
      for (const item of this.allCached) this.cache.set(item.id, item)
      this.lastCacheRefresh = Date.now()
    }
    return options.includeDisabled ? this.allCached : this.allCached.filter((item) => !item.disabled)
  }

  static async find(id: string): Promise<PublicVoice | null> {
    if (this.isCacheValid() && this.cache.has(id)) return this.cache.get(id)!
    const [row] = await db.select().from(publicVoices).where(eq(publicVoices.id, id))
    if (!row) return null
    const item = new PublicVoice(row)
    this.cache.set(id, item)
    return item
  }

  /** The instance default profile, disabled or not; null if it was never synced. */
  static findDefault(): Promise<PublicVoice | null> {
    return this.find(DEFAULT_PUBLIC_VOICE_ID)
  }

  static async upsert(input: UpsertPublicVoiceInput): Promise<PublicVoice> {
    const hasDescription = Object.hasOwn(input, 'description')
    const surfaces = input.surfaces ?? {}
    await db
      .insert(publicVoices)
      .values({ id: input.id, name: input.name, description: input.description ?? null, base: input.base, surfaces })
      .onConflictDoUpdate({
        target: publicVoices.id,
        set: {
          name: input.name,
          ...(hasDescription ? { description: input.description ?? null } : {}),
          base: input.base,
          surfaces,
          updatedAt: new Date(),
        },
      })
    this.invalidateCache()
    return (await this.find(input.id))!
  }

  static async setDisabled(id: string, disabled: boolean): Promise<void> {
    await db.update(publicVoices).set({ disabled, updatedAt: new Date() }).where(eq(publicVoices.id, id))
    this.invalidateCache()
  }

  /** Deletes the profile; assigned squads fall back to the instance default (on delete set null). */
  static async delete(id: string): Promise<void> {
    await db.delete(publicVoices).where(eq(publicVoices.id, id))
    this.invalidateCache()
  }

  /** Number of squads assigned to each profile id (absent ids have none). */
  static async assignedSquadCounts(ids?: string[]): Promise<Map<string, number>> {
    const rows = await db
      .select({ id: squads.publicVoiceId, n: count() })
      .from(squads)
      .where(ids ? inArray(squads.publicVoiceId, ids) : undefined)
      .groupBy(squads.publicVoiceId)
    const result = new Map<string, number>()
    for (const row of rows) if (row.id) result.set(row.id, Number(row.n))
    return result
  }

  toProfile(): PublicVoiceProfile {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      base: this.base,
      surfaces: this.surfaces ?? {},
      disabled: this.disabled,
    }
  }

  toJson(): PublicVoiceProfileJson {
    const profile = this.toProfile()
    return {
      ...profile,
      hasTemplate: this.yamlTemplate != null,
      yamlFieldOverrides: (this.yamlFieldOverrides as string[] | null) ?? [],
      bytes: publicVoiceBytes(renderProfileAlone(profile)),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }
}
