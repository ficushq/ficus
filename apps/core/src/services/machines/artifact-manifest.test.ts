import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, test } from 'bun:test'
import {
  artifactPlatform,
  buildManifest,
  computeDigest,
  computeFilesMap,
  type CoreArtifactManifest,
  signManifest,
  verifyManifestSignature,
} from '../../../../../scripts/artifact/lib/manifest'

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function makeFixtureTree(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'artifact-manifest-fixture-'))
  await writeFile(join(rootDir, 'top.txt'), 'top-level file\n')
  await mkdir(join(rootDir, 'nested', 'deeper'), { recursive: true })
  await writeFile(join(rootDir, 'nested', 'mid.txt'), 'nested file\n')
  await writeFile(join(rootDir, 'nested', 'deeper', 'leaf.txt'), 'deeply nested file\n')
  return rootDir
}

describe('computeDigest', () => {
  it('is deterministic across different key insertion orders', () => {
    const a = { 'b.txt': 'sha256:bbb', 'a.txt': 'sha256:aaa', 'c.txt': 'sha256:ccc' }
    const b = { 'c.txt': 'sha256:ccc', 'a.txt': 'sha256:aaa', 'b.txt': 'sha256:bbb' }
    expect(computeDigest(a)).toBe(computeDigest(b))
  })

  it('matches a hand-computed sha256 over the lexicographically-sorted JSON', () => {
    const files = { 'b.txt': 'sha256:bbb', 'a.txt': 'sha256:aaa' }
    const expected = `sha256:${sha256Hex(JSON.stringify({ 'a.txt': 'sha256:aaa', 'b.txt': 'sha256:bbb' }))}`
    expect(computeDigest(files)).toBe(expected)
  })

  it('changes when a value changes', () => {
    const a = { 'a.txt': 'sha256:aaa' }
    const b = { 'a.txt': 'sha256:zzz' }
    expect(computeDigest(a)).not.toBe(computeDigest(b))
  })
})

describe('computeFilesMap', () => {
  it('walks a nested fixture tree and matches hand-computed sha256 values', async () => {
    const rootDir = await makeFixtureTree()
    try {
      const files = await computeFilesMap(rootDir)
      expect(files).toEqual({
        'top.txt': `sha256:${sha256Hex('top-level file\n')}`,
        'nested/mid.txt': `sha256:${sha256Hex('nested file\n')}`,
        'nested/deeper/leaf.txt': `sha256:${sha256Hex('deeply nested file\n')}`,
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('excludes a root-level artifact.json but includes a nested one', async () => {
    const rootDir = await makeFixtureTree()
    try {
      await writeFile(join(rootDir, 'artifact.json'), '{"schema":1}')
      await mkdir(join(rootDir, 'config'), { recursive: true })
      await writeFile(join(rootDir, 'config', 'artifact.json'), '{"nested":true}')

      const files = await computeFilesMap(rootDir)
      expect(files['artifact.json']).toBeUndefined()
      expect(files['config/artifact.json']).toBe(`sha256:${sha256Hex('{"nested":true}')}`)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('throws when the tree contains a symlink', async () => {
    const rootDir = await makeFixtureTree()
    try {
      await symlink(join(rootDir, 'top.txt'), join(rootDir, 'nested', 'link.txt'))
      await expect(computeFilesMap(rootDir)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe('buildManifest', () => {
  it('produces a manifest whose digest matches computeDigest(files) and excludes artifact.json', async () => {
    const rootDir = await makeFixtureTree()
    try {
      const manifest = await buildManifest({
        rootDir,
        commit: 'deadbeef',
        commitDate: '2026-08-25T00:00:00Z',
        bun: '1.3.8',
        builder: 'test-builder',
      })
      expect(manifest.schema).toBe(1)
      expect(manifest.commit).toBe('deadbeef')
      expect(manifest.commitDate).toBe('2026-08-25T00:00:00Z')
      expect(manifest.bun).toBe('1.3.8')
      expect(manifest.platform).toBe(artifactPlatform())
      expect(manifest.builder).toBe('test-builder')
      expect(manifest.files['artifact.json']).toBeUndefined()
      expect(manifest.digest).toBe(computeDigest(manifest.files))
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('declares the Ficus host layout (hostLayout 2) next to envPrefix, which the host toolkit reads', async () => {
    const rootDir = await makeFixtureTree()
    try {
      const manifest = await buildManifest({
        rootDir,
        commit: 'deadbeef',
        commitDate: '2026-08-25T00:00:00Z',
        bun: '1.3.8',
        builder: 'test-builder',
      })
      expect(manifest.envPrefix).toBe('FICUS')
      expect(manifest.hostLayout).toBe(2)
      // Serialized as the toolkit's jq reads it (`.hostLayout`), a number.
      expect(JSON.parse(JSON.stringify(manifest)).hostLayout).toBe(2)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('still types and parses a manifest from before hostLayout (an older release)', () => {
    const older: CoreArtifactManifest = {
      schema: 1,
      commit: 'deadbeef',
      commitDate: '2026-08-25T00:00:00Z',
      bun: '1.3.8',
      platform: 'linux-x64',
      builder: 'test-builder',
      envPrefix: 'FICUS',
      files: {},
      digest: computeDigest({}),
    }
    const parsed = JSON.parse(JSON.stringify(older)) as CoreArtifactManifest
    expect(parsed.hostLayout).toBeUndefined()
    expect(parsed.digest).toBe(computeDigest({}))
  })

  it('returns a lexicographically key-sorted files map even when the walk finds them out of order', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'artifact-manifest-order-'))
    try {
      // `readdir` yields directory-hash order on APFS/ext4, not alphabetical
      // order, so an unsorted map comes back in scrambled walk order. Forty
      // entries makes "scrambled happens to equal sorted" vanishingly
      // unlikely; the assertion below is on buildManifest's contract, which
      // must hold whatever order the walk produced.
      const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
      for (const name of names) await writeFile(join(rootDir, name), `${name}\n`)

      const manifest = await buildManifest({
        rootDir,
        commit: 'deadbeef',
        commitDate: '2026-08-25T00:00:00Z',
        bun: '1.3.8',
        builder: 'test-builder',
      })
      const keys = Object.keys(manifest.files)
      expect(keys).toEqual([...names])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe('signManifest / verifyManifestSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

  it('round-trips: a signature from the private key verifies against the public key', () => {
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const sig = signManifest(manifestBytes, privateKeyPem)
    expect(verifyManifestSignature(manifestBytes, sig, publicKeyPem)).toBe(true)
  })

  it('returns false when a manifest byte is tampered with after signing', () => {
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const sig = signManifest(manifestBytes, privateKeyPem)
    const tampered = new TextEncoder().encode(JSON.stringify({ hello: 'wOrld' }))
    expect(verifyManifestSignature(tampered, sig, publicKeyPem)).toBe(false)
  })

  it('returns false when verified against the wrong public key', () => {
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const sig = signManifest(manifestBytes, privateKeyPem)
    const other = generateKeyPairSync('ed25519')
    const otherPublicKeyPem = other.publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(verifyManifestSignature(manifestBytes, sig, otherPublicKeyPem)).toBe(false)
  })
})

test('native artifact target never relabels unsupported binaries', () => {
  expect(artifactPlatform('darwin', 'arm64')).toBe('darwin-arm64')
  expect(artifactPlatform('linux', 'x64')).toBe('linux-x64')
  expect(() => artifactPlatform('darwin', 'x64')).toThrow('Unsupported')
  expect(() => artifactPlatform('linux', 'arm64')).toThrow('Unsupported')
})
