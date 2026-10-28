import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageWorkspaceMultipart } from '../attachments/workspace-multipart'
import { publishWorkspaceUpload, legacyUploadFits } from './workspace-upload'
import { SandboxHttpError } from '../sandbox/client/http-client'

test('local publication handles late paths, overwrite, skip and confinement atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-publication-'))
  const form = new FormData()
  form.append('file', new File(['hello'], 'original.txt'))
  form.append('path_file', 'nested/file.txt')
  const staged = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  try {
    const options = { staged, workspacePath: root, targetDir: 'dir', overwrite: false }
    expect(await publishWorkspaceUpload(options)).toEqual([{ path: 'dir/nested/file.txt', status: 'created' }])
    expect(await readFile(join(root, 'dir/nested/file.txt'), 'utf8')).toBe('hello')
    expect(await publishWorkspaceUpload(options)).toEqual([{ path: 'dir/nested/file.txt', status: 'skipped' }])
    expect(await publishWorkspaceUpload({ ...options, overwrite: true })).toEqual([
      { path: 'dir/nested/file.txt', status: 'overwritten' },
    ])
    staged.fields.set('path_file', '../../escape')
    expect(await publishWorkspaceUpload(options)).toMatchObject([{ status: 'error', error: 'Invalid path' }])
  } finally {
    await staged.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
test('remote stream publication verifies identity and reopens only safe small legacy fallback', async () => {
  const form = new FormData()
  form.append('file', new File(['hello'], 'file'))
  const staged = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  let writes = 0
  const client = {
    stat: async () => ({ exists: false }),
    upload: async ({ content }: { content: ReadableStream<Uint8Array> }) => {
      expect(await new Response(content).text()).toBe('hello')
      return { bytesWritten: 5, sha256: staged.files[0]!.sha256 }
    },
    write: async ({ content }: { content: string }) => {
      writes++
      expect(Buffer.from(content, 'base64').toString()).toBe('hello')
      return { bytesWritten: 5 }
    },
  }
  try {
    const options = { staged, workspacePath: '/workspace', targetDir: '', overwrite: false, client }
    expect(await publishWorkspaceUpload(options)).toMatchObject([{ status: 'created' }])
    client.upload = async () => {
      throw new SandboxHttpError('old', 404)
    }
    expect(await publishWorkspaceUpload(options)).toMatchObject([{ status: 'created' }])
    expect(writes).toBe(1)
    staged.files[0]!.bytes = 100 * 1024 ** 2
    expect(await publishWorkspaceUpload(options)).toMatchObject([
      { status: 'error', error: expect.stringContaining('upgrade') },
    ])
    expect(writes).toBe(1)
  } finally {
    await staged.cleanup()
  }
})
test('fallback checks encoded envelope bytes without allocating content', () => {
  expect(legacyUploadFits('/workspace/file', 5)).toBe(true)
  expect(legacyUploadFits('/workspace/file', 100 * 1024 ** 2)).toBe(false)
})

test('local streaming upload rejects outside-root symlinks but preserves inside-root symlink compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upload-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'upload-outside-'))
  const form = new FormData()
  form.append('file', new File(['candidate'], 'file'))
  const staged = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  try {
    await writeFile(join(outside, 'file'), 'outside original')
    await symlink(outside, join(root, 'escape'))
    staged.fields.set('path_file', 'escape/file')
    expect(await publishWorkspaceUpload({ staged, workspacePath: root, targetDir: '', overwrite: true })).toMatchObject(
      [{ status: 'error' }]
    )
    expect(await readFile(join(outside, 'file'), 'utf8')).toBe('outside original')
    await mkdir(join(root, 'actual'))
    await symlink(join(root, 'actual'), join(root, 'inside'))
    staged.fields.set('path_file', 'inside/file')
    expect(await publishWorkspaceUpload({ staged, workspacePath: root, targetDir: '', overwrite: true })).toEqual([
      { path: 'inside/file', status: 'created' },
    ])
    expect(await readFile(join(root, 'actual/file'), 'utf8')).toBe('candidate')
  } finally {
    await staged.cleanup()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('local batch publication reports each failure without rolling back earlier files or skipping later files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upload-partial-results-'))
  const form = new FormData()
  form.append('first', new File(['first bytes'], 'first.txt'))
  form.append('blocked', new File(['must not publish'], 'file.txt'))
  form.append('path_blocked', 'blocked/file.txt')
  form.append('last', new File(['last bytes'], 'last.txt'))
  const staged = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  try {
    // A regular parent file causes a real, deterministic mkdir/write failure.
    await writeFile(join(root, 'blocked'), 'preserve existing file')
    expect(staged.files).toHaveLength(3)
    expect(await publishWorkspaceUpload({ staged, workspacePath: root, targetDir: '', overwrite: true })).toEqual([
      { path: 'first.txt', status: 'created' },
      { path: 'blocked/file.txt', status: 'error', error: expect.any(String) },
      { path: 'last.txt', status: 'created' },
    ])
    expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('first bytes')
    expect(await readFile(join(root, 'last.txt'), 'utf8')).toBe('last bytes')
    expect(await readFile(join(root, 'blocked'), 'utf8')).toBe('preserve existing file')
    expect(await Bun.file(join(root, 'blocked/file.txt')).exists()).toBe(false)
  } finally {
    await staged.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
