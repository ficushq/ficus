import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyHostBun } from './host-bun'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
async function fixture(version = '1.4.2') {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-bun-'))
  roots.push(root)
  await chmod(root, 0o755)
  await mkdir(join(root, 'bin'), { mode: 0o755 })
  await mkdir(join(root, 'real'), { mode: 0o755 })
  const real = join(root, 'real', 'bun')
  await writeFile(real, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 })
  await symlink(real, join(root, 'bin', 'bun'))
  return { root, path: join(root, 'bin', 'bun') }
}

test('accepts an operator-owned interpreter (via its resolved target) reporting the exact artifact Bun version', async () => {
  const f = await fixture()
  await verifyHostBun('1.4.2', { path: f.path, uid })
})

test('a different Bun version is refused: the bundles were only verified with their recorded version', async () => {
  const f = await fixture('1.4.3')
  await expect(verifyHostBun('1.4.2', { path: f.path, uid })).rejects.toThrow('unsupported_host')
})

test('group/other-writable interpreter, target directory or link directory is refused', async () => {
  for (const relative of ['real/bun', 'real', 'bin']) {
    const f = await fixture()
    await chmod(join(f.root, relative), relative === 'real/bun' ? 0o775 : 0o777)
    await expect(verifyHostBun('1.4.2', { path: f.path, uid }), relative).rejects.toThrow('unsupported_host')
  }
})

test('a missing interpreter is refused', async () => {
  await expect(verifyHostBun('1.4.2', { path: '/nonexistent/bun', uid })).rejects.toThrow('unsupported_host')
})

test('a role must run under the verified host Bun at the release version, not another interpreter', async () => {
  const { verifyRunningInterpreter } = await import('./preflight')
  const { syntheticArtifact } = await import('./host-test-fixtures')
  const f = await fixture()
  const release = join(f.root, 'release')
  await syntheticArtifact(release)
  await chmod(release, 0o755)
  // As the installer publishes it: immutable, operator-owned 0644.
  await chmod(join(release, 'provenance.json'), 0o644)
  const real = join(f.root, 'real', 'bun')
  const options = { uid, hostBun: f.path }
  await verifyRunningInterpreter(release, { ...options, running: { version: '1.4.2', execPath: real } })
  await expect(
    verifyRunningInterpreter(release, { ...options, running: { version: '1.4.3', execPath: real } })
  ).rejects.toThrow('unsupported_host')
  const other = join(f.root, 'real', 'other-bun')
  await writeFile(other, '#!/bin/sh\necho 1.4.2\n', { mode: 0o755 })
  await expect(
    verifyRunningInterpreter(release, { ...options, running: { version: '1.4.2', execPath: other } })
  ).rejects.toThrow('unsupported_host')
})
