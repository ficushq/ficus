/**
 * Base entity architecture patterns
 *
 * Entities wrap database rows with domain logic. They:
 * - Load from DB via drizzle-orm InferSelectModel
 * - Serialize to JSON types from @ficus/shared
 * - Cache relations via lazy-loading getters
 *
 * See Agent.ts for a full implementation example.
 */

import type { SQL } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Type Definitions (for documentation - can't enforce static methods)
// ---------------------------------------------------------------------------

/**
 * Expected static methods on entity classes.
 * TypeScript can't enforce abstract static methods, but entities should implement these.
 */
export interface EntityStatics<Entity, CreateInput, UpdateInput, ListFilters = Record<string, any>> {
  /** Columns for select queries, potentially with computed values (e.g., subqueries, aggregates) */
  selectColumns: Record<string, SQL | unknown>

  /** Find by ID (supports UUID prefix matching). Returns null if not found. */
  find(id: string): Promise<Entity | null>

  /** Find by ID, throwing if not found. */
  mustFind(id: string): Promise<Entity>

  /** Create a new entity. */
  create(input: CreateInput): Promise<Entity>

  /** Update by ID. */
  update(id: string, input: UpdateInput): Promise<Entity>

  /** List with optional filters. */
  list(filters?: ListFilters): Promise<Entity[]>
}

// ---------------------------------------------------------------------------
// Input Interfaces Pattern
// ---------------------------------------------------------------------------

/**
 * Example input interfaces - define these for each entity:
 *
 * export interface CreateFooInput {
 *   name: string
 *   // ... required fields
 * }
 *
 * export interface UpdateFooInput {
 *   name?: string
 *   // ... optional fields
 * }
 *
 * export interface ListFoosFilters {
 *   status?: string
 *   // ... filter options
 * }
 *
 * export interface ListFoosResult {
 *   items: Foo[]
 *   pagination: { hasMore: boolean; totalCount: number }
 * }
 */

// ---------------------------------------------------------------------------
// Base Entity Class
// ---------------------------------------------------------------------------

export abstract class BaseEntity<JsonType extends Record<string, any>, UpdateInput extends Record<string, any>> {
  /**
   * Row fields - use `declare` for DB columns:
   *
   *   declare id: string
   *   declare name: string
   *   declare createdAt: Date
   *   declare updatedAt: Date
   */

  /**
   * Computed fields - set defaults for optional/computed values:
   *
   *   lastMessageAt: Date | null = null
   */

  /**
   * Relation cache - lazy-load via getters:
   *
   *   private _parent?: Parent | null
   *
   *   async getParent(): Promise<Parent | null> {
   *     if (this._parent === undefined) {
   *       this._parent = await Parent.find(this.parentId)
   *     }
   *     return this._parent
   *   }
   *
   *   async mustGetParent(): Promise<Parent> {
   *     const parent = await this.getParent()
   *     if (!parent) throw new Error(`Parent ${this.parentId} not found`)
   *     return parent
   *   }
   */

  /**
   * Constructor pattern:
   *
   *   constructor(data: FooRow) {
   *     super()
   *     Object.assign(this, data)
   *     // Normalize computed fields
   *     if (typeof this.someDate === 'string') {
   *       this.someDate = new Date(this.someDate)
   *     }
   *   }
   */

  /**
   * Eager-load relations after find/list. Override in subclasses:
   *
   *   protected async eagerLoadRelations(): Promise<void> {
   *     await Promise.allSettled([this.getParent(), this.getChildren()])
   *   }
   */
  protected async eagerLoadRelations(): Promise<void> {
    // Override in subclasses to eager-load relations
  }

  /**
   * Update this entity in-place. Typically delegates to static update():
   *
   *   async update(input: UpdateFooInput): Promise<this> {
   *     const updated = await Foo.update(this.id, input)
   *     Object.assign(this, updated)
   *     return this
   *   }
   */
  abstract update(input: UpdateInput): Promise<this>

  /**
   * Reload this entity from the database:
   *
   *   async reload(): Promise<this> {
   *     const fresh = await Foo.mustFind(this.id)
   *     Object.assign(this, fresh)
   *     return this
   *   }
   */
  abstract reload(): Promise<this>

  /**
   * Serialize to JSON type from @ficus/shared:
   *
   *   toJson(): FooJson {
   *     return {
   *       id: this.id,
   *       name: this.name,
   *       // ... map all fields
   *     }
   *   }
   */
  abstract toJson(): JsonType
}
