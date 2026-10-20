import { afterEach, expect, test } from 'bun:test'
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { readPrivateJson, writePrivateJson } from './secure-files'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const schema = z.object({ phase: z.literal('ready') }).strict()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-private-'))
  roots.push(root)
  return root
}

test('atomically persists private validated JSON with fsynced 0600 files', async () => {
  const root = await fixture()
  await writePrivateJson(root, 'receipt.json', { phase: 'ready' }, schema, { uid })
  expect(await readPrivateJson(root, 'receipt.json', schema, { uid })).toEqual({ phase: 'ready' })
  expect((await stat(join(root, 'receipt.json'))).mode & 0o777).toBe(0o600)
  await writePrivateJson(root, 'receipt.json', { phase: 'ready' }, schema, { uid })
  expect(await readFile(join(root, 'receipt.json'), 'utf8')).toBe('{"phase":"ready"}\n')
})
test('rejects symlinked ancestors/files, hard links, nonprivate directories and unknown JSON fields', async () => {
  const root = await fixture()
  const real = join(root, 'real')
  await mkdir(real, { mode: 0o700 })
  await symlink(real, join(root, 'alias'))
  await expect(
    writePrivateJson(join(root, 'alias'), 'receipt.json', { phase: 'ready' }, schema, { uid })
  ).rejects.toThrow('storage_unavailable')
  await writeFile(join(real, 'receipt.json'), '{"phase":"ready"}', { mode: 0o600 })
  await symlink(join(real, 'receipt.json'), join(root, 'receipt.json'))
  await expect(readPrivateJson(root, 'receipt.json', schema, { uid })).rejects.toThrow('storage_unavailable')
  await expect(writePrivateJson(root, 'receipt.json', { phase: 'ready' }, schema, { uid })).rejects.toThrow(
    'storage_unavailable'
  )
  await rm(join(root, 'receipt.json'))
  await link(join(real, 'receipt.json'), join(root, 'receipt.json'))
  await expect(readPrivateJson(root, 'receipt.json', schema, { uid })).rejects.toThrow('storage_unavailable')
  await chmod(root, 0o777)
  await expect(readPrivateJson(root, 'receipt.json', schema, { uid })).rejects.toThrow('storage_unavailable')
})
test('bounds file reads and never exposes parsed input through error messages', async () => {
  const root = await fixture()
  for (const data of ['{"phase":"PRIVATE"}', ' '.repeat(16385), 'not JSON PRIVATE']) {
    await writeFile(join(root, 'receipt.json'), data, { mode: 0o600 })
    await expect(readPrivateJson(root, 'receipt.json', schema, { uid })).rejects.toThrow('storage_unavailable')
  }
  await expect(readPrivateJson(root, '../receipt.json', schema, { uid })).rejects.toThrow('storage_unavailable')
  await expect(readPrivateJson(root, 'receipt.json', schema, { uid: uid + 1 })).rejects.toThrow('storage_unavailable')
})
