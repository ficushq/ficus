import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** A runner-lifetime cache, invalidated by either source changes or live DDL drift. */
export function createTestSchemaCache(file: string, key: string, dump: () => string | null) {
  return {
    matches() {
      if (!existsSync(file)) return false
      try {
        const stored = JSON.parse(readFileSync(file, 'utf8'))
        if (stored.key !== key) return false
        const current = dump()
        return current !== null && stored.fingerprint === hash(current)
      } catch {
        return false
      }
    },
    record() {
      const current = dump()
      if (current !== null) writeFileSync(file, JSON.stringify({ key, fingerprint: hash(current) }), { mode: 0o600 })
    },
  }
}

export function runnerTestSchemaCache(databaseUrl: string) {
  const file = process.env.FICUS_TEST_SCHEMA_CACHE_FILE
  if (!file) return undefined
  const root = resolve(import.meta.dir, '../../../..')
  const inputs = [join(root, 'bun.lock'), join(root, 'apps/core/src/test-setup.ts')]
  function collect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) inputs.push(path)
    }
  }
  collect(join(root, 'apps/core/src/db'))
  collect(join(root, 'packages/shared/src'))
  const key = hash([databaseUrl, Bun.version, ...inputs.sort().map((path) => readFileSync(path, 'utf8'))].join('\0'))
  return createTestSchemaCache(file, key, () => {
    // Fingerprint defaults, enums, constraints, indexes, functions and triggers,
    // not just columns. A missing client/failed probe is a cache miss.
    try {
      const result = Bun.spawnSync(
        ['pg_dump', '--dbname', databaseUrl, '--schema-only', '--schema', 'public', '--no-owner', '--no-privileges'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5_000,
        }
      )
      if (result.exitCode !== 0 || result.signalCode) return null
      // New pg_dump versions generate a random psql restriction token per dump.
      return result.stdout
        .toString()
        .split('\n')
        .filter((line) => !/^\\(?:un)?restrict /.test(line))
        .join('\n')
    } catch {
      return null
    }
  })
}
