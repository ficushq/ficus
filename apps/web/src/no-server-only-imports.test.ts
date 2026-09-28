import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/**
 * Provider adapters and the broker protocol belong on the server. Public constants
 * live in separate, dependency-free modules such as @ficus/shared/github-app.
 * Scan shipped source conservatively (including dynamic imports and require calls).
 * Test files are not browser entrypoints and may reference server modules in fixtures.
 */
const FORBIDDEN = ['@ficus/shared/oauth-providers', '@ficus/shared/oauth-broker']

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx)$/.test(entry) && !/[._](test|spec)\.[cm]?[jt]sx?$/.test(entry)) yield path
  }
}

function offenders(root: string): string[] {
  return [...sources(root)]
    .filter((path) => {
      const source = readFileSync(path, 'utf8')
      return FORBIDDEN.some((moduleName) => source.includes(moduleName))
    })
    .map((path) => relative(root, path))
    .sort()
}

describe('web bundle boundary', () => {
  test('apps/web imports no server-only shared subpath', () => {
    expect(offenders(import.meta.dir)).toEqual([])
  })

  test('the scanner sees real browser source files', () => {
    expect([...sources(import.meta.dir)].length).toBeGreaterThan(20)
  })

  test('catches forbidden imports in nested source without treating test fixtures as shipped code', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-import-boundary-'))
    try {
      mkdirSync(join(root, 'nested'))
      writeFileSync(join(root, 'nested/provider.tsx'), "import { adapter } from '@ficus/shared/oauth-providers'\n")
      writeFileSync(join(root, 'broker.ts'), "export * from '@ficus/shared/oauth-broker'\n")
      writeFileSync(join(root, 'dynamic.ts'), "import('@ficus/shared/oauth-providers/github/client')\n")
      writeFileSync(join(root, 'require.ts'), "require('@ficus/shared/oauth-broker')\n")
      writeFileSync(join(root, 'safe.ts'), "import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/github-app'\n")
      for (const name of ['fixture.test.ts', 'fixture.test.tsx', 'fixture.spec.ts', 'fixture_spec.tsx']) {
        writeFileSync(join(root, name), "const fixture = '@ficus/shared/oauth-broker'\n")
      }
      expect(offenders(root)).toEqual(['broker.ts', 'dynamic.ts', 'nested/provider.tsx', 'require.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
