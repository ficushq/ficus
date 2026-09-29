import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestSchemaCache } from '../apps/core/src/test-utils/schema-cache'

test('schema reuse requires both identical inputs and a successful identical live DDL fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ficus-schema-cache-'))
  try {
    const file = join(dir, 'cache.json')
    let ddl: string | null = 'table + foreign key + partial index'
    const cache = createTestSchemaCache(file, 'source-and-db-identity', () => ddl)
    expect(cache.matches()).toBe(false)
    cache.record()
    expect(cache.matches()).toBe(true)
    expect(createTestSchemaCache(file, 'another-database-or-schema', () => ddl).matches()).toBe(false)
    ddl = 'table + foreign key'
    expect(cache.matches()).toBe(false)
    ddl = null
    expect(cache.matches()).toBe(false)
    writeFileSync(file, 'malformed')
    expect(cache.matches()).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
