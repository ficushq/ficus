import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverTests } from '../scripts/test-runner'
import { lateTestDatabaseImports } from './test-db-import-graph'

test('late DB-import detection follows runtime imports/reexports, not types; readiness and hoisted imports are safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-import-graph-'))
  try {
    const source = (name: string, text: string) => {
      const file = join(dir, name)
      writeFileSync(file, text)
      return file
    }
    mkdirSync(join(dir, 'db'))
    const database = source('db/index.ts', 'export const db = {}')
    const readiness = source('ready.ts', 'export {}')
    source('service.ts', "export {db} from './db'")
    source('pure.ts', "import type {db} from './db'; export const value = 1")
    const late = source('late.test.ts', "test('late', async () => { await import('./service') })")
    const safe = source('safe.test.ts', "import './ready'; test('late', async () => { await import('./service') })")
    const hoisted = source(
      'hoisted.test.ts',
      "await import('./service'); test('late', async () => { await import('./service') })"
    )
    const unawaited = source(
      'unawaited.test.ts',
      "import('./service'); test('later', async () => { await import('./service') })"
    )
    const pure = source('pure.test.ts', "test('pure', async () => { await import('./pure') })")
    expect(lateTestDatabaseImports([late, safe, hoisted, pure], { database, readiness })).toEqual([
      { file: late, module: './service', line: 1 },
    ])
    expect(lateTestDatabaseImports([unawaited], { database, readiness })).toHaveLength(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Core test-body DB imports cannot charge cold schema setup to a test timeout', () => {
  const root = resolve(import.meta.dir, '..')
  const core = join(root, 'apps/core')
  const violations = lateTestDatabaseImports(
    discoverTests(core, ['src']).map((file) => resolve(core, file)),
    {
      database: join(core, 'src/db/index.ts'),
      readiness: join(core, 'src/test-utils/require-test-db.ts'),
    }
  )
  expect(violations).toEqual([])
}, 30000) // Audits the complete Core source import graph, not just a focused test file.
