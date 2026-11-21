import { and, count, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  publicVoiceBytes,
  renderProfileAlone,
  type PublicVoiceProfile,
  type PublicVoiceProfileJson,
  type PublicVoiceSurfaces,
} from '@ficus/shared'
import { db, publicVoices, settings, squads } from '../db'

export type PublicVoiceRow = InferSelectModel<typeof publicVoices>

/**
 * The admin's choice of instance default, in the plain settings table. Config sync never writes
 * it; no row means the shipped `default` profile.
 */
export const INSTANCE_DEFAULT_VOICE_SETTING_KEY = 'public-voice:instance-default'

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
  /** The chosen instance default id, refreshed with the profiles; null means the shipped `default`. */
  private static chosenDefaultId: string | null = null
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
    this.chosenDefaultId = null
    this.lastCacheRefresh = 0
  }

  static async list(options: { includeDisabled?: boolean } = {}): Promise<PublicVoice[]> {
    if (!this.isCacheValid() || !this.allCached) {
      const [rows, [choice]] = await Promise.all([
        db.select().from(publicVoices).orderBy(publicVoices.id),
        db.select({ value: settings.value }).from(settings).where(eq(settings.key, INSTANCE_DEFAULT_VOICE_SETTING_KEY)),
      ])
      this.allCached = rows.map((row) => new PublicVoice(row))
      this.cache.clear()
      for (const item of this.allCached) this.cache.set(item.id, item)
      this.chosenDefaultId = choice?.value || null
      this.lastCacheRefresh = Date.now()
    }
    return options.includeDisabled ? this.allCached : this.allCached.filter((item) => !item.disabled)
  }

  /**
   * Profiles are few, so a miss or an expired cache reloads them all through `list`, which also
   * refreshes the cache timestamp. Runners call this every turn.
   */
  static async find(id: string): Promise<PublicVoice | null> {
    if (!this.isCacheValid() || !this.allCached) await this.list()
    return this.cache.get(id) ?? null
  }

  /**
   * The shipped `default` profile, disabled or not; null if it was never synced. It is the instance
   * default unless an admin chose another (`instanceDefaultId`), and always the fallback.
   */
  static findDefault(): Promise<PublicVoice | null> {
    return this.find(DEFAULT_PUBLIC_VOICE_ID)
  }

  /** The id of the profile chosen as the instance default, whether or not it is usable. */
  static async instanceDefaultId(): Promise<string> {
    if (!this.isCacheValid() || !this.allCached) await this.list()
    return this.chosenDefaultId ?? DEFAULT_PUBLIC_VOICE_ID
  }

  /**
   * Choose the instance default. Choosing the shipped `default` removes the stored choice. Callers
   * check that the profile exists and is enabled. Invalidates the cache, so every squad on the
   * instance default picks the change up on its next prompt.
   */
  static async setInstanceDefaultId(id: string, updatedBy?: string | null): Promise<void> {
    if (id === DEFAULT_PUBLIC_VOICE_ID) {
      await db.delete(settings).where(eq(settings.key, INSTANCE_DEFAULT_VOICE_SETTING_KEY))
    } else {
      const values = { value: id, updatedAt: new Date(), updatedBy: updatedBy ?? null }
      await db
        .insert(settings)
        .values({ key: INSTANCE_DEFAULT_VOICE_SETTING_KEY, ...values })
        .onConflictDoUpdate({ target: settings.key, set: values })
    }
    this.invalidateCache()
  }

  /** Insert-only person-created profiles. A concurrent id collision must never overwrite a draft. */
  static async create(input: UpsertPublicVoiceInput): Promise<PublicVoice | null> {
    const [row] = await db
      .insert(publicVoices)
      .values({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        base: input.base,
        surfaces: input.surfaces ?? {},
      })
      .onConflictDoNothing({ target: publicVoices.id })
      .returning()
    if (!row) return null
    this.invalidateCache()
    return new PublicVoice(row)
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

  /**
   * Deletes the profile; assigned squads fall back to the instance default (on delete set null).
   * Deleting the chosen instance default also clears that choice, so the shipped `default` applies.
   */
  static async delete(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(publicVoices).where(eq(publicVoices.id, id))
      await tx.delete(settings).where(and(eq(settings.key, INSTANCE_DEFAULT_VOICE_SETTING_KEY), eq(settings.value, id)))
    })
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
