import { describe, expect, it } from 'bun:test'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { HOME_PATH_COLUMNS, homePathColumnKey, NON_HOME_PATH_COLUMNS, PATH_LIKE_COLUMN } from './home-path-columns'
import { homePathTableKey } from '../scripts/rebase-home'

const tables = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table))
const columnsByKey = new Map<string, PgColumn>(
  tables.flatMap((table) => table.columns.map((column) => [`${table.name}.${column.name}`, column] as const))
)
const TEXTUAL = new Set(['PgText', 'PgVarchar', 'PgJsonb'])

describe('HOME path column registry', () => {
  it('classifies every path-like text/varchar/jsonb column exactly once', () => {
    // A new column whose name ends in path/dir/cwd/worktree/file fails here until it is added to
    // HOME_PATH_COLUMNS (rebase-home rewrites it when HOME moves) or NON_HOME_PATH_COLUMNS (reviewed
    // as never holding a path under HOME_DIR).
    const home = new Set(HOME_PATH_COLUMNS.map((entry) => `${entry.table}.${entry.column}`))
    const non = new Set(NON_HOME_PATH_COLUMNS)
    const unclassified: string[] = []
    const both: string[] = []
    for (const [key, column] of columnsByKey) {
      if (!TEXTUAL.has(column.columnType) || !PATH_LIKE_COLUMN.test(column.name)) continue
      if (home.has(key) && non.has(key)) both.push(key)
      else if (!home.has(key) && !non.has(key)) unclassified.push(key)
    }
    expect(unclassified).toEqual([])
    expect(both).toEqual([])
    // The guard sees the columns it is meant to see (a broken walk would pass vacuously).
    expect(home.has('inbox_attachments.storage_path')).toBe(true)
    expect(columnsByKey.get('inbox_attachments.storage_path')?.columnType).toBe('PgText')
    expect(columnsByKey.get('monitors.cwd')?.columnType).toBe('PgVarchar')
  })

  it('names only real columns, of a type matching their kind', () => {
    for (const entry of HOME_PATH_COLUMNS) {
      const column = columnsByKey.get(`${entry.table}.${entry.column}`)
      expect(column, homePathColumnKey(entry)).toBeDefined()
      const expected = entry.kind === 'text' ? ['PgText', 'PgVarchar'] : ['PgJsonb']
      expect(expected, homePathColumnKey(entry)).toContain(column!.columnType)
      if (entry.kind === 'jsonb-string')
        expect(entry.jsonPath?.length ?? 0, homePathColumnKey(entry)).toBeGreaterThan(0)
      else expect(entry.jsonPath, homePathColumnKey(entry)).toBeUndefined()
    }
    for (const key of NON_HOME_PATH_COLUMNS) {
      expect(columnsByKey.has(key), key).toBe(true)
      expect(PATH_LIKE_COLUMN.test(key.split('.')[1]!), key).toBe(true)
    }
    expect(new Set(NON_HOME_PATH_COLUMNS).size).toBe(NON_HOME_PATH_COLUMNS.length)
  })

  it('has unique keys, and a single-column primary key on every table for the batches', () => {
    const keys = HOME_PATH_COLUMNS.map(homePathColumnKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const table of new Set(HOME_PATH_COLUMNS.map((entry) => entry.table))) {
      expect(() => homePathTableKey(table), table).not.toThrow()
    }
  })

  it('covers the columns the live-fleet audit found HOME paths in', () => {
    // P5-T0 Step 5b: messages.metadata (noah 545, chowmein 14) and inbox_attachments.storage_path (noah 9).
    const byKey = new Map(HOME_PATH_COLUMNS.map((entry) => [homePathColumnKey(entry), entry.kind]))
    expect(byKey.get('messages.metadata')).toBe('jsonb-text')
    expect(byKey.get('inbox_attachments.storage_path')).toBe('text')
    expect(byKey.get('work_stream_worktrees.ownership.worktree')).toBe('jsonb-string')
    expect(byKey.get('squads.host_workspace_path')).toBe('text')
  })
})
