import { eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import type { SharedPrompt as SharedPromptJson } from '@ficus/shared'
import { db, sharedPrompts } from '../db'

export type SharedPromptRow = InferSelectModel<typeof sharedPrompts>

export interface UpsertSharedPromptInput {
  id: string
  name: string
  description?: string | null
  content: string
}

/**
 * A shared prompt block. Cached like AgentType/Skill: runners compose the
 * system prompt on every turn, so lookups must not hit Postgres each time.
 */
export class SharedPrompt implements SharedPromptRow {
  declare id: string
  declare name: string
  declare description: string | null
  declare content: string
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: string[]
  declare disabled: boolean
  declare createdAt: Date
  declare updatedAt: Date

  private static cache = new Map<string, SharedPrompt>()
  private static allCached: SharedPrompt[] | null = null
  private static lastCacheRefresh = 0
  private static cacheTimeout = 60_000

  constructor(row: SharedPromptRow) {
    Object.assign(this, row)
  }

  private static isCacheValid(): boolean {
    return Date.now() - this.lastCacheRefresh < this.cacheTimeout
  }

  static invalidateCache(): void {
    this.cache.clear()
    this.allCached = null
    this.lastCacheRefresh = 0
  }

  static async list(options: { includeDisabled?: boolean } = {}): Promise<SharedPrompt[]> {
    if (!this.isCacheValid() || !this.allCached) {
      const rows = await db.select().from(sharedPrompts).orderBy(sharedPrompts.id)
      this.allCached = rows.map((row) => new SharedPrompt(row))
      this.cache.clear()
      for (const item of this.allCached) this.cache.set(item.id, item)
      this.lastCacheRefresh = Date.now()
    }
    return options.includeDisabled ? this.allCached : this.allCached.filter((i) => !i.disabled)
  }

  static async find(id: string): Promise<SharedPrompt | null> {
    if (this.isCacheValid() && this.cache.has(id)) return this.cache.get(id)!
    const [row] = await db.select().from(sharedPrompts).where(eq(sharedPrompts.id, id))
    if (!row) return null
    const item = new SharedPrompt(row)
    this.cache.set(id, item)
    return item
  }

  static async mustFind(id: string): Promise<SharedPrompt> {
    const item = await this.find(id)
    if (!item) throw new Error(`Shared prompt ${id} not found`)
    return item
  }

  /** Preserves the caller's order; missing ids are simply absent from the map. */
  static async findMany(ids: string[]): Promise<Map<string, SharedPrompt>> {
    const result = new Map<string, SharedPrompt>()
    if (ids.length === 0) return result
    const all = await this.list({ includeDisabled: true })
    const byId = new Map(all.map((i) => [i.id, i]))
    for (const id of ids) {
      const hit = byId.get(id)
      if (hit) result.set(id, hit)
    }
    return result
  }

  static async upsert(input: UpsertSharedPromptInput): Promise<void> {
    // `description` is left out of the update set entirely when the caller
    // omits it, so a content-only edit doesn't blow away an existing
    // description (which would otherwise show up as a spurious field
    // override on the next sync). Passing `description: null` explicitly
    // still clears it.
    const hasDescription = Object.hasOwn(input, 'description')
    await db
      .insert(sharedPrompts)
      .values({ id: input.id, name: input.name, description: input.description ?? null, content: input.content })
      .onConflictDoUpdate({
        target: sharedPrompts.id,
        set: {
          name: input.name,
          ...(hasDescription ? { description: input.description ?? null } : {}),
          content: input.content,
          updatedAt: new Date(),
        },
      })
    this.invalidateCache()
  }

  static async delete(id: string): Promise<void> {
    await db.delete(sharedPrompts).where(eq(sharedPrompts.id, id))
    this.invalidateCache()
  }

  toJson(): SharedPromptJson {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      content: this.content,
      yamlFieldOverrides: this.yamlFieldOverrides ?? [],
      hasTemplate: this.yamlTemplate != null,
      disabled: this.disabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }
}
