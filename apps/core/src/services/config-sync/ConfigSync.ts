import { assertArrayLimit } from '../../lib/validation/request-collections'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { eq, getTableColumns } from 'drizzle-orm'
import type { PgTableWithColumns, PgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../db'
import { createLogger, type ScopedLogger } from '../../lib/infra/logger'

export interface SyncResult {
  synced: number
  skipped: number
  deleted: number
}

export interface TemplateDiff {
  hasDrift: boolean
  current: Record<string, unknown> | null
  template: Record<string, unknown> | null
  fieldOverrides: string[]
}

/**
 * Abstract base class for config sync domains.
 *
 * Handles: load YAML from directory, sync to DB with template tracking,
 * drift detection, diff computation, and revert-to-template.
 *
 * Domains can use either:
 * - legacy whole-record ownership (`updatedBy` + `yamlDrift`), or
 * - field-level ownership (`yamlFieldOverrides`).
 */
export abstract class ConfigSync<TYaml> {
  abstract readonly name: string
  abstract readonly directory: string

  // TODO: tighten types — using `any` for Drizzle table/column generics
  // to avoid complex type gymnastics. Runtime behavior is correct.
  abstract readonly table: PgTableWithColumns<any>
  abstract readonly idColumn: PgColumn
  readonly updatedByColumn?: PgColumn
  readonly yamlDriftColumn?: PgColumn
  abstract readonly yamlTemplateColumn: PgColumn
  readonly yamlFieldOverridesColumn?: PgColumn
  abstract readonly updatedAtColumn: PgColumn
  abstract readonly disabledColumn: PgColumn

  /** Cached map from DB column name → JS property name */
  private _colNameToJsKey: Map<string, string> | null = null

  private _log: ScopedLogger | null = null

  protected get log(): ScopedLogger {
    if (!this._log) {
      this._log = createLogger(`config-sync:${this.name}`)
    }
    return this._log
  }

  /**
   * Get the JS property name for a Drizzle column.
   * Drizzle's `column.name` returns the DB column name (snake_case),
   * but JS row objects and `.set()`/`.values()` use the camelCase property name.
   */
  protected jsKey(column: PgColumn): string {
    if (!this._colNameToJsKey) {
      this._colNameToJsKey = new Map()
      const cols = getTableColumns(this.table)
      for (const [jsKey, col] of Object.entries(cols)) {
        this._colNameToJsKey.set((col as PgColumn).name, jsKey)
      }
    }
    const key = this._colNameToJsKey.get(column.name)
    if (!key) throw new Error(`Column '${column.name}' not found in table`)
    return key
  }

  /**
   * Parse a YAML file's content into a typed object.
   * Should validate and throw on invalid content.
   */
  abstract parse(content: string, filename: string): TYaml

  /**
   * Convert parsed YAML into DB record values (data fields only,
   * not tracking columns like yamlTemplate/yamlFieldOverrides).
   */
  abstract toRecord(parsed: TYaml): Record<string, unknown>

  /**
   * Extract the ID from a parsed YAML object.
   */
  abstract getId(parsed: TYaml): string

  /**
   * Extract data fields from a DB row for comparison (excluding tracking columns).
   * Should return the same shape as toRecord().
   */
  abstract toComparable(row: Record<string, unknown>): Record<string, unknown>

  /**
   * Optional hook called after a record is synced (insert or update).
   * Use for catalog cache invalidation or spawning consultant agents.
   */
  async afterSync?(_id: string): Promise<void>

  // --------------------------------------------------------------------------
  // YAML Loading
  // --------------------------------------------------------------------------

  /**
   * Load and parse all YAML files from the directory.
   * Skips files starting with 'example-' or containing '.example.'.
   */
  async loadFromDir(): Promise<TYaml[]> {
    let files: string[]
    try {
      files = await readdir(this.directory)
    } catch {
      this.log.warn(`Directory not found: ${this.directory}`)
      return []
    }

    const yamlFiles = files.filter(
      (f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('example-') && !f.includes('.example.')
    )

    const results: TYaml[] = []
    for (const file of yamlFiles) {
      const content = await readFile(join(this.directory, file), 'utf-8')
      try {
        results.push(this.parse(content, file))
      } catch (error) {
        this.log.error(`Error parsing ${file}:`, error)
        throw error
      }
    }
    return results
  }

  // --------------------------------------------------------------------------
  // Sync
  // --------------------------------------------------------------------------

  /**
   * Sync YAML definitions to DB. API startup only.
   *
   * Field-level domains:
   * - Not in DB → insert with `yamlFieldOverrides=[]`
   * - In DB → update all non-overridden fields from YAML, preserve overridden fields
   * - In DB but not YAML, no overrides → delete
   * - In DB but not YAML, has overrides or no template → keep
   *
   * Legacy domains:
   * - Not in DB → insert with updatedBy='yaml'
   * - In DB, updatedBy='yaml' → overwrite, update template
   * - In DB, updatedBy='admin' → update template only, recompute drift
   * - In DB but not YAML, updatedBy='yaml' → delete
   * - In DB but not YAML, updatedBy='admin' → keep
   */
  /**
   * Insert bundled definitions that are missing from the DB and nothing else:
   * no updates, no deletes, no drift bookkeeping. For callers that need a few
   * bundled rows to exist outside the API boot sync (the demo seed), where the
   * full reconcile would be both too much and, on a shared test database,
   * liable to refuse. Restrict to `ids` to touch only what is needed.
   *
   * @returns the ids inserted.
   */
  async syncMissing(ids?: readonly string[]): Promise<string[]> {
    const wanted = ids ? new Set(ids) : null
    const parsed = (await this.loadFromDir()).filter((item) => !wanted || wanted.has(this.getId(item)))
    if (parsed.length === 0) return []
    const existing = new Set(
      (await db.select({ id: this.idColumn }).from(this.table)).map((row) => (row as { id: string }).id)
    )
    const inserted: string[] = []
    for (const item of parsed) {
      const id = this.getId(item)
      if (existing.has(id)) continue
      await this.insertNew(id, this.toRecord(item))
      inserted.push(id)
    }
    if (inserted.length) this.log.info(`Inserted missing ${this.name}: ${inserted.join(', ')}`)
    return inserted
  }

  private async insertNew(id: string, record: Record<string, unknown>): Promise<void> {
    await db.insert(this.table).values({
      ...record,
      [this.jsKey(this.yamlTemplateColumn)]: { ...record },
      ...this.legacyOwnershipSet('yaml', false),
      ...this.fieldOverridesSet([]),
    } as any)
    await this.afterSync?.(id)
  }

  async sync(): Promise<SyncResult> {
    const parsed = await this.loadFromDir()
    const yamlIds = new Set(parsed.map((p) => this.getId(p)))

    // Load all existing rows
    const existingRows = await db.select().from(this.table)
    const existingMap = new Map<string, Record<string, unknown>>()
    for (const row of existingRows) {
      const r = row as Record<string, unknown>
      existingMap.set(r[this.jsKey(this.idColumn)] as string, r)
    }

    let synced = 0
    let skipped = 0

    for (const item of parsed) {
      const id = this.getId(item)
      const record = this.toRecord(item)
      const template = { ...record }
      const existing = existingMap.get(id)

      if (!existing) {
        await this.insertNew(id, record)
        synced++
        continue
      }

      if (this.yamlFieldOverridesColumn) {
        const currentData = this.toComparable(existing)
        const storedOverrides = this.getStoredFieldOverrides(existing)
        const nextData = this.applyOverrideKeys(record, currentData, storedOverrides)
        const fieldOverrides = this.diffOverrideKeys(nextData, template)

        await db
          .update(this.table)
          .set({
            ...nextData,
            [this.jsKey(this.yamlTemplateColumn)]: template,
            ...this.fieldOverridesSet(fieldOverrides),
            [this.jsKey(this.updatedAtColumn)]: new Date(),
          } as any)
          .where(eq(this.idColumn, id))
        synced++
        await this.afterSync?.(id)
        continue
      }

      if (this.getLegacyUpdatedBy(existing) === 'yaml') {
        // Existing yaml-owned — overwrite all data fields
        await db
          .update(this.table)
          .set({
            ...record,
            [this.jsKey(this.yamlTemplateColumn)]: template,
            ...this.legacyOwnershipSet('yaml', false),
            [this.jsKey(this.updatedAtColumn)]: new Date(),
          } as any)
          .where(eq(this.idColumn, id))
        synced++
        await this.afterSync?.(id)
      } else {
        // Legacy admin-owned — update template only, recompute drift
        const currentData = this.toComparable(existing)
        const drift = !this.deepEqual(currentData, template)
        await db
          .update(this.table)
          .set({
            [this.jsKey(this.yamlTemplateColumn)]: template,
            ...this.legacyOwnershipSet('admin', drift),
          } as any)
          .where(eq(this.idColumn, id))
        skipped++
      }
    }

    // Delete YAML-owned records not in YAML files
    let deleted = 0
    for (const [id, row] of existingMap) {
      if (yamlIds.has(id)) continue

      if (this.yamlFieldOverridesColumn) {
        const template = row[this.jsKey(this.yamlTemplateColumn)]
        const fieldOverrides = this.getStoredFieldOverrides(row)
        if (template != null && fieldOverrides.length === 0) {
          await db.delete(this.table).where(eq(this.idColumn, id))
          deleted++
        }
        continue
      }

      if (this.getLegacyUpdatedBy(row) === 'yaml') {
        await db.delete(this.table).where(eq(this.idColumn, id))
        deleted++
      }
    }

    this.log.info(`Synced ${synced}, skipped ${skipped} admin-owned, deleted ${deleted}`)
    return { synced, skipped, deleted }
  }

  // --------------------------------------------------------------------------
  // Diff & Revert
  // --------------------------------------------------------------------------

  /**
   * Get the template diff for a record.
   */
  async getTemplateDiff(id: string): Promise<TemplateDiff> {
    const rows = await db.select().from(this.table).where(eq(this.idColumn, id))
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new Error(`${this.name} '${id}' not found`)

    const template = row[this.jsKey(this.yamlTemplateColumn)] as Record<string, unknown> | null
    const current = this.toComparable(row)
    const fieldOverrides = this.getFieldOverrides(row, current, template)

    return {
      hasDrift: this.yamlFieldOverridesColumn ? fieldOverrides.length > 0 : this.getLegacyYamlDrift(row),
      current,
      template,
      fieldOverrides,
    }
  }

  /**
   * Revert selected top-level fields to their YAML template values.
   */
  async revertTemplateFields(id: string, fields: string[]): Promise<void> {
    assertArrayLimit(fields, 100, 'template fields')
    const rows = await db.select().from(this.table).where(eq(this.idColumn, id))
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new Error(`${this.name} '${id}' not found`)

    const template = row[this.jsKey(this.yamlTemplateColumn)] as Record<string, unknown> | null
    if (!template) throw new Error(`${this.name} '${id}' has no YAML template`)

    const uniqueFields = [...new Set(fields)]
    const invalidFields = uniqueFields.filter((field) => !this.isValidTemplateKey(field, template))
    if (invalidFields.length > 0) {
      throw new Error(`Cannot revert unknown template field(s): ${invalidFields.join(', ')}`)
    }

    const current = this.toComparable(row)
    const nextData = this.applyTemplateKeys(current, template, uniqueFields)
    const fieldOverrides = this.diffOverrideKeys(nextData, template)
    const drift = fieldOverrides.length > 0

    await db
      .update(this.table)
      .set({
        ...nextData,
        ...this.fieldOverridesSet(fieldOverrides),
        ...this.legacyOwnershipSet(drift ? 'admin' : 'yaml', drift),
        [this.jsKey(this.updatedAtColumn)]: new Date(),
      } as any)
      .where(eq(this.idColumn, id))

    await this.afterSync?.(id)
    this.log.info(`Reverted fields for '${id}' to YAML template: ${uniqueFields.join(', ')}`)
  }

  /**
   * Recompute stored field overrides by comparing the current DB row to its YAML template.
   */
  async recomputeFieldOverrides(id: string): Promise<void> {
    if (!this.yamlFieldOverridesColumn) return

    const rows = await db.select().from(this.table).where(eq(this.idColumn, id))
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new Error(`${this.name} '${id}' not found`)

    const template = row[this.jsKey(this.yamlTemplateColumn)] as Record<string, unknown> | null
    if (!template) return

    const current = this.toComparable(row)
    await db
      .update(this.table)
      .set({
        ...this.fieldOverridesSet(this.diffOverrideKeys(current, template)),
        [this.jsKey(this.updatedAtColumn)]: new Date(),
      } as any)
      .where(eq(this.idColumn, id))
  }

  /**
   * Revert a record to its YAML template.
   */
  async revertToTemplate(id: string): Promise<void> {
    const rows = await db.select().from(this.table).where(eq(this.idColumn, id))
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new Error(`${this.name} '${id}' not found`)

    const template = row[this.jsKey(this.yamlTemplateColumn)] as Record<string, unknown> | null
    if (!template) throw new Error(`${this.name} '${id}' has no YAML template`)

    await db
      .update(this.table)
      .set({
        ...template,
        ...this.legacyOwnershipSet('yaml', false),
        ...this.fieldOverridesSet([]),
        [this.jsKey(this.updatedAtColumn)]: new Date(),
      } as any)
      .where(eq(this.idColumn, id))

    await this.afterSync?.(id)
    this.log.info(`Reverted '${id}' to YAML template`)
  }

  // --------------------------------------------------------------------------
  // Disable / Enable
  // --------------------------------------------------------------------------

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    await db
      .update(this.table)
      .set({
        [this.jsKey(this.disabledColumn)]: disabled,
        [this.jsKey(this.updatedAtColumn)]: new Date(),
      } as any)
      .where(eq(this.idColumn, id))
    this.log.info(`${disabled ? 'Disabled' : 'Enabled'} '${id}'`)
  }

  // --------------------------------------------------------------------------
  // YAML Export
  // --------------------------------------------------------------------------

  /**
   * Serialize a DB row back to YAML format for export.
   * Each subclass implements domain-specific field mapping.
   */
  abstract toYaml(row: Record<string, unknown>): string

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  protected deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(this.sortKeys(a)) === JSON.stringify(this.sortKeys(b))
  }

  private legacyOwnershipSet(updatedBy: 'yaml' | 'admin', yamlDrift: boolean): Record<string, unknown> {
    if (!this.updatedByColumn || !this.yamlDriftColumn) return {}
    return {
      [this.jsKey(this.updatedByColumn)]: updatedBy,
      [this.jsKey(this.yamlDriftColumn)]: yamlDrift,
    }
  }

  private getLegacyUpdatedBy(row: Record<string, unknown>): string {
    if (!this.updatedByColumn) return 'yaml'
    return (row[this.jsKey(this.updatedByColumn)] as string | undefined) ?? 'yaml'
  }

  private getLegacyYamlDrift(row: Record<string, unknown>): boolean {
    if (!this.yamlDriftColumn) return false
    return (row[this.jsKey(this.yamlDriftColumn)] as boolean | undefined) ?? false
  }

  private fieldOverridesSet(fieldOverrides: string[]): Record<string, unknown> {
    if (!this.yamlFieldOverridesColumn) return {}
    return { [this.jsKey(this.yamlFieldOverridesColumn)]: fieldOverrides }
  }

  private getStoredFieldOverrides(row: Record<string, unknown>): string[] {
    if (!this.yamlFieldOverridesColumn) return []
    const value = row[this.jsKey(this.yamlFieldOverridesColumn)]
    return Array.isArray(value) ? value.filter((field): field is string => typeof field === 'string') : []
  }

  private getFieldOverrides(
    row: Record<string, unknown>,
    current: Record<string, unknown>,
    template: Record<string, unknown> | null
  ): string[] {
    if (!template) return []
    if (this.yamlFieldOverridesColumn) return this.getStoredFieldOverrides(row)
    if (this.getLegacyUpdatedBy(row) === 'admin') return this.diffOverrideKeys(current, template)
    return []
  }

  protected isValidTemplateKey(field: string, template: Record<string, unknown>): boolean {
    return field !== 'id' && Object.hasOwn(template, field)
  }

  protected diffOverrideKeys(current: Record<string, unknown>, template: Record<string, unknown>): string[] {
    return Object.keys(template).filter((field) => field !== 'id' && !this.deepEqual(current[field], template[field]))
  }

  protected applyOverrideKeys(
    record: Record<string, unknown>,
    current: Record<string, unknown>,
    fieldOverrides: string[]
  ): Record<string, unknown> {
    const next = { ...record }
    for (const field of fieldOverrides) {
      if (Object.hasOwn(current, field)) {
        next[field] = current[field]
      }
    }
    return next
  }

  protected applyTemplateKeys(
    current: Record<string, unknown>,
    template: Record<string, unknown>,
    fields: string[]
  ): Record<string, unknown> {
    return {
      ...current,
      ...Object.fromEntries(fields.map((field) => [field, template[field]])),
    }
  }

  private sortKeys(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj
    if (Array.isArray(obj)) return obj.map((item) => this.sortKeys(item))
    if (typeof obj === 'object') {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = this.sortKeys((obj as Record<string, unknown>)[key])
      }
      return sorted
    }
    return obj
  }
}
