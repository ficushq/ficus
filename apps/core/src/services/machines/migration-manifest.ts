import { createHash } from 'crypto'
import { posix } from 'path'

export const MIGRATION_MANIFEST_SCHEMA = 'ficus-box-migration/v1' as const
/** Bridge (phase 5, U4): the kind manifests carried before the rename. Still read, never written. */
export type MigrationManifestSchema = typeof MIGRATION_MANIFEST_SCHEMA
export type DurableRootName = 'workspace' | '.private'
export type ManifestEntryV1 =
  | { pathB64: string; type: 'file'; mode: string; size: string; contentSha256: string }
  | { pathB64: string; type: 'directory'; mode: string }
  | { pathB64: string; type: 'symlink'; mode: string; targetB64: string }

export interface MigrationRootInput {
  name: DurableRootName
  presence: 'absent' | 'present'
  mode?: string
  owner?: 'box-user'
  entries: ManifestEntryV1[]
}

export interface MigrationManifestV1 {
  schema: MigrationManifestSchema
  operationId: string
  sandboxId: string
  source: { machineId: string; generation: number | null; unixUser: string }
  target: { machineId: string; generation: number | null; unixUser: string }
  roots: Array<
    MigrationRootInput & {
      fileCount: number
      directoryCount: number
      totalBytes: string
      treeSha256: string
    }
  >
  totals: { files: number; directories: number; bytes: string }
  manifestSha256: string
}

export type ManifestMismatch =
  | { ok: true }
  | {
      ok: false
      type:
        | 'target-root-presence-mismatch'
        | 'target-entry-missing'
        | 'target-extra-entry'
        | 'target-metadata-mismatch'
        | 'target-content-mismatch'
      root: DurableRootName
      pathB64?: string
    }

const SHA256 = /^[a-f0-9]{64}$/
const MODE = /^[0-7]{3,4}$/
const ROOT_ORDER: readonly DurableRootName[] = ['workspace', '.private']

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value)
}

function decodeBase64(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`invalid base64 ${label}`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`invalid base64 ${label}`)
  const decoded = bytes.toString('utf8')
  if (!Buffer.from(decoded).equals(bytes)) throw new Error(`${label} is not UTF-8`)
  if (decoded.includes('\0')) throw new Error(`${label} contains NUL`)
  return decoded
}

function validateRelativePath(path: string, label: string): void {
  if (path.startsWith('/') || path === '' || path === '.' || path === '..' || path.split('/').includes('..')) {
    throw new Error(`${label} escapes its durable root`)
  }
  if (posix.normalize(path) !== path || path.split('/').includes('')) throw new Error(`${label} is not canonical`)
}

function validateMode(mode: unknown): asserts mode is string {
  if (typeof mode !== 'string' || !MODE.test(mode)) throw new Error('invalid entry mode')
}

function validateEntry(entry: ManifestEntryV1): { entry: ManifestEntryV1; decodedPath: string } {
  if (!entry || typeof entry !== 'object') throw new Error('invalid manifest entry')
  const decodedPath = decodeBase64(entry.pathB64, 'entry path')
  validateRelativePath(decodedPath, 'entry path')
  validateMode(entry.mode)
  if (entry.type === 'file') {
    if (!/^(0|[1-9][0-9]*)$/.test(entry.size) || !SHA256.test(entry.contentSha256))
      throw new Error('invalid file metadata')
  } else if (entry.type === 'symlink') {
    const target = decodeBase64(entry.targetB64, 'symlink target')
    if (target.startsWith('/') || target === '') throw new Error('symlink target escapes its durable root')
    const resolved = posix.normalize(posix.join(posix.dirname(decodedPath), target))
    validateRelativePath(resolved, 'symlink target')
  } else if (entry.type !== 'directory') {
    throw new Error('unsupported manifest entry type')
  }
  return { entry: { ...entry }, decodedPath }
}

function canonicalRoot(input: MigrationRootInput) {
  if (!ROOT_ORDER.includes(input.name)) throw new Error('invalid durable root')
  if (input.presence !== 'present' && input.presence !== 'absent') throw new Error('invalid root presence')
  if (!Array.isArray(input.entries)) throw new Error('invalid root entries')
  if (input.presence === 'absent') {
    if (input.entries.length || input.mode !== undefined || input.owner !== undefined)
      throw new Error('absent root has metadata')
  } else {
    validateMode(input.mode)
    if (input.owner !== 'box-user') throw new Error('invalid root owner')
  }
  const validated = input.entries.map(validateEntry)
  const seen = new Set<string>()
  for (const item of validated) {
    if (seen.has(item.decodedPath)) throw new Error(`duplicate manifest path: ${item.decodedPath}`)
    seen.add(item.decodedPath)
  }
  const entries = validated
    .sort((a, b) => Buffer.compare(Buffer.from(a.entry.pathB64), Buffer.from(b.entry.pathB64)))
    .map(({ entry }) => entry)
  const fileCount = entries.filter((entry) => entry.type === 'file').length
  const directoryCount = entries.filter((entry) => entry.type === 'directory').length
  const totalBytes = entries
    .reduce((total, entry) => total + (entry.type === 'file' ? BigInt(entry.size) : 0n), 0n)
    .toString()
  const rootWithoutDigest = {
    name: input.name,
    presence: input.presence,
    ...(input.presence === 'present' ? { mode: input.mode, owner: input.owner } : {}),
    entries,
    fileCount,
    directoryCount,
    totalBytes,
  }
  return { ...rootWithoutDigest, treeSha256: sha256(canonicalJson(rootWithoutDigest)) }
}

export function createMigrationManifest(
  identity: Omit<MigrationManifestV1, 'schema' | 'roots' | 'totals' | 'manifestSha256'>,
  rootInputs: MigrationRootInput[],
  schema: MigrationManifestSchema = MIGRATION_MANIFEST_SCHEMA
): MigrationManifestV1 {
  if (!identity || typeof identity !== 'object') throw new Error('invalid manifest identity')
  const rootsByName = new Map(rootInputs.map((root) => [root.name, root]))
  if (rootsByName.size !== ROOT_ORDER.length || rootInputs.length !== ROOT_ORDER.length)
    throw new Error('manifest must contain each durable root exactly once')
  const roots = ROOT_ORDER.map((name) => {
    const root = rootsByName.get(name)
    if (!root) throw new Error(`missing durable root ${name}`)
    return canonicalRoot(root)
  })
  const totals = {
    files: roots.reduce((sum, root) => sum + root.fileCount, 0),
    directories: roots.reduce((sum, root) => sum + root.directoryCount, 0),
    bytes: roots.reduce((sum, root) => sum + BigInt(root.totalBytes), 0n).toString(),
  }
  const withoutDigest = { schema, ...identity, roots, totals }
  return { ...withoutDigest, manifestSha256: sha256(canonicalJson(withoutDigest)) }
}

export function parseMigrationManifest(input: unknown): MigrationManifestV1 {
  if (!input || typeof input !== 'object') throw new Error('invalid migration manifest')
  const candidate = input as MigrationManifestV1
  if (candidate.schema !== MIGRATION_MANIFEST_SCHEMA) throw new Error('unsupported migration manifest schema')
  const rebuilt = createMigrationManifest(
    {
      operationId: candidate.operationId,
      sandboxId: candidate.sandboxId,
      source: candidate.source,
      target: candidate.target,
    },
    candidate.roots,
    candidate.schema
  )
  if (canonicalJson(candidate.totals) !== canonicalJson(rebuilt.totals))
    throw new Error('migration manifest totals mismatch')
  if (candidate.manifestSha256 !== rebuilt.manifestSha256) throw new Error('migration manifest digest mismatch')
  return rebuilt
}

export function compareMigrationManifests(
  source: MigrationManifestV1,
  observed: MigrationManifestV1
): ManifestMismatch {
  const expected = parseMigrationManifest(source)
  const actual = parseMigrationManifest(observed)
  for (const name of ROOT_ORDER) {
    const left = expected.roots.find((root) => root.name === name)!
    const right = actual.roots.find((root) => root.name === name)!
    if (left.presence !== right.presence) return { ok: false, type: 'target-root-presence-mismatch', root: name }
    if (left.mode !== right.mode || left.owner !== right.owner)
      return { ok: false, type: 'target-metadata-mismatch', root: name }
    const leftEntries = new Map(left.entries.map((entry) => [entry.pathB64, entry]))
    const rightEntries = new Map(right.entries.map((entry) => [entry.pathB64, entry]))
    for (const [pathB64, entry] of leftEntries) {
      const found = rightEntries.get(pathB64)
      if (!found) return { ok: false, type: 'target-entry-missing', root: name, pathB64 }
      if (
        entry.type !== found.type ||
        entry.mode !== found.mode ||
        (entry.type === 'file' && entry.size !== (found as ManifestEntryV1 & { size: string }).size) ||
        (entry.type === 'symlink' && entry.targetB64 !== (found as ManifestEntryV1 & { targetB64: string }).targetB64)
      ) {
        return { ok: false, type: 'target-metadata-mismatch', root: name, pathB64 }
      }
      if (
        entry.type === 'file' &&
        entry.contentSha256 !== (found as ManifestEntryV1 & { contentSha256: string }).contentSha256
      )
        return { ok: false, type: 'target-content-mismatch', root: name, pathB64 }
    }
    for (const pathB64 of rightEntries.keys())
      if (!leftEntries.has(pathB64)) return { ok: false, type: 'target-extra-entry', root: name, pathB64 }
  }
  return { ok: true }
}
