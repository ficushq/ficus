import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGatewayManifest } from './gateway'
const id = '11111111-1111-4111-8111-111111111111'
const manifest = {
  contractVersion: 1 as const,
  tenantId: id,
  physicalHostBinding: id,
  hostEpoch: 1,
  hostState: 'active' as const,
  routes: [],
}

test('gateway reads only bounded regular root-writer-owned safe route files, not private handoffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-gateway-manifest-'))
  const path = join(root, 'routes.json')
  try {
    await writeFile(path, JSON.stringify(manifest), { mode: 0o644 })
    expect(await readGatewayManifest(path, process.getuid!())).toEqual(manifest)
    await chmod(path, 0o666)
    await expect(readGatewayManifest(path, process.getuid!())).rejects.toThrow('invalid_response')
    await chmod(path, 0o644)
    await writeFile(path, JSON.stringify({ ...manifest, token: 'PRIVATE' }))
    await expect(readGatewayManifest(path, process.getuid!())).rejects.toThrow('invalid_response')
    await writeFile(path, ' '.repeat(16385))
    await expect(readGatewayManifest(path, process.getuid!())).rejects.toThrow('invalid_response')
    const alias = join(root, 'alias.json')
    await symlink(path, alias)
    await expect(readGatewayManifest(alias, process.getuid!())).rejects.toThrow('invalid_response')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
