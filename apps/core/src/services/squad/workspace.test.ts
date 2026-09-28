import { describe, it, expect, afterEach, beforeEach, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSquadsBasePath,
  getSquadWorkspacePath,
  ensureSquadWorkspace,
  removeSquadWorkspace,
  getWorkspaceTree,
  readWorkspaceFile,
  searchWorkspaceFiles,
  clearDirCache,
  resolveSquadWorkspaceHostPath,
  isInsideWorkspaceRoot,
} from './workspace'
import { clearHostWorkspaceOverrides, setHostWorkspaceOverride } from '../sandbox/host/workspace-overrides'

describe('squad-workspace', () => {
  const testWorkspacePath = crypto.randomUUID()

  afterEach(() => {
    // Clean up test workspace
    const fullPath = getSquadWorkspacePath(testWorkspacePath)
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  })

  describe('getSquadsBasePath', () => {
    it('uses the process-scoped test home', () => {
      expect(process.env.FICUS_TEST_MODE).toBe('1')
      expect(process.env.HOME_DIR).toContain('tau-core-test-')
    })

    it('returns a path ending with workspaces/squads', () => {
      const basePath = getSquadsBasePath()
      expect(basePath).toContain('workspaces')
      expect(basePath.endsWith('squads')).toBe(true)
    })

    it('resolves the base and leaf paths without creating them', () => {
      const previousHome = process.env.HOME_DIR
      const parent = mkdtempSync(join(tmpdir(), 'tau-workspace-path-test-'))
      const home = join(parent, 'home')
      process.env.HOME_DIR = home

      try {
        const base = getSquadsBasePath()
        const leaf = getSquadWorkspacePath(crypto.randomUUID())

        expect(existsSync(base)).toBe(false)
        expect(existsSync(leaf)).toBe(false)
      } finally {
        if (previousHome === undefined) delete process.env.HOME_DIR
        else process.env.HOME_DIR = previousHome
        rmSync(parent, { recursive: true, force: true })
      }
    })
  })

  describe('ensureSquadWorkspace', () => {
    it('rejects traversal and non-canonical squad IDs', async () => {
      expect(() => getSquadWorkspacePath('../outside')).toThrow('canonical UUID')
      expect(() => ensureSquadWorkspace(crypto.randomUUID().toUpperCase())).toThrow('canonical UUID')
      await expect(removeSquadWorkspace('/tmp/outside')).rejects.toThrow('canonical UUID')
    })

    it('creates nothing on disk for a non-canonical squad ID', () => {
      // The guard exists to stop ownerless stub directories accumulating (the
      // live instance had 320,223 of them). Rejecting is only half the
      // contract — it has to reject BEFORE the mkdir, or the stub is created
      // anyway and the throw merely hides it. Point HOME_DIR at a pristine
      // empty tree so "nothing was created" is directly observable.
      const previousHome = process.env.HOME_DIR
      const parent = mkdtempSync(join(tmpdir(), 'tau-workspace-guard-test-'))
      process.env.HOME_DIR = join(parent, 'home')

      // The exact shapes that were leaking: short test-style ids, slugs,
      // traversal, and a non-lowercase UUID.
      const nonCanonical = ['sq1', 's1', 'squad-a', 'test-squad-123', '../outside', crypto.randomUUID().toUpperCase()]

      try {
        for (const id of nonCanonical) {
          expect(() => ensureSquadWorkspace(id)).toThrow('canonical UUID')
          expect(existsSync(join(getSquadsBasePath(), id))).toBe(false)
        }
        // mkdir never ran at all, so not even the squads root came into being.
        expect(existsSync(getSquadsBasePath())).toBe(false)

        // Control: the same fresh home DOES create a workspace for a canonical
        // id, so the assertions above cannot pass merely because this home is
        // unwritable or otherwise inert.
        expect(existsSync(ensureSquadWorkspace(crypto.randomUUID()))).toBe(true)
      } finally {
        if (previousHome === undefined) delete process.env.HOME_DIR
        else process.env.HOME_DIR = previousHome
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('creates workspace directory', () => {
      const result = ensureSquadWorkspace(testWorkspacePath)
      expect(existsSync(result)).toBe(true)
    })

    it('is idempotent', () => {
      const first = ensureSquadWorkspace(testWorkspacePath)
      const second = ensureSquadWorkspace(testWorkspacePath)
      expect(first).toBe(second)
      expect(existsSync(first)).toBe(true)
    })
  })

  describe('removeSquadWorkspace', () => {
    it('removes existing workspace', async () => {
      ensureSquadWorkspace(testWorkspacePath)
      await removeSquadWorkspace(testWorkspacePath)
      expect(existsSync(getSquadWorkspacePath(testWorkspacePath))).toBe(false)
    })

    it('does not throw for non-existent workspace', async () => {
      await expect(removeSquadWorkspace('00000000-0000-0000-0000-000000000001')).resolves.toBeUndefined()
    })
  })

  describe('getWorkspaceTree', () => {
    it('returns tree structure', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      mkdirSync(join(fullPath, 'docs'), { recursive: true })
      writeFileSync(join(fullPath, 'README.md'), 'Hello')
      writeFileSync(join(fullPath, 'docs', 'spec.md'), 'Spec')

      const tree = getWorkspaceTree(testWorkspacePath)

      expect(tree.type).toBe('directory')
      expect(tree.children).toBeDefined()
      expect(tree.children!.some((c) => c.name === 'docs' && c.type === 'directory')).toBe(true)
      expect(tree.children!.some((c) => c.name === 'README.md' && c.type === 'file')).toBe(true)
    })
  })

  describe('readWorkspaceFile', () => {
    it('reads file content', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      writeFileSync(join(fullPath, 'test.txt'), 'Hello World')

      const content = readWorkspaceFile(testWorkspacePath, 'test.txt')
      expect(content).toBe('Hello World')
    })

    it('throws for non-existent file', () => {
      ensureSquadWorkspace(testWorkspacePath)
      expect(() => readWorkspaceFile(testWorkspacePath, 'nonexistent.txt')).toThrow('File not found')
    })
  })

  describe('searchWorkspaceFiles', () => {
    afterEach(() => {
      clearDirCache()
    })

    it('returns empty array for non-existent workspace', () => {
      const files = searchWorkspaceFiles('00000000-0000-0000-0000-000000000002')
      expect(files).toEqual([])
    })

    it('finds all files with empty query', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      writeFileSync(join(fullPath, 'README.md'), 'Hello')
      writeFileSync(join(fullPath, 'src.ts'), 'code')

      const files = searchWorkspaceFiles(testWorkspacePath)
      expect(files).toContain('README.md')
      expect(files).toContain('src.ts')
    })

    it('filters files by query (case-insensitive)', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      writeFileSync(join(fullPath, 'README.md'), 'Hello')
      writeFileSync(join(fullPath, 'index.ts'), 'code')
      writeFileSync(join(fullPath, 'utils.ts'), 'utils')

      const files = searchWorkspaceFiles(testWorkspacePath, { query: 'ts' })
      expect(files).toContain('index.ts')
      expect(files).toContain('utils.ts')
      expect(files).not.toContain('README.md')
    })

    it('searches in subdirectories', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      mkdirSync(join(fullPath, 'src'), { recursive: true })
      writeFileSync(join(fullPath, 'src', 'app.ts'), 'app')

      const files = searchWorkspaceFiles(testWorkspacePath, { query: 'app' })
      expect(files).toContain('src/app.ts')
    })

    it('skips node_modules directory', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      mkdirSync(join(fullPath, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(fullPath, 'node_modules', 'pkg', 'index.js'), 'module')
      writeFileSync(join(fullPath, 'app.js'), 'app')

      const files = searchWorkspaceFiles(testWorkspacePath)
      expect(files).not.toContain('node_modules/pkg/index.js')
      expect(files).toContain('app.js')
    })

    it('skips hidden files and directories', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      mkdirSync(join(fullPath, '.git'), { recursive: true })
      writeFileSync(join(fullPath, '.git', 'config'), 'git')
      writeFileSync(join(fullPath, '.env'), 'secret')
      writeFileSync(join(fullPath, 'visible.txt'), 'visible')

      const files = searchWorkspaceFiles(testWorkspacePath)
      expect(files).not.toContain('.git/config')
      expect(files).not.toContain('.env')
      expect(files).toContain('visible.txt')
    })

    it('respects maxResults limit', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      for (let i = 0; i < 30; i++) {
        writeFileSync(join(fullPath, `file${i}.txt`), `content ${i}`)
      }

      const files = searchWorkspaceFiles(testWorkspacePath, { maxResults: 10 })
      expect(files.length).toBe(10)
    })

    it('uses cached directory entries on subsequent calls', () => {
      const fullPath = ensureSquadWorkspace(testWorkspacePath)
      writeFileSync(join(fullPath, 'test.txt'), 'test')

      // First call populates cache
      const files1 = searchWorkspaceFiles(testWorkspacePath)
      expect(files1).toContain('test.txt')

      // Second call should use cache (we can't easily verify this without mocking,
      // but we can verify it still returns correct results)
      const files2 = searchWorkspaceFiles(testWorkspacePath, { query: 'test' })
      expect(files2).toContain('test.txt')
    })
  })
})

describe('resolveSquadWorkspaceHostPath', () => {
  const SQUAD = '11111111-2222-4333-8444-555555555555'
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FICUS_SANDBOX_RUNTIME
    clearHostWorkspaceOverrides()
    setHostWorkspaceOverride(SQUAD, '/srv/override')
  })
  afterEach(() => {
    clearHostWorkspaceOverrides()
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  test('host runtime uses the override', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    expect(resolveSquadWorkspaceHostPath(SQUAD)).toBe('/srv/override')
  })

  test('host runtime without an override uses the storage path', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    expect(resolveSquadWorkspaceHostPath(SQUAD)).toBe(getSquadWorkspacePath(SQUAD))
  })

  test('other runtimes ignore the override', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    expect(resolveSquadWorkspaceHostPath(SQUAD)).toBe(getSquadWorkspacePath(SQUAD))
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(resolveSquadWorkspaceHostPath(SQUAD)).toBe(getSquadWorkspacePath(SQUAD))
  })
})

describe('searchWorkspaceFiles honours the host workspace override', () => {
  const SQUAD = '22222222-3333-4444-8555-666666666666'
  let prevRuntime: string | undefined
  let overrideDir: string

  beforeEach(() => {
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    clearDirCache()
    clearHostWorkspaceOverrides()

    // Storage path: gets a file that must NOT show up once the override wins.
    const storagePath = ensureSquadWorkspace(SQUAD)
    writeFileSync(join(storagePath, 'storage-only.txt'), 'storage')

    // Override path: an unrelated temp dir with a file only it has.
    overrideDir = mkdtempSync(join(tmpdir(), 'tau-workspace-override-test-'))
    writeFileSync(join(overrideDir, 'override-only.txt'), 'override')

    setHostWorkspaceOverride(SQUAD, overrideDir)
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
  })

  afterEach(() => {
    clearDirCache()
    clearHostWorkspaceOverrides()
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(overrideDir, { recursive: true, force: true })
  })

  it('finds a file that only exists at the override path', () => {
    const files = searchWorkspaceFiles(SQUAD)
    expect(files).toContain('override-only.txt')
  })

  it('does not find a file that only exists at the storage path', () => {
    const files = searchWorkspaceFiles(SQUAD)
    expect(files).not.toContain('storage-only.txt')
  })
})

describe('isInsideWorkspaceRoot', () => {
  it('accepts the root itself and any descendant', () => {
    expect(isInsideWorkspaceRoot('/srv/repo', '/srv/repo')).toBe(true)
    expect(isInsideWorkspaceRoot('/srv/repo', join('/srv/repo', 'a', 'b.txt'))).toBe(true)
  })

  it('rejects a SIBLING whose name merely starts with the root (the prefix bug)', () => {
    // `path.resolve('/srv/repo', '../repo-secrets/x')` — a plain startsWith
    // check passes this because '/srv/repo-secrets/x'.startsWith('/srv/repo').
    expect(isInsideWorkspaceRoot('/srv/repo', '/srv/repo-secrets/x')).toBe(false)
    expect(isInsideWorkspaceRoot('/srv/repo', '/srv/repo-secrets')).toBe(false)
  })

  it('rejects an unrelated path', () => {
    expect(isInsideWorkspaceRoot('/srv/repo', '/etc/passwd')).toBe(false)
  })
})
