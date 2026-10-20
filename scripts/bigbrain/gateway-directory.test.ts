import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGatewayManifest } from './gateway'
const id = '11111111-1111-4111-8111-111111111111'
const manifest = {
  contractVersion: 1,
  tenantId: id,
  physicalHostBinding: id,
  hostEpoch: 1,
  hostState: 'active',
  routes: [],
}

test('public route reload observes atomic replacement and rejects symlinked ancestors or ambiguous paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-gateway-directory-'))
  const publicDir = join(root, 'public')
  const owner = process.getuid!()
  try {
    await mkdir(publicDir, { mode: 0o755 })
    const path = join(publicDir, 'routes.json')
    await writeFile(path, JSON.stringify(manifest), { mode: 0o644 })
    expect((await readGatewayManifest(path, owner)).hostState).toBe('active')
    const replacement = join(publicDir, 'new.json')
    await writeFile(replacement, JSON.stringify({ ...manifest, hostState: 'suspended' }), { mode: 0o644 })
    await rename(replacement, path)
    expect((await readGatewayManifest(path, owner)).hostState).toBe('suspended')
    const alias = join(root, 'alias')
    await symlink(publicDir, alias)
    await expect(readGatewayManifest(join(alias, 'routes.json'), owner)).rejects.toThrow('invalid_response')
    await expect(readGatewayManifest(`${publicDir}/../public/routes.json`, owner)).rejects.toThrow('invalid_response')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
