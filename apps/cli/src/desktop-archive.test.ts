import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDesktopArchive } from './desktop-archive'

test('accepts an owned ditto ZIP and refuses an unsafe central-directory path before extraction', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'ficus-desktop-archive-test-'))
  try {
    const app = join(root, 'Ficus.app')
    await mkdir(join(app, 'Contents'), { recursive: true })
    await writeFile(join(app, 'Contents', 'proof'), 'fixture')
    const archive = join(root, 'valid.zip')
    const child = Bun.spawn(['/usr/bin/ditto', '-c', '-k', '--keepParent', app, archive], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await child.exited).toBe(0)
    await verifyDesktopArchive(archive)
    const invalid = join(root, 'invalid.zip')
    const bytes = await Bun.file(archive).arrayBuffer()
    const edited = Buffer.from(bytes)
    const needle = Buffer.from('Ficus.app/Contents/proof')
    const at = edited.indexOf(needle, edited.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])))
    expect(at).toBeGreaterThan(0)
    Buffer.from('Ficus.app/../unsafe////').copy(edited, at)
    await writeFile(invalid, edited)
    await expect(verifyDesktopArchive(invalid)).rejects.toThrow('unsafe path')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
