import { eq, inArray } from 'drizzle-orm'
import { db, agentTypes } from '../db'
import type { AgentType as AgentTypeJson, AgentTypeIntegrationPolicyV1 } from '@ficus/shared'
import type { InferSelectModel } from 'drizzle-orm'

export type AgentTypeRow = InferSelectModel<typeof agentTypes>

export interface CreateAgentTypeInput {
  systemOnly?: boolean
  id: string
  name: string
  model?: string
  tier?: string | null
  description?: string
  systemPrompt: string
  includes?: string[]
  skills?: string[]
  extensions?: string[]
  toolsAllow?: string[]
  toolsDeny?: string[]
  integrationCapabilities?: AgentTypeIntegrationPolicyV1 | null
  earlyMarginTokens?: number | null
  inFlightMarginTokens?: number | null
}

export type UpsertAgentTypeInput = CreateAgentTypeInput

/**
 * AgentType entity class.
 *
 * NOTE: This class does NOT extend BaseEntity because agent types are
 * definition-synced (loaded from YAML files) rather than user-created.
 * It uses caching for performance since types are read frequently but
 * modified infrequently.
 */
export class AgentType implements AgentTypeRow {
  // Row fields
  declare systemOnly: boolean
  declare id: string
  declare name: string
  declare model: string
  declare tier: string | null
  declare description: string | null
  declare systemPrompt: string
  declare includes: string[]
  declare skills: string[] | null
  declare extensions: string[] | null
  declare toolsAllow: string[] | null
  declare toolsDeny: string[] | null
  declare integrationCapabilities: AgentTypeIntegrationPolicyV1 | null
  declare earlyMarginTokens: number | null
  declare extraScopes: string[] | null
  declare inFlightMarginTokens: number | null
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: string[]
  declare disabled: boolean
  declare createdAt: Date
  declare updatedAt: Date

  // Cache. Entries carry their own timestamps: the old design had one global
  // `lastCacheRefresh` that ONLY list() ever set, so in a process that never
  // happened to call list(), isCacheValid() was false forever and every
  // find() hit the DB — hauling the full row (multi-KB system_prompt, skills,
  // extensions) each time. Measured on a live tenant (2026-09-01): agent_types
  // fetches were in flight in 44% of pg_stat_activity samples under agent
  // load. Per-entry timestamps make find()'s own populates count.
  private static cache: Map<string, { agentType: AgentType; at: number }> = new Map()
  private static allCached: AgentType[] | null = null
  private static cacheTimeout = 60_000 // 1 minute
  private static lastCacheRefresh = 0

  constructor(row: AgentTypeRow) {
    Object.assign(this, row)
  }

  // ---------------------------------------------------------------------------
  // Cache Management
  // ---------------------------------------------------------------------------

  private static isCacheValid(): boolean {
    return Date.now() - this.lastCacheRefresh < this.cacheTimeout
  }

  private static cachedEntry(id: string): AgentType | null {
    const entry = this.cache.get(id)
    if (!entry) return null
    if (Date.now() - entry.at > this.cacheTimeout) {
      this.cache.delete(id)
      return null
    }
    return entry.agentType
  }

  /**
   * Invalidate the cache (call after upsert/create).
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
   * Find an agent type by ID.
   */
  static async find(id: string): Promise<AgentType | null> {
    const cached = this.cachedEntry(id)
    if (cached) return cached

    const [row] = await db.select().from(agentTypes).where(eq(agentTypes.id, id))
    if (!row) return null

    const agentType = new AgentType(row)
    this.cache.set(id, { agentType, at: Date.now() })
    return agentType
  }

  /**
   * Batch-load agent types by id (cached-first, one query for the misses).
   * Exists for N+1 elimination in list paths (Agent.list hydration); returns a
   * map keyed by agent type id — absent entries were not found.
   */
  static async findMany(ids: string[]): Promise<Map<string, AgentType>> {
    const out = new Map<string, AgentType>()
    const misses: string[] = []
    for (const id of [...new Set(ids)]) {
      const cached = this.cachedEntry(id)
      if (cached) out.set(id, cached)
      else misses.push(id)
    }
    if (misses.length > 0) {
      const rows = await db.select().from(agentTypes).where(inArray(agentTypes.id, misses))
      const at = Date.now()
      for (const row of rows) {
        const agentType = new AgentType(row)
        this.cache.set(agentType.id, { agentType, at })
        out.set(agentType.id, agentType)
      }
    }
    return out
  }

  /**
   * Find an agent type by ID, throwing if not found.
   */
  static async mustFind(id: string): Promise<AgentType> {
    const agentType = await this.find(id)
    if (!agentType) throw new Error(`Agent type ${id} not found`)
    return agentType
  }

  /**
   * List all agent types.
   */
  static async list(): Promise<AgentType[]> {
    // Check cache first
    if (this.isCacheValid() && this.allCached) {
      return this.allCached
    }

    const results = await db.select().from(agentTypes)
    const agentTypesList = results.map((row) => new AgentType(row))

    // Populate caches
    this.allCached = agentTypesList
    const at = Date.now()
    for (const agentType of agentTypesList) {
      this.cache.set(agentType.id, { agentType, at })
    }
    this.lastCacheRefresh = at

    return agentTypesList
  }

  /**
   * Create a new agent type.
   */
  static async create(input: CreateAgentTypeInput): Promise<AgentType> {
    await db.insert(agentTypes).values({
      systemOnly: input.systemOnly ?? false,
      id: input.id,
      model: input.model ?? '',
      tier: input.tier ?? null,
      name: input.name,
      description: input.description ?? null,
      systemPrompt: input.systemPrompt,
      includes: input.includes ?? [],
      skills: input.skills ?? null,
      extensions: input.extensions ?? null,
      toolsAllow: input.toolsAllow ?? null,
      toolsDeny: input.toolsDeny ?? null,
      integrationCapabilities: input.integrationCapabilities ?? null,
      earlyMarginTokens: input.earlyMarginTokens ?? null,
      inFlightMarginTokens: input.inFlightMarginTokens ?? null,
    })

    this.invalidateCache()
    return this.mustFind(input.id)
  }

  /**
   * Upsert an agent type (insert or update).
   */
  static async upsert(input: UpsertAgentTypeInput): Promise<void> {
    await db
      .insert(agentTypes)
      .values({
        systemOnly: input.systemOnly ?? false,
        id: input.id,
        model: input.model ?? '',
        tier: input.tier ?? null,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        includes: input.includes ?? [],
        skills: input.skills ?? null,
        extensions: input.extensions ?? null,
        toolsAllow: input.toolsAllow ?? null,
        toolsDeny: input.toolsDeny ?? null,
        integrationCapabilities: input.integrationCapabilities ?? null,
        earlyMarginTokens: input.earlyMarginTokens ?? null,
        inFlightMarginTokens: input.inFlightMarginTokens ?? null,
      })
      .onConflictDoUpdate({
        target: agentTypes.id,
        set: {
          ...(input.systemOnly !== undefined ? { systemOnly: input.systemOnly } : {}),
          model: input.model ?? '',
          tier: input.tier ?? null,
          name: input.name,
          description: input.description ?? null,
          systemPrompt: input.systemPrompt,
          includes: input.includes ?? [],
          skills: input.skills ?? null,
          extensions: input.extensions ?? null,
          toolsAllow: input.toolsAllow ?? null,
          toolsDeny: input.toolsDeny ?? null,
          integrationCapabilities: input.integrationCapabilities ?? null,
          earlyMarginTokens: input.earlyMarginTokens ?? null,
          inFlightMarginTokens: input.inFlightMarginTokens ?? null,
          updatedAt: new Date(),
        },
      })

    this.invalidateCache()
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  /**
   * Reload this agent type from the database.
   */
  async reload(): Promise<this> {
    const fresh = await AgentType.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJson(): AgentTypeJson {
    return {
      systemOnly: this.systemOnly,
      id: this.id,
      name: this.name,
      model: this.model,
      tier: this.tier,
      description: this.description,
      systemPrompt: this.systemPrompt,
      includes: this.includes ?? [],
      skills: this.skills,
      extensions: this.extensions,
      toolsAllow: this.toolsAllow,
      toolsDeny: this.toolsDeny,
      integrationCapabilities: this.integrationCapabilities,
      earlyMarginTokens: this.earlyMarginTokens,
      inFlightMarginTokens: this.inFlightMarginTokens,
      yamlFieldOverrides: this.yamlFieldOverrides ?? [],
      hasTemplate: this.yamlTemplate != null,
      disabled: this.disabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }
}
