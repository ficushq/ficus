const LEGACY_MIGRATION_MANIFEST_SCHEMA = 'foreign-box-migration/v1' as const
import { describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import {
  MIGRATION_MANIFEST_SCHEMA,
  compareMigrationManifests,
  createMigrationManifest,
  parseMigrationManifest,
  type ManifestEntryV1,
  type MigrationRootInput,
} from './migration-manifest'

const identity = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sandboxId: 'agent_11111111-1111-1111-1111-111111111111',
  source: { machineId: 'source', generation: 1, unixUser: 'box_0123456789ab' },
  target: { machineId: 'target', generation: 2, unixUser: 'box_0123456789ab' },
}
const b64 = (value: string) => Buffer.from(value).toString('base64')
const file = (path: string, contentSha256 = 'a'.repeat(64)): ManifestEntryV1 => ({
  pathB64: b64(path),
  type: 'file',
  mode: '644',
  size: '3',
  contentSha256,
})
const roots = (...workspaceEntries: ManifestEntryV1[]): MigrationRootInput[] => [
  { name: 'workspace', presence: 'present', mode: '755', owner: 'box-user', entries: workspaceEntries },
  { name: '.private', presence: 'absent', entries: [] },
]

describe('migration manifest v1', () => {
  it('canonicalizes hidden, empty, nested, Unicode, spaces, and newline paths independent of input order', () => {
    const entries: ManifestEntryV1[] = [
      file('.hidden'),
      { pathB64: b64('empty'), type: 'directory', mode: '700' },
      file('nested/hello world/λ\nname'),
      { pathB64: b64('link'), type: 'symlink', mode: '777', targetB64: b64('nested/hello world') },
    ]
    const left = createMigrationManifest(identity, roots(...entries))
    const right = createMigrationManifest(identity, roots(...entries.toReversed()))

    expect(left).toEqual(right)
    expect(left.totals).toEqual({ files: 2, directories: 1, bytes: '6' })
    expect(left.roots[0].treeSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(left.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('distinguishes an absent root from an empty present root', () => {
    const absent = createMigrationManifest(identity, roots())
    const present = createMigrationManifest(identity, [
      { name: 'workspace', presence: 'present', mode: '755', owner: 'box-user', entries: [] },
      { name: '.private', presence: 'present', mode: '700', owner: 'box-user', entries: [] },
    ])

    expect(compareMigrationManifests(absent, present)).toEqual({
      ok: false,
      type: 'target-root-presence-mismatch',
      root: '.private',
    })
  })

  it('rejects changed durable-root mode even when entries are identical', () => {
    const source = createMigrationManifest(identity, roots(file('same')))
    const observed = createMigrationManifest(identity, [{ ...roots(file('same'))[0], mode: '700' }, roots()[1]])
    expect(compareMigrationManifests(source, observed)).toEqual({
      ok: false,
      type: 'target-metadata-mismatch',
      root: 'workspace',
    })
  })

  it('reports exact missing, extra, metadata, and content mismatches', () => {
    const source = createMigrationManifest(identity, roots(file('one'), file('two')))
    const missing = createMigrationManifest(identity, roots(file('one')))
    const extra = createMigrationManifest(identity, roots(file('one'), file('two'), file('three')))
    const metadata = createMigrationManifest(identity, roots({ ...file('one'), mode: '600' }, file('two')))
    const content = createMigrationManifest(identity, roots(file('one', 'b'.repeat(64)), file('two')))

    expect(compareMigrationManifests(source, missing)).toMatchObject({ ok: false, type: 'target-entry-missing' })
    expect(compareMigrationManifests(source, extra)).toMatchObject({ ok: false, type: 'target-extra-entry' })
    expect(compareMigrationManifests(source, metadata)).toMatchObject({ ok: false, type: 'target-metadata-mismatch' })
    expect(compareMigrationManifests(source, content)).toMatchObject({ ok: false, type: 'target-content-mismatch' })
    expect(compareMigrationManifests(source, source)).toEqual({ ok: true })
  })

  it.each([
    ['parent traversal', file('../escape')],
    ['absolute path', file('/escape')],
    ['NUL path', file('bad\0path')],
    ['escaping symlink', { pathB64: b64('link'), type: 'symlink', mode: '777', targetB64: b64('../../escape') }],
    ['absolute symlink', { pathB64: b64('link'), type: 'symlink', mode: '777', targetB64: b64('/escape') }],
  ] as const)('rejects %s', (_name, entry) => {
    expect(() => createMigrationManifest(identity, roots(entry as ManifestEntryV1))).toThrow()
  })

  it('rejects duplicate decoded paths and malformed base64', () => {
    expect(() => createMigrationManifest(identity, roots(file('same'), file('same')))).toThrow(/duplicate/i)
    expect(() => createMigrationManifest(identity, roots({ ...file('x'), pathB64: '***' }))).toThrow(/base64/i)
  })

  it('rejects unsupported entries, ownership, corrupt totals, schema, and digest', () => {
    expect(() =>
      createMigrationManifest(identity, [{ ...roots()[0], owner: 'root' as 'box-user' }, roots()[1]])
    ).toThrow(/owner/i)
    expect(() =>
      createMigrationManifest(identity, roots({ pathB64: b64('pipe'), type: 'fifo', mode: '600' } as never))
    ).toThrow(/type/i)

    const valid = createMigrationManifest(identity, roots(file('safe')))
    expect(() => parseMigrationManifest({ ...valid, schema: 'ficus-box-migration/v2' })).toThrow(/schema/i)
    expect(() => parseMigrationManifest({ ...valid, totals: { ...valid.totals, files: 99 } })).toThrow(/totals/i)
    expect(() => parseMigrationManifest({ ...valid, manifestSha256: '0'.repeat(64) })).toThrow(/digest/i)
  })

  it('writes and reads only ficus-box-migration/v1', () => {
    const written = createMigrationManifest(identity, roots(file('safe')))
    expect(written.schema).toBe(MIGRATION_MANIFEST_SCHEMA)
    expect(MIGRATION_MANIFEST_SCHEMA).toBe('ficus-box-migration/v1')

    const { manifestSha256: _digest, ...body } = written
    const legacyBody = { ...body, schema: LEGACY_MIGRATION_MANIFEST_SCHEMA }
    const legacy = {
      ...legacyBody,
      manifestSha256: createHash('sha256').update(JSON.stringify(legacyBody)).digest('hex'),
    }
    expect(() => parseMigrationManifest(legacy)).toThrow(/schema/i)
  })
})
