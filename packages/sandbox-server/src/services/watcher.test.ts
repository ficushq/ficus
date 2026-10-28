import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { WorkspaceWatcher, createWatchPathFilter, isSafeWatchPattern, normalizeWatchConfig } from './watcher'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import * as fsPromises from 'fs/promises'

let TEST_DIR: string
beforeEach(() => {
  // Native watch teardown can outlive close() at the OS/runtime boundary.
  // Never remove and recreate the same watched pathname for the next case.
  TEST_DIR = mkdtempSync(join(tmpdir(), 'sandbox-watcher-'))
})
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

test('v5 filter preserves glob ancestors and deletions without traversing unrelated or excluded trees', () => {
  const ignored = createWatchPathFilter(TEST_DIR, ['ficus/{docs,notes}/**/*.md', 'config/*.json'], ['**/private/**'])
  const dir = { isDirectory: () => true }
  const file = { isDirectory: () => false }
  for (const path of ['', 'ficus', 'ficus/docs', 'ficus/notes/deep/nested', 'config']) {
    expect(ignored(join(TEST_DIR, path), dir)).toBe(false)
  }
  for (const path of ['ficus/src', 'unrelated', 'node_modules', 'ficus/docs/node_modules', 'ficus/docs/private']) {
    expect(ignored(join(TEST_DIR, path), dir)).toBe(true)
  }
  expect(ignored(join(TEST_DIR, 'ficus/docs/deleted.md'))).toBe(false)
  expect(ignored(join(TEST_DIR, 'ficus/docs/live.md'), file)).toBe(false)
  expect(ignored(join(TEST_DIR, 'ficus/docs/live.ts'), file)).toBe(true)
  expect(ignored(join(TEST_DIR, 'config/nested'), dir)).toBe(true)
  expect(ignored(join(TEST_DIR, '../outside'), dir)).toBe(true)
})

test('initial scans prune unrelated and excluded trees before enumerating their contents', async () => {
  for (const dir of [
    'repo/docs/deep',
    'repo/docs/private',
    'repo/docs/node_modules/pkg',
    'repo/src',
    'worktrees/old',
  ]) {
    mkdirSync(join(TEST_DIR, dir), { recursive: true })
    writeFileSync(join(TEST_DIR, dir, 'note.md'), '# Reference')
  }
  writeFileSync(join(TEST_DIR, 'README.md'), '# Root')
  const reads = spyOn(fsPromises, 'readdir')
  try {
    const result = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['README.md', 'repo/{docs,notes}/**/*.md'],
      exclude: ['**/private/**'],
    })
    expect(result.files.map((file) => file.path).sort()).toEqual(['README.md', 'repo/docs/deep/note.md'])
    const visited = reads.mock.calls.map(([path]) => relative(TEST_DIR, String(path)))
    expect(visited.sort()).toEqual(['', 'repo', 'repo/docs', 'repo/docs/deep'])
  } finally {
    reads.mockRestore()
  }
})

describe('normalizeWatchConfig', () => {
  test('accepts and normalizes valid squad workspace watch config', () => {
    expect(
      normalizeWatchConfig({
        include: ['/workspace/ficus/docs/**/*.md', ' ficus/docs/**/*.md '],
        exclude: undefined,
        squadId: ' squad-1 ',
      })
    ).toEqual({
      include: ['ficus/docs/**/*.md', 'ficus/docs/**/*.md'],
      exclude: [],
      squadId: 'squad-1',
    })
  })

  test('rejects invalid include config with actionable validation error', () => {
    expect(() => normalizeWatchConfig({ include: [], exclude: [], squadId: 'squad-1' })).toThrow(
      'Invalid watch config: include must contain at least one glob string'
    )
    expect(() => normalizeWatchConfig({ include: 'ficus/docs/**/*.md', exclude: [], squadId: 'squad-1' })).toThrow(
      'Invalid watch config: include must be an array of glob strings'
    )
  })
})

describe('WorkspaceWatcher', () => {
  test('starts successfully with current squad workspace glob contract', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'sandbox-watcher.md'), '# Watcher')

    const watcher = new WorkspaceWatcher(TEST_DIR)
    try {
      const result = await watcher.start({
        include: ['ficus/docs/**/*.md'],
        exclude: [],
        squadId: 'squad-1',
        coreCallbackUrl: 'http://127.0.0.1:1/workspace-files',
      })

      expect(result.fileCount).toBe(1)
      expect(watcher.getStatus()).toEqual({
        active: true,
        config: {
          include: ['ficus/docs/**/*.md'],
          exclude: [],
          squadId: 'squad-1',
          coreCallbackUrl: 'http://127.0.0.1:1/workspace-files',
        },
      })
    } finally {
      await watcher.stop()
    }
  })

  test('start() is idempotent for an unchanged config (no rescan)', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'one.md'), '# One')

    const watcher = new WorkspaceWatcher(TEST_DIR)
    const cfg = {
      include: ['ficus/docs/**/*.md'],
      exclude: [],
      squadId: 'squad-1',
      coreCallbackUrl: 'http://127.0.0.1:1/workspace-files',
    }
    try {
      const first = await watcher.start(cfg)
      expect(first.fileCount).toBe(1)

      // A fresh scan WOULD pick this up...
      writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'two.md'), '# Two')

      // ...but an unchanged config must return the cached result without rescanning.
      const again = await watcher.start(cfg)
      expect(again.fileCount).toBe(1)
    } finally {
      await watcher.stop()
    }
  })

  test('start() rescans when the config changes', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'one.md'), '# One')
    writeFileSync(join(TEST_DIR, 'ficus', 'note.txt'), 'note')

    const watcher = new WorkspaceWatcher(TEST_DIR)
    const base = { exclude: [], squadId: 'squad-1', coreCallbackUrl: 'http://127.0.0.1:1/workspace-files' }
    try {
      const first = await watcher.start({ ...base, include: ['ficus/docs/**/*.md'] })
      expect(first.fileCount).toBe(1)

      const changed = await watcher.start({ ...base, include: ['ficus/**/*'] })
      expect(changed.fileCount).toBe(2)
    } finally {
      await watcher.stop()
    }
  })

  test('collects files matching include globs', async () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'docs', 'readme.md'), '# Hello')
    writeFileSync(join(TEST_DIR, 'src', 'app.ts'), 'const x = 1')
    writeFileSync(join(TEST_DIR, 'ignore.log'), 'log')

    const { files } = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['docs/**/*.md', 'src/**/*.ts'],
      exclude: [],
    })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('docs/readme.md')
    expect(paths).toContain('src/app.ts')
    expect(paths).not.toContain('ignore.log')
  })

  test('excludes files matching exclude globs', async () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    mkdirSync(join(TEST_DIR, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'docs', 'readme.md'), '# Hello')
    writeFileSync(join(TEST_DIR, 'node_modules', 'pkg', 'index.js'), 'x')

    const { files } = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['**/*'],
      exclude: [],
    })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('docs/readme.md')
    expect(paths).not.toContain('node_modules/pkg/index.js')
  })

  test('does not recurse into symlink cycles while scanning representative workspace globs', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'readme.md'), '# Hello')
    symlinkSync(TEST_DIR, join(TEST_DIR, 'ficus', 'docs', 'workspace-loop'), 'dir')

    const { files } = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['ficus/docs/**/*.md'],
      exclude: [],
    })

    expect(files).toEqual([{ path: 'ficus/docs/readme.md', content: '# Hello' }])
  })

  test('starts successfully with representative workspace config containing symlink cycles', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'readme.md'), '# Hello')
    symlinkSync(TEST_DIR, join(TEST_DIR, 'ficus', 'docs', 'workspace-loop'), 'dir')

    const watcher = new WorkspaceWatcher(TEST_DIR)
    try {
      const result = await watcher.start({
        include: ['ficus/docs/**/*.md'],
        exclude: [],
        squadId: 'squad-1',
        coreCallbackUrl: 'http://127.0.0.1:1/workspace-files',
      })

      expect(result.fileCount).toBe(1)
      expect(result.skipped).toEqual([])
    } finally {
      await watcher.stop()
    }
  })

  test('skips binary files and reports them', async () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'docs', 'readme.md'), '# Hello')
    writeFileSync(join(TEST_DIR, 'docs', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))

    const { files, skipped } = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['docs/**'],
      exclude: [],
    })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('docs/readme.md')
    expect(paths).not.toContain('docs/image.png')
    expect(skipped.some((s) => s.path === 'docs/image.png' && s.reason === 'binary')).toBe(true)
  })

  test('skips files over 100KB and reports them', async () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'docs', 'small.md'), '# Small')
    writeFileSync(join(TEST_DIR, 'docs', 'large.md'), 'x'.repeat(200 * 1024))

    const { files, skipped } = await WorkspaceWatcher.scanFiles(TEST_DIR, {
      include: ['docs/**'],
      exclude: [],
    })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('docs/small.md')
    expect(paths).not.toContain('docs/large.md')
    expect(skipped.some((s) => s.path === 'docs/large.md' && s.reason === 'file_too_large')).toBe(true)
  })
})

describe('isSafeWatchPattern', () => {
  test('accepts in-root globs, rejects escape segments', () => {
    expect(isSafeWatchPattern('docs/**/*.md')).toBe(true)
    expect(isSafeWatchPattern('**/*')).toBe(true)
    expect(isSafeWatchPattern('../outside/**')).toBe(false)
    expect(isSafeWatchPattern('a/../../etc/**')).toBe(false)
  })
})

describe('injectable sink', () => {
  // Real native delivery includes the existing 3s debounce; allow its 10s
  // observation budget plus setup/cleanup, as in the change/delete cases.
  test('v5 discovers new matching subtrees while leaving unrelated and excluded trees unwatched', async () => {
    for (const path of ['ficus/docs', 'ficus/src/deep', 'ficus/docs/node_modules/pkg', 'ficus/docs/private']) {
      mkdirSync(join(TEST_DIR, path), { recursive: true })
      writeFileSync(join(TEST_DIR, path, 'ignored.ts'), 'fixture')
    }
    const payloads: Array<{ reconcile: boolean; files: Array<{ path: string; content: string | null }> }> = []
    const watcher = new WorkspaceWatcher(TEST_DIR, {
      sink: async (p) => {
        payloads.push(p)
      },
    })
    try {
      await watcher.start({ include: ['ficus/{docs,notes}/**/*.md'], exclude: ['**/private/**'], squadId: 'squad-1' })
      const native = watcher as unknown as { fsWatcher: { getWatched(): Record<string, string[]> } }
      const watched = Object.keys(native.fsWatcher.getWatched()).map((path) => relative(realpathSync(TEST_DIR), path))
      expect(watched).toContain('ficus/docs')
      expect(watched.some((path) => /(^|\/)(src|node_modules|private)(\/|$)/.test(path))).toBe(false)
      mkdirSync(join(TEST_DIR, 'ficus/notes/new'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'ficus/notes/new/created.md'), '# created after ready')
      const deadline = performance.now() + 10_000
      while (!payloads.some((p) => !p.reconcile) && performance.now() < deadline) await Bun.sleep(25)
      expect(payloads.filter((p) => !p.reconcile)).toMatchObject([
        { files: [{ path: 'ficus/notes/new/created.md', content: '# created after ready' }] },
      ])
    } finally {
      await watcher.stop()
    }
  }, 15_000)

  test('sink receives the initial reconcile payload instead of HTTP', async () => {
    mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'a.md'), '# A')

    const payloads: any[] = []
    const watcher = new WorkspaceWatcher(TEST_DIR, {
      sink: async (p) => {
        payloads.push(p)
      },
    })
    try {
      const result = await watcher.start({ include: ['ficus/docs/**/*.md'], exclude: [], squadId: 'squad-1' })
      expect(result.fileCount).toBe(1)
      expect(payloads).toEqual([
        {
          squadId: 'squad-1',
          files: [{ path: 'ficus/docs/a.md', content: '# A', event: 'change' }],
          reconcile: true,
        },
      ])
    } finally {
      await watcher.stop()
    }
  })

  test('sink receives skipped files on the reconcile payload', async () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'docs', 'big.md'), 'x'.repeat(200 * 1024))

    const payloads: any[] = []
    const watcher = new WorkspaceWatcher(TEST_DIR, {
      sink: async (p) => {
        payloads.push(p)
      },
    })
    try {
      await watcher.start({ include: ['docs/**'], exclude: [], squadId: 'squad-1' })
      expect(payloads[0].skipped).toEqual([
        { path: 'docs/big.md', reason: 'file_too_large', detail: expect.stringContaining('200KB') },
      ])
    } finally {
      await watcher.stop()
    }
  })

  for (const persistent of [true, false])
    test(`sink receives debounced change and delete events (persistent: ${persistent})`, async () => {
      mkdirSync(join(TEST_DIR, 'ficus', 'docs'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'live.md'), '# v1')

      const payloads: any[] = []
      const watcher = new WorkspaceWatcher(TEST_DIR, {
        persistent,
        sink: async (p) => {
          payloads.push(p)
        },
      })
      try {
        await watcher.start({ include: ['ficus/docs/**/*.md'], exclude: [], squadId: 'squad-1' })
        writeFileSync(join(TEST_DIR, 'ficus', 'docs', 'live.md'), '# v2')
        const deadline = Date.now() + 10_000 // 3s debounce budget
        while (payloads.length < 2 && Date.now() < deadline) await Bun.sleep(250)
        expect(payloads[1]).toMatchObject({
          squadId: 'squad-1',
          reconcile: false,
          files: [{ path: 'ficus/docs/live.md', content: '# v2', event: 'change' }],
        })

        payloads.length = 0
        unlinkSync(join(TEST_DIR, 'ficus', 'docs', 'live.md'))
        const deadline2 = Date.now() + 10_000
        while (payloads.length < 1 && Date.now() < deadline2) await Bun.sleep(250)
        expect(payloads[0]).toMatchObject({
          squadId: 'squad-1',
          files: [{ path: 'ficus/docs/live.md', event: 'delete' }],
        })
      } finally {
        await watcher.stop()
      }
    }, 25_000)
})

describe('rejectSymlinks', () => {
  test('live change on a symlinked file is skipped when rejectSymlinks is set', async () => {
    mkdirSync(join(TEST_DIR, 'outside'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'outside', 'secret.md'), '# secret')
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true })
    symlinkSync(join(TEST_DIR, 'outside', 'secret.md'), join(TEST_DIR, 'docs', 'link.md'))

    const payloads: any[] = []
    const watcher = new WorkspaceWatcher(TEST_DIR, {
      rejectSymlinks: true,
      sink: async (p) => {
        payloads.push(p)
      },
    })
    try {
      await watcher.start({ include: ['docs/**'], exclude: [], squadId: 'squad-1' })
      await Bun.sleep(500)
      writeFileSync(join(TEST_DIR, 'outside', 'secret.md'), '# secret v2')
      await Bun.sleep(4500) // > 3s debounce
      expect(payloads.filter((p) => !p.reconcile)).toEqual([])
    } finally {
      await watcher.stop()
    }
  }, 15_000)
})

test('a 2100-file pattern preserves 1000 files and aggregates 1100 skipped diagnostics', async () => {
  for (let i = 0; i < 2100; i++) writeFileSync(join(TEST_DIR, `file-${i}.md`), '# Reference')
  const { files, skipped } = await WorkspaceWatcher.scanFiles(TEST_DIR, { include: ['*.md'], exclude: [] })
  expect(files).toHaveLength(1000)
  expect(new Set(files.map((file) => file.path)).size).toBe(1000)
  expect(skipped).toEqual([
    {
      path: expect.any(String),
      reason: 'max_files_exceeded',
      count: 1100,
      detail: expect.stringContaining('example'),
    },
  ])
})

test('skip aggregation begins only above 1000 details and preserves every reason total', async () => {
  const binary = Buffer.from([0, 255])
  for (let i = 0; i < 1000; i++) writeFileSync(join(TEST_DIR, `file-${i}.bin`), binary)
  const detailed = await WorkspaceWatcher.scanFiles(TEST_DIR, { include: ['*.bin'], exclude: [] })
  expect(detailed.files).toEqual([])
  expect(detailed.skipped).toHaveLength(1000)
  expect(detailed.skipped.every((skip) => skip.reason === 'binary' && skip.count === undefined)).toBe(true)

  for (let i = 1000; i < 1100; i++) writeFileSync(join(TEST_DIR, `file-${i}.bin`), binary)
  writeFileSync(join(TEST_DIR, 'big.md'), 'x'.repeat(101 * 1024))
  // Deterministic read failure, independent of file permissions or test user.
  const read = spyOn(fsPromises, 'readFile').mockRejectedValueOnce(new Error('synthetic EIO'))
  try {
    const aggregate = await WorkspaceWatcher.scanFiles(TEST_DIR, { include: ['*.bin', 'big.md'], exclude: [] })
    expect(aggregate.files).toEqual([])
    expect(aggregate.skipped).toHaveLength(4)
    expect(Object.fromEntries(aggregate.skipped.map((skip) => [skip.reason, skip.count]))).toEqual({
      max_files_exceeded: 100,
      binary: 999,
      unreadable: 1,
      file_too_large: 1,
    })
    expect(aggregate.skipped.every((skip) => skip.detail?.includes('example'))).toBe(true)
  } finally {
    read.mockRestore()
  }
})
