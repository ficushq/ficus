import { eq } from 'drizzle-orm'
import { db, squadPresets } from '../db'
import { squadPresetWorkflowsSchema, type SquadPreset as SquadPresetJson } from '@ficus/shared'
import type { ScheduleTemplateYaml } from '../services/config-sync'
import type { InferSelectModel } from 'drizzle-orm'

export type SquadPresetRow = InferSelectModel<typeof squadPresets>

export interface UpsertSquadPresetInput {
  id: string
  name: string
  description?: string
  purpose?: string
  defaultAgents?: string[]
  managerInstructions?: string
  workflows?: import('@ficus/shared').SquadPresetWorkflows | null
  scheduleTemplates?: ScheduleTemplateYaml[]
}

/**
 * SquadPreset entity class.
 *
 * NOTE: This class does NOT extend BaseEntity because squad presets are
 * definition-synced (loaded from YAML files) rather than user-created.
 * It uses caching for performance since presets are read frequently but
 * modified infrequently.
 */
export class SquadPreset implements SquadPresetRow {
  // Row fields
  declare id: string
  declare name: string
  declare description: string | null
  declare purpose: string | null
  declare defaultAgents: string[]
  declare managerInstructions: string | null
  declare workflows: import('@ficus/shared').SquadPresetWorkflows | null
  declare scheduleTemplates: ScheduleTemplateYaml[]
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: string[]
  declare disabled: boolean
  declare createdAt: Date
  declare updatedAt: Date

  // Cache
  private static cache: Map<string, SquadPreset> = new Map()
  private static allCached: SquadPreset[] | null = null
  private static cacheTimeout = 60_000 // 1 minute
  private static lastCacheRefresh = 0

  constructor(row: SquadPresetRow) {
    Object.assign(this, row)

    // Normalize jsonb fields
    this.defaultAgents = (row.defaultAgents as string[]) ?? []
    this.scheduleTemplates = (row.scheduleTemplates as ScheduleTemplateYaml[]) ?? []
  }

  // ---------------------------------------------------------------------------
  // Cache Management
  // ---------------------------------------------------------------------------

  private static isCacheValid(): boolean {
    return Date.now() - this.lastCacheRefresh < this.cacheTimeout
  }

  /**
   * Invalidate the cache (call after upsert).
   */
  static invalidateCache(): void {
    this.cache.clear()
    this.allCached = null
    this.lastCacheRefresh = 0
  }

  // ---------------------------------------------------------------------------
  // Static Methods
  // ---------------------------------------------------------------------------

  /**
   * Find a squad preset by ID.
   */
  static async find(id: string): Promise<SquadPreset | null> {
    // Check cache first
    if (this.isCacheValid() && this.cache.has(id)) {
      return this.cache.get(id)!
    }

    const [row] = await db.select().from(squadPresets).where(eq(squadPresets.id, id))
    if (!row) return null

    const squadPreset = new SquadPreset(row)
    this.cache.set(id, squadPreset)
    return squadPreset
  }

  /**
   * Find a squad preset by ID, throwing if not found.
   */
  static async mustFind(id: string): Promise<SquadPreset> {
    const squadPreset = await this.find(id)
    if (!squadPreset) throw new Error(`Squad preset ${id} not found`)
    return squadPreset
  }

  /**
   * List all squad presets.
   */
  static async list(): Promise<SquadPreset[]> {
    // Check cache first
    if (this.isCacheValid() && this.allCached) {
      return this.allCached
    }

    const results = await db.select().from(squadPresets)
    const squadPresetsList = results.map((row) => new SquadPreset(row))

    // Populate caches
    this.allCached = squadPresetsList
    for (const st of squadPresetsList) {
      this.cache.set(st.id, st)
    }
    this.lastCacheRefresh = Date.now()

    return squadPresetsList
  }

  /**
   * Upsert a squad preset (insert or update).
   */
  static async upsert(input: UpsertSquadPresetInput): Promise<void> {
    const workflows = input.workflows == null ? null : squadPresetWorkflowsSchema.parse(input.workflows)
    await db
      .insert(squadPresets)
      .values({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        purpose: input.purpose ?? null,
        defaultAgents: input.defaultAgents ?? [],
        managerInstructions: input.managerInstructions ?? null,
        workflows,
        scheduleTemplates: input.scheduleTemplates ?? [],
      })
      .onConflictDoUpdate({
        target: squadPresets.id,
        set: {
          name: input.name,
          description: input.description ?? null,
          purpose: input.purpose ?? null,
          defaultAgents: input.defaultAgents ?? [],
          managerInstructions: input.managerInstructions ?? null,
          workflows,
          scheduleTemplates: input.scheduleTemplates ?? [],
          updatedAt: new Date(),
        },
      })

    this.invalidateCache()
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Reload this squad preset from the database.
   */
  async reload(): Promise<this> {
    const fresh = await SquadPreset.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJson(): SquadPresetJson {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      purpose: this.purpose,
      defaultAgents: this.defaultAgents,
      managerInstructions: this.managerInstructions,
      workflows: this.workflows,
      yamlFieldOverrides: this.yamlFieldOverrides ?? [],
      hasTemplate: this.yamlTemplate != null,
      disabled: this.disabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }
}
