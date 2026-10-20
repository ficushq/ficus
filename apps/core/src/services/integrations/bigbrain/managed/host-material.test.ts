import { afterEach, expect, test } from 'bun:test'
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { ManagedReadMaterialError, readManagedReadHandoff, splitReadHandoff } from './host-material'

const VAULT = '22222222-2222-4222-8222-222222222222'
const owner = process.getuid!()
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const handoff = {
  contractVersion: 1,
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  vaultId: VAULT,
  hostEpoch: 1,
  generation: 1,
  upstreamVaultId: '33333333-3333-4333-8333-333333333333',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  credentialId: '0123abcd',
  kind: 'agent',
  scopes: ['read'],
  followsMember: false,
  token: `sv_0123abcd_${'A'.repeat(43)}`,
}
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-handoff-'))
  roots.push(root)
  const dir = join(root, 'read-handoff')
  await mkdir(dir, { mode: 0o700 })
  return dir
}
async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedReadMaterialError)
    expect(String((error as Error).message)).not.toContain('sv_')
    return (error as ManagedReadMaterialError).code
  }
  throw new Error('expected a refusal')
}

test('reads a well-formed owner-only handoff and splits the token from persistable facts', async () => {
  const dir = await directory()
  await writeFile(join(dir, `${VAULT}.json`), JSON.stringify(handoff), { mode: 0o600 })
  const read = await readManagedReadHandoff(VAULT, { directory: dir, owner })
  expect(read).toEqual(handoff as never)
  const { material, token } = splitReadHandoff(read!)
  expect(token).toBe(handoff.token)
  expect(JSON.stringify(material)).not.toContain('sv_')
})

test('absent directory or file means not yet written, never an error', async () => {
  const dir = await directory()
  expect(await readManagedReadHandoff(VAULT, { directory: dir, owner })).toBeNull()
  expect(await readManagedReadHandoff(VAULT, { directory: join(dir, 'missing'), owner })).toBeNull()
})

test('symlinks, hard links, loose modes, another owner and oversize files are refused', async () => {
  const dir = await directory()
  const target = join(dir, '..', 'elsewhere.json')
  await writeFile(target, JSON.stringify(handoff), { mode: 0o600 })
  await symlink(target, join(dir, `${VAULT}.json`))
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('storage_unavailable')
  await rm(join(dir, `${VAULT}.json`))
  await link(target, join(dir, `${VAULT}.json`))
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('storage_unavailable')
  await rm(join(dir, `${VAULT}.json`))
  await writeFile(join(dir, `${VAULT}.json`), JSON.stringify(handoff), { mode: 0o604 })
  await chmod(join(dir, `${VAULT}.json`), 0o604)
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('storage_unavailable')
  await chmod(join(dir, `${VAULT}.json`), 0o600)
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner: owner + 1 }))).toBe('storage_unavailable')
  await writeFile(join(dir, `${VAULT}.json`), JSON.stringify({ ...handoff, pad: 'x'.repeat(5000) }), { mode: 0o600 })
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('storage_unavailable')
  await chmod(dir, 0o777)
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('storage_unavailable')
})

test('a writer, following, foreign-vault or malformed handoff is never imported', async () => {
  const dir = await directory()
  for (const bad of [
    { ...handoff, scopes: ['read', 'write'] },
    { ...handoff, followsMember: true },
    { ...handoff, kind: 'person' },
    { ...handoff, vaultId: '44444444-4444-4444-8444-444444444444' },
    { ...handoff, token: `sv_ffffffff_${'A'.repeat(43)}` },
    { ...handoff, extra: 1 },
  ]) {
    await writeFile(join(dir, `${VAULT}.json`), JSON.stringify(bad), { mode: 0o600 })
    expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('invalid_response')
  }
  await writeFile(join(dir, `${VAULT}.json`), 'not json', { mode: 0o600 })
  expect(await code(readManagedReadHandoff(VAULT, { directory: dir, owner }))).toBe('invalid_response')
  expect(await code(readManagedReadHandoff('../etc/passwd', { directory: dir, owner }))).toBe('invalid_request')
})
