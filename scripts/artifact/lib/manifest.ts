import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export type CoreArtifactPlatform = 'linux-x64' | 'darwin-arm64'

export function artifactPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): CoreArtifactPlatform {
  const target = `${platform}-${arch}`
  if (target !== 'linux-x64' && target !== 'darwin-arm64')
    throw new Error(`Unsupported Core artifact target: ${target}`)
  return target
}

/**
 * The manifest written into a core release artifact tree as `artifact.json`.
 * `schema` is a literal `1` so a future incompatible layout can be detected by
 * readers before they trust any other field.
 */
export interface CoreArtifactManifest {
  schema: 1
  commit: string
  commitDate: string
  bun: string
  platform: CoreArtifactPlatform
  builder: string
  /**
   * The env-name prefix this release reads (`FICUS_*`). The host toolkit keys
   * the one-time `TAU_*` -> `FICUS_*` env rename on it, falling back to the
   * root package name for trees without it (git checkouts, pre-rename
   * artifacts). Optional so readers of older manifests stay valid.
   */
  envPrefix?: 'FICUS'
  /** relpath (POSIX `/` separators, relative to the artifact root) -> `sha256:<hex>` of the file's bytes. */
  files: Record<string, string>
  digest: string
}

/**
 * Recursively walk `rootDir` and hash every regular file's bytes.
 *
 * Symlinks anywhere in the tree — files or directories — are refused: the
 * artifact is meant to be an immutable, fully content-addressed tree, and a
 * symlink lets its target drift (or escape the tree) without the digest
 * changing. `artifact.json` at the ROOT of `rootDir` is excluded because the
 * manifest is written into the tree only after this walk runs (it can't hash
 * itself); a nested file that happens to be named `artifact.json` is a normal
 * file and IS included.
 */
export async function computeFilesMap(rootDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing to include symlink in artifact tree: ${fullPath}`)
      }
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      const relPath = relative(rootDir, fullPath).split(sep).join('/')
      if (relPath === 'artifact.json') continue
      const bytes = await readFile(fullPath)
      files[relPath] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }
  }

  await walk(rootDir)
  return files
}

/**
 * `sha256:<hex>` over the JSON of `files` with keys sorted lexicographically,
 * so the digest is independent of insertion/traversal order (`readdir` makes
 * no ordering guarantee across platforms).
 */
export function computeDigest(files: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`
}

/**
 * Build the full manifest for a release artifact tree rooted at `opts.rootDir`.
 *
 * The `files` map is emitted with its keys sorted lexicographically — the same
 * canonical order {@link computeDigest} hashes — so the serialized
 * `artifact.json` is stable across builds (readdir order is directory-hash
 * order on APFS/ext4, not alphabetical) and diffable by a human.
 */
export async function buildManifest(opts: {
  rootDir: string
  commit: string
  commitDate: string
  bun: string
  builder: string
  platform?: CoreArtifactPlatform
}): Promise<CoreArtifactManifest> {
  const walked = await computeFilesMap(opts.rootDir)
  const files = Object.fromEntries(Object.entries(walked).sort(([a], [b]) => (a < b ? -1 : 1)))
  return {
    schema: 1,
    commit: opts.commit,
    commitDate: opts.commitDate,
    bun: opts.bun,
    platform: opts.platform ?? artifactPlatform(),
    builder: opts.builder,
    envPrefix: 'FICUS',
    files,
    digest: computeDigest(files),
  }
}

/** Sign `manifestBytes` (the serialized manifest.json) with an Ed25519 PKCS8 PEM private key. */
export function signManifest(manifestBytes: Uint8Array, privateKeyPem: string): string {
  const keyObject = createPrivateKey(privateKeyPem)
  return sign(null, manifestBytes, keyObject).toString('base64')
}

/**
 * Verify an Ed25519 signature over `manifestBytes` against an SPKI PEM public
 * key. Returns `false` on a signature mismatch (never throws for that case);
 * a malformed key still throws, since that is a caller/config error rather
 * than "this artifact failed verification".
 */
export function verifyManifestSignature(manifestBytes: Uint8Array, sigBase64: string, publicKeyPem: string): boolean {
  const keyObject = createPublicKey(publicKeyPem)
  return verify(null, manifestBytes, keyObject, Buffer.from(sigBase64, 'base64'))
}
