import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageWorkspaceMultipart } from '../attachments/workspace-multipart'
import { publishWorkspaceUpload, legacyUploadFits } from './workspace-upload'
import { SandboxHttpError, type BashResponse } from '../sandbox/client/http-client'
import type { SandboxPathClient } from './workspace-settings'

/**
 * A box `bash` that runs on this machine, so the in-box real-path check runs
 * for real. The working directory is ignored: some tests use a mount path that
 * does not exist here, and the check only uses absolute paths.
 */
const localBash: SandboxPathClient['bash'] = ({ command }) => {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
  const emitter = {
    on(event: string, listener: (arg?: never) => void) {
      ;(listeners[event] ??= []).push(listener as (arg?: unknown) => void)
      return emitter
    },
  }
  queueMicrotask(() => {
    const result = Bun.spawnSync(['bash', '-c', command])
    const data: BashResponse = { stdout: Buffer.from(result.stdout).toString('base64'), exitCode: result.exitCode }
    for (const listener of listeners.data ?? []) listener(data)
    for (const listener of listeners.end ?? []) listener()
  })
  return emitter as ReturnType<SandboxPathClient['bash']>
}

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
    bash: localBash,
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

/** A workspace with a settings directory, links into it, and an ordinary file. */
async function settingsWorkspace() {
  const base = await mkdtemp(join(tmpdir(), 'upload-settings-'))
  const root = join(base, 'workspace')
  await mkdir(join(root, '.ficus', 'monitors'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, '.ficus', '.env'), 'SYNTHETIC_SETTING=1\n')
  await symlink('.ficus', join(root, 'settings-link'))
  await symlink('../.ficus/not-yet.txt', join(root, 'docs', 'dangling-link'))
  await symlink('.', join(root, 'self-link'))
  return { base, root }
}

/** Upload targets that must never land in the settings directory, as [dir, path] pairs. */
const settingsTargets: Array<[string, string]> = [
  ['', '.ficus'],
  ['', '.ficus/.env'],
  ['', '.ficus/new.txt'],
  ['', '.ficus/monitors/m1/token'],
  ['', './.ficus/new.txt'],
  ['', '.ficus//new.txt'],
  ['', 'docs/../.ficus/new.txt'],
  ['', '.FICUS/new.txt'],
  ['', '.ficus./new.txt'],
  ['', '.ficus /new.txt'],
  ['.ficus', 'new.txt'],
  ['/.ficus/', 'new.txt'],
  ['docs/..//.ficus', 'monitors/new.txt'],
  ['', 'settings-link/new.txt'],
  ['settings-link', '.env'],
  ['', 'docs/dangling-link'],
  ['', 'self-link/.ficus/new.txt'],
]

async function stageOne(content: string) {
  const form = new FormData()
  form.append('file', new File([content], 'file'))
  return stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
}

test('local publication refuses every write into the settings directory and still writes ordinary files', async () => {
  const { base, root } = await settingsWorkspace()
  const staged = await stageOne('uploaded bytes')
  try {
    for (const [targetDir, relativePath] of settingsTargets) {
      staged.fields.set('path_file', relativePath)
      const results = await publishWorkspaceUpload({ staged, workspacePath: root, targetDir, overwrite: true })
      expect([targetDir, relativePath, results]).toEqual([
        targetDir,
        relativePath,
        [{ path: expect.any(String), status: 'error', error: 'Invalid path' }],
      ])
    }
    expect((await readdir(join(root, '.ficus'))).sort()).toEqual(['.env', 'monitors'])
    expect(await readdir(join(root, '.ficus', 'monitors'))).toEqual([])
    expect(await readFile(join(root, '.ficus', '.env'), 'utf8')).toBe('SYNTHETIC_SETTING=1\n')
    expect((await readdir(root)).sort()).toEqual(['.ficus', 'docs', 'self-link', 'settings-link'])

    for (const relativePath of ['docs/new.txt', 'docs/.ficus/config.json', 'self-link/notes.txt']) {
      staged.fields.set('path_file', relativePath)
      expect(await publishWorkspaceUpload({ staged, workspacePath: root, targetDir: '', overwrite: true })).toEqual([
        { path: relativePath, status: 'created' },
      ])
    }
    expect(await readFile(join(root, 'docs', 'new.txt'), 'utf8')).toBe('uploaded bytes')
    expect(await readFile(join(root, 'docs', '.ficus', 'config.json'), 'utf8')).toBe('uploaded bytes')
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('uploaded bytes')
  } finally {
    await staged.cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test('sandbox publication refuses every write into the settings directory, checked inside the box', async () => {
  const { base, root } = await settingsWorkspace()
  const staged = await stageOne('uploaded bytes')
  const touched: string[] = []
  const client = {
    bash: localBash,
    stat: async ({ path }: { path: string }) => {
      touched.push(path)
      return { exists: false }
    },
    upload: async ({ path, content }: { path: string; content: ReadableStream<Uint8Array> }) => {
      touched.push(path)
      const bytes = await new Response(content).arrayBuffer()
      return { bytesWritten: bytes.byteLength, sha256: staged.files[0]!.sha256 }
    },
    write: async ({ path }: { path: string }) => {
      touched.push(path)
      return { bytesWritten: 0 }
    },
  }
  try {
    for (const [targetDir, relativePath] of settingsTargets) {
      staged.fields.set('path_file', relativePath)
      const results = await publishWorkspaceUpload({ staged, workspacePath: root, targetDir, overwrite: true, client })
      expect([targetDir, relativePath, results]).toEqual([
        targetDir,
        relativePath,
        [{ path: expect.any(String), status: 'error', error: 'Invalid path' }],
      ])
    }
    expect(touched).toEqual([])

    staged.fields.set('path_file', 'docs/new.txt')
    expect(
      await publishWorkspaceUpload({ staged, workspacePath: root, targetDir: '', overwrite: true, client })
    ).toEqual([{ path: 'docs/new.txt', status: 'created' }])
    expect(touched).toEqual([join(root, 'docs', 'new.txt'), join(root, 'docs', 'new.txt')])
  } finally {
    await staged.cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test('sandbox publication fails closed when the box cannot resolve the target', async () => {
  const staged = await stageOne('uploaded bytes')
  let uploads = 0
  const client = {
    bash: (() => {
      const emitter = {
        on(event: string, listener: (arg?: never) => void) {
          if (event === 'data')
            queueMicrotask(() => (listener as unknown as (data: BashResponse) => void)({ exitCode: 3 }))
          if (event === 'end') queueMicrotask(() => queueMicrotask(() => (listener as () => void)()))
          return emitter
        },
      }
      return emitter
    }) as unknown as SandboxPathClient['bash'],
    stat: async () => ({ exists: false }),
    upload: async () => {
      uploads++
      return { bytesWritten: 14 }
    },
    write: async () => ({ bytesWritten: 14 }),
  }
  try {
    staged.fields.set('path_file', 'docs/new.txt')
    expect(
      await publishWorkspaceUpload({ staged, workspacePath: '/workspace', targetDir: '', overwrite: true, client })
    ).toMatchObject([{ path: 'docs/new.txt', status: 'error' }])
    expect(uploads).toBe(0)
  } finally {
    await staged.cleanup()
  }
})
