import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BigbrainBindings } from './local-bindings'

let root: string
let home: string
let binding: { id: string; label: string; vaultPath: string; executablePath: string; clientId: string }
let resolver: BigbrainBindings
async function save(value: unknown = [binding]) {
  await writeFile(join(home, 'bigbrain-bindings.json'), JSON.stringify(value), { mode: 0o600 })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-'))
  home = join(root, 'ficus')
  await mkdir(home, { mode: 0o700 })
  const vaultPath = join(root, 'vault')
  await mkdir(vaultPath, { mode: 0o700 })
  await writeFile(join(vaultPath, 'vault.yaml'), 'name: synthetic')
  const executablePath = join(root, 'bigbrain')
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  binding = { id: 'personal', label: 'Personal', vaultPath, executablePath, clientId: 'aabb0011' }
  resolver = new BigbrainBindings({ home, supported: () => true })
  await save()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('selects exactly the declared vault and returns secret-free summaries', async () => {
  const selected = await resolver.resolve('personal')
  expect(selected.configuration).toMatchObject({ version: 2, bindingId: 'personal', vaultPath: binding.vaultPath })
  expect(selected.clientId).toBe('aabb0011')
  expect(JSON.stringify(await resolver.list())).not.toContain('aabb0011')
  await expect(resolver.resolve('other')).rejects.toMatchObject({ code: 'binding_unavailable' })
})
test('pins security fields but not labels', async () => {
  const { configuration } = await resolver.resolve('personal')
  binding.label = 'Renamed'
  await save()
  await expect(resolver.resolvePinned(configuration)).resolves.toMatchObject({ clientId: binding.clientId })
  binding.clientId = 'aabb0022'
  await save()
  await expect(resolver.resolvePinned(configuration)).rejects.toMatchObject({ code: 'binding_changed' })
})
test('rejects duplicates, unknown keys, relative paths and oversized declarations', async () => {
  for (const value of [
    [binding, binding],
    [{ ...binding, command: 'evil' }],
    [{ ...binding, vaultPath: '../vault' }],
  ]) {
    await save(value)
    await expect(resolver.resolve('personal')).rejects.toMatchObject({ code: 'invalid_configuration' })
  }
  await writeFile(join(home, 'bigbrain-bindings.json'), ' '.repeat(65537))
  await expect(resolver.list()).rejects.toMatchObject({ code: 'invalid_configuration' })
})
test('rejects mutable or symlink declarations and mutable vault directories', async () => {
  await chmod(join(home, 'bigbrain-bindings.json'), 0o666)
  await expect(resolver.list()).rejects.toMatchObject({ code: 'invalid_configuration' })
  await chmod(join(home, 'bigbrain-bindings.json'), 0o600)
  await rename(join(home, 'bigbrain-bindings.json'), join(root, 'declaration'))
  await symlink(join(root, 'declaration'), join(home, 'bigbrain-bindings.json'))
  await expect(resolver.list()).rejects.toMatchObject({ code: 'invalid_configuration' })
  await rm(join(home, 'bigbrain-bindings.json'))
  await save()
  await chmod(binding.vaultPath, 0o777)
  await expect(resolver.resolve('personal')).rejects.toMatchObject({ code: 'invalid_configuration' })
})
test('rejects missing state and changed executable symlink targets', async () => {
  const launcher = binding.executablePath
  await rename(launcher, `${launcher}-one`)
  await symlink(`${launcher}-one`, launcher)
  const { configuration } = await resolver.resolve('personal')
  await writeFile(`${launcher}-two`, await readFile(`${launcher}-one`), { mode: 0o700 })
  await rm(launcher)
  await symlink(`${launcher}-two`, launcher)
  await expect(resolver.resolvePinned(configuration)).rejects.toMatchObject({ code: 'binding_changed' })
  await rm(binding.vaultPath, { recursive: true })
  await expect(resolver.resolve('personal')).rejects.toMatchObject({ code: 'binding_unavailable' })
})
test('refuses sandbox overlaps in both directions and unsupported hosts', async () => {
  const exposed = join(home, 'workspaces')
  await mkdir(exposed)
  binding.vaultPath = exposed
  await writeFile(join(exposed, 'vault.yaml'), 'name: bad')
  await save()
  await expect(resolver.resolve('personal')).rejects.toMatchObject({ code: 'invalid_configuration' })
  binding.vaultPath = root
  await writeFile(join(root, 'vault.yaml'), 'name: bad')
  await save()
  await expect(resolver.resolve('personal')).rejects.toMatchObject({ code: 'invalid_configuration' })
  await expect(new BigbrainBindings({ home, supported: () => false }).list()).rejects.toMatchObject({
    code: 'unsupported_host',
  })
})
