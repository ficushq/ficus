import { afterEach, expect, test } from 'bun:test'
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  readPrivateJson,
  writePrivateJson,
  readPublicJson,
  writePublicJson,
  writePublicText,
  ensureOwnedDirectory,
  openPrivateFile,
} from './secure-files'
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

test('creates only a verified direct owned child, never chmods/adopts existing foreign permissions or follows ancestor links', async () => {
  const root = await fixture()
  const child = join(root, 'state')
  await ensureOwnedDirectory(child, 0o711, { uid })
  await ensureOwnedDirectory(child, 0o711, { uid })
  expect((await stat(child)).mode & 0o777).toBe(0o711)
  await expect(ensureOwnedDirectory(child, 0o700, { uid })).rejects.toThrow('storage_unavailable')
  await symlink(child, join(root, 'alias'))
  await expect(ensureOwnedDirectory(join(root, 'alias', 'escape'), 0o700, { uid })).rejects.toThrow(
    'storage_unavailable'
  )
  await expect(stat(join(child, 'escape'))).rejects.toThrow()
})

test('atomically persists private validated JSON with fsynced 0600 files', async () => {
  const root = await fixture()
  await writePrivateJson(root, 'receipt.json', { phase: 'ready' }, schema, { uid })
  expect(await readPrivateJson(root, 'receipt.json', schema, { uid })).toEqual({ phase: 'ready' })
  expect((await stat(join(root, 'receipt.json'))).mode & 0o777).toBe(0o600)
  await writePrivateJson(root, 'receipt.json', { phase: 'ready' }, schema, { uid })
  expect(await readFile(join(root, 'receipt.json'), 'utf8')).toBe('{"phase":"ready"}\n')
})
test('public routes and generated unit text are atomically root-owned0644, never replace linked/foreign targets', async () => {
  const root = await fixture()
  await chmod(root, 0o755)
  const mask = process.umask(0o077)
  try {
    await writePublicJson(root, 'routes.json', { phase: 'ready' }, schema, { uid })
  } finally {
    process.umask(mask)
  }
  expect(await readPublicJson(root, 'routes.json', schema, { uid })).toEqual({ phase: 'ready' })
  const name = 'var-lib-ficus\\\\x2dbigbrain.mount'
  await writePublicText(root, name, '[Mount]\\n', { uid })
  const first = await stat(join(root, name))
  expect(first.mode & 0o777).toBe(0o644)
  await writePublicText(root, name, '[Unit]\\n', { uid })
  expect((await stat(join(root, name))).ino).not.toBe(first.ino)
  await link(join(root, name), join(root, 'linked.mount'))
  await expect(writePublicText(root, name, 'broken', { uid })).rejects.toThrow('storage_unavailable')
  await expect(writePublicText(root, '../bad.mount', 'broken', { uid })).rejects.toThrow('storage_unavailable')
  await expect(writePublicText(root, 'large.mount', 'x'.repeat(16385), { uid })).rejects.toThrow('storage_unavailable')
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
test('pins a raw private image descriptor without JSON/full-file allocation and rejects symlink/hardlink substitution', async () => {
  const root = await fixture()
  await writeFile(join(root, 'volume.img'), 'image-marker', { mode: 0o600 })
  const file = await openPrivateFile(root, 'volume.img', { uid })
  try {
    expect((await file.stat()).isFile()).toBe(true)
  } finally {
    await file.close()
  }
  await link(join(root, 'volume.img'), join(root, 'linked.img'))
  await expect(openPrivateFile(root, 'volume.img', { uid })).rejects.toThrow('storage_unavailable')
  await symlink(join(root, 'volume.img'), join(root, 'alias.img'))
  await expect(openPrivateFile(root, 'alias.img', { uid })).rejects.toThrow('storage_unavailable')
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
