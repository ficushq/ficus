import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleConfinedList, handleConfinedRead, handleConfinedUpload } from './confined'

// A vm box: FICUS_BOX_HOME makes resolvePath rebase the logical `/private`
// root onto `<home>/.private`, exactly as Core addresses an agent box.
let home: string
let privateDir: string
const originalBoxHome = process.env.FICUS_BOX_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'confined-routes-'))
  privateDir = join(home, '.private')
  await mkdir(privateDir)
  await mkdir(join(home, 'elsewhere'))
  await writeFile(join(home, 'elsewhere', 'key.pem'), 'box secret')
  process.env.FICUS_BOX_HOME = home
})

afterEach(async () => {
  if (originalBoxHome === undefined) delete process.env.FICUS_BOX_HOME
  else process.env.FICUS_BOX_HOME = originalBoxHome
  await rm(home, { recursive: true, force: true })
})

describe('confined routes', () => {
  test('upload, list and read inside the rebased private root', async () => {
    const upload = await handleConfinedUpload(
      new URL('http://box/confined/upload?root=/private&path=creds/token.txt&createDirs=true'),
      new Request('http://box/confined/upload', { method: 'POST', body: 'abc123' })
    )
    expect(await upload.json()).toEqual({ status: 'created' })
    expect(await readFile(join(privateDir, 'creds', 'token.txt'), 'utf8')).toBe('abc123')

    const list = await handleConfinedList({ root: '/private', path: 'creds' })
    expect((await list.json()).entries).toEqual([expect.objectContaining({ name: 'token.txt', type: 'file', size: 6 })])

    const read = await handleConfinedRead({ root: '/private', path: 'creds/token.txt' })
    const body = await read.json()
    expect(Buffer.from(body.content, 'base64').toString()).toBe('abc123')
    expect(body.truncated).toBe(false)
  })

  test('refuses symlinks and traversal with a stable code', async () => {
    await symlink(join(home, 'elsewhere'), join(privateDir, 'escape'))
    const viaLink = await handleConfinedRead({ root: '/private', path: 'escape/key.pem' })
    expect(viaLink.status).toBe(400)
    expect(await viaLink.json()).toMatchObject({ code: 'symlink' })

    const traversal = await handleConfinedRead({ root: '/private', path: '../elsewhere/key.pem' })
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toMatchObject({ code: 'invalid-path' })

    const missing = await handleConfinedRead({ root: '/private', path: 'nope.txt' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'not-found' })
  })

  test('refuses roots outside the allowed prefixes', async () => {
    const response = await handleConfinedList({ root: '/etc', path: '' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid-path' })
  })
})
