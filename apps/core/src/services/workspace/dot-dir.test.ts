import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  LEGACY_WORKSPACE_DOT_DIR,
  WORKSPACE_DOT_DIR,
  ensureWorkspaceDotDir,
  migrateWorkspaceDotDir,
  migrateWorkspaceDotDirs,
  prepareWorkspaceDotDir,
  workspaceDotDirsLogLine,
  workspaceDotPath,
  WorkspaceDotDirConflictError,
  type WorkspaceDotDirConflictKind,
} from './dot-dir'
import { getHomeDir } from '../../lib/utils/home'
import { preparedAgentIdentityHostPath } from '../amtp/agent-identity'

const SQUAD = '11111111-1111-4111-8111-111111111111'
const OTHER_SQUAD = '22222222-2222-4222-8222-222222222222'
const ENV_BYTES = "export API_KEY='s3cret'\nFOO=bar\n"

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-dot-dir-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const squadRoot = (id = SQUAD) => join(home, 'workspaces', 'squads', id)
const privateRoot = (sandboxId: string) => join(home, 'private', sandboxId)

/** A work root holding a real legacy dot dir with one file in it. */
function legacyWorkspace(root: string, file = '.env', content = ENV_BYTES): void {
  mkdirSync(join(root, LEGACY_WORKSPACE_DOT_DIR), { recursive: true })
  writeFileSync(join(root, LEGACY_WORKSPACE_DOT_DIR, file), content, { mode: 0o600 })
}

function expectNoBridge(root: string): void {
  expect(() => lstatSync(join(root, LEGACY_WORKSPACE_DOT_DIR))).toThrow()
}

describe('workspace finalization', () => {
  test('removes only the exact bridge and preserves canonical file identity', () => {
    const root = squadRoot()
    mkdirSync(join(root, WORKSPACE_DOT_DIR), { recursive: true })
    const file = join(root, WORKSPACE_DOT_DIR, '.env')
    writeFileSync(file, ENV_BYTES, { mode: 0o600 })
    const before = lstatSync(file)
    symlinkSync(WORKSPACE_DOT_DIR, join(root, LEGACY_WORKSPACE_DOT_DIR))
    expect(migrateWorkspaceDotDir(root)).toEqual({ moved: false })
    expect(() => lstatSync(join(root, LEGACY_WORKSPACE_DOT_DIR))).toThrow()
    expect(lstatSync(file).ino).toBe(before.ino)
    expect(lstatSync(file).mode).toBe(before.mode)
    expect(readFileSync(file, 'utf8')).toBe(ENV_BYTES)
    expect(migrateWorkspaceDotDir(root)).toEqual({ moved: false })
  })

  test('a dangling compatibility link refuses creation of replacement settings', () => {
    mkdirSync(squadRoot(), { recursive: true })
    symlinkSync(WORKSPACE_DOT_DIR, join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))
    expect(() => ensureWorkspaceDotDir(squadRoot())).toThrow(WorkspaceDotDirConflictError)
    expect(readlinkSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toBe(WORKSPACE_DOT_DIR)
    expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)('a failed bridge removal blocks dependent writers', () => {
    const root = squadRoot()
    mkdirSync(join(root, WORKSPACE_DOT_DIR), { recursive: true })
    const file = join(root, WORKSPACE_DOT_DIR, '.env')
    writeFileSync(file, ENV_BYTES, { mode: 0o600 })
    symlinkSync(WORKSPACE_DOT_DIR, join(root, LEGACY_WORKSPACE_DOT_DIR))
    chmodSync(root, 0o500)
    try {
      expect(() => ensureWorkspaceDotDir(root)).toThrow(WorkspaceDotDirConflictError)
      expect(readlinkSync(join(root, LEGACY_WORKSPACE_DOT_DIR))).toBe(WORKSPACE_DOT_DIR)
      expect(readFileSync(file, 'utf8')).toBe(ENV_BYTES)
    } finally {
      chmodSync(root, 0o700)
    }
    expect(ensureWorkspaceDotDir(root)).toBe(join(root, WORKSPACE_DOT_DIR))
    expectNoBridge(root)
  })

  test('fresh creation never recreates a retired bridge', () => {
    mkdirSync(squadRoot(), { recursive: true })
    ensureWorkspaceDotDir(squadRoot())
    ensureWorkspaceDotDir(squadRoot())
    expect(() => lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toThrow()
  })
})

describe('workspaceDotPath', () => {
  test('joins segments under the work root dot dir', () => {
    expect(WORKSPACE_DOT_DIR).toBe('.ficus')
    expect(workspaceDotPath('/workspace/sq', '.env')).toBe('/workspace/sq/.ficus/.env')
    expect(workspaceDotPath('/private', 'monitors', 'm1')).toBe('/private/.ficus/monitors/m1')
    expect(workspaceDotPath('/w')).toBe('/w/.ficus')
  })
})

describe('migrateWorkspaceDotDirs', () => {
  test('a legacy dot dir moves to .ficus with the same bytes and no legacy link', async () => {
    legacyWorkspace(squadRoot())

    const result = await migrateWorkspaceDotDirs(home)

    expect(result).toEqual({ moved: 1, conflicts: [] })
    const envPath = join(squadRoot(), WORKSPACE_DOT_DIR, '.env')
    expect(lstatSync(join(squadRoot(), WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expect(readFileSync(envPath, 'utf8')).toBe(ENV_BYTES)
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600)
    expectNoBridge(squadRoot())
  })

  test('a second run moves nothing and changes nothing', async () => {
    legacyWorkspace(squadRoot())
    await migrateWorkspaceDotDirs(home)

    const second = await migrateWorkspaceDotDirs(home)

    expect(second).toEqual({ moved: 0, conflicts: [] })
    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe(ENV_BYTES)
    expectNoBridge(squadRoot())
  })

  test('a workspace with both dirs is reported and neither dir is touched', async () => {
    legacyWorkspace(squadRoot(), '.env', 'OLD=1\n')
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR))
    writeFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, '.env'), 'NEW=1\n')
    legacyWorkspace(squadRoot(OTHER_SQUAD))

    const result = await migrateWorkspaceDotDirs(home)

    expect(result.moved).toBe(1)
    expect(result.conflicts).toEqual([
      `${squadRoot()}: both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist`,
    ])
    expect(lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expect(readFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe('OLD=1\n')
    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe('NEW=1\n')
    // The conflict does not stop the other workspaces.
    expectNoBridge(squadRoot(OTHER_SQUAD))
  })

  test('a fresh workspace (neither dir) is left as it is', async () => {
    mkdirSync(squadRoot(), { recursive: true })

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
    expect(() => lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toThrow()
  })

  test('a workspace that has only .ficus stays canonical and is not counted as moved', async () => {
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR), { recursive: true })

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expectNoBridge(squadRoot())
  })

  test('an exact legacy link is removed', async () => {
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR), { recursive: true })
    symlinkSync(WORKSPACE_DOT_DIR, join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expectNoBridge(squadRoot())
  })

  test('a legacy link pointing anywhere else is reported and never followed', async () => {
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, '.env'), 'ELSEWHERE=1\n')
    mkdirSync(squadRoot(), { recursive: true })
    symlinkSync(outside, join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))

    const result = await migrateWorkspaceDotDirs(home)

    expect(result.moved).toBe(0)
    expect(result.conflicts).toEqual([
      `${squadRoot()}: ${LEGACY_WORKSPACE_DOT_DIR} is a link to ${outside}, not to ${WORKSPACE_DOT_DIR}`,
    ])
    expect(readlinkSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toBe(outside)
    expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
    expect(readFileSync(join(outside, '.env'), 'utf8')).toBe('ELSEWHERE=1\n')
  })

  test('a .ficus that is not a real directory is reported and left alone', async () => {
    legacyWorkspace(squadRoot())
    symlinkSync(join(home, 'nowhere'), join(squadRoot(), WORKSPACE_DOT_DIR))

    const result = await migrateWorkspaceDotDirs(home)

    expect(result.moved).toBe(0)
    expect(result.conflicts).toEqual([`${squadRoot()}: ${WORKSPACE_DOT_DIR} is not a directory`])
    expect(lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
  })

  test('a legacy name that is a plain file is reported and left alone', async () => {
    mkdirSync(squadRoot(), { recursive: true })
    writeFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR), 'not a dir')

    const result = await migrateWorkspaceDotDirs(home)

    expect(result.conflicts).toEqual([`${squadRoot()}: ${LEGACY_WORKSPACE_DOT_DIR} is not a directory`])
    expect(readFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR), 'utf8')).toBe('not a dir')
  })

  test('a squad workspace that is itself a symlink is reported and not followed', async () => {
    const elsewhere = join(home, 'elsewhere')
    legacyWorkspace(elsewhere)
    mkdirSync(join(home, 'workspaces', 'squads'), { recursive: true })
    symlinkSync(elsewhere, squadRoot())

    const result = await migrateWorkspaceDotDirs(home)

    expect(result).toEqual({ moved: 0, conflicts: [`${squadRoot()}: the workspace is a symlink, not followed`] })
    expect(lstatSync(join(elsewhere, LEGACY_WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expect(existsSync(join(elsewhere, WORKSPACE_DOT_DIR))).toBe(false)
  })

  test('agent private dirs move too (the identity key lives there)', async () => {
    legacyWorkspace(privateRoot('agent_a1'), 'identity.pem', 'PEM')

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 1, conflicts: [] })
    expect(readFileSync(join(privateRoot('agent_a1'), WORKSPACE_DOT_DIR, 'identity.pem'), 'utf8')).toBe('PEM')
    expectNoBridge(privateRoot('agent_a1'))
  })

  test('a HOME with no workspaces yet is a no-op', async () => {
    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
  })

  test.skipIf(process.getuid?.() === 0)(
    'a permission error is reported, leaves the legacy dir intact, and the next run retries',
    async () => {
      legacyWorkspace(squadRoot())
      chmodSync(squadRoot(), 0o555)
      try {
        const result = await migrateWorkspaceDotDirs(home)
        expect(result.moved).toBe(0)
        expect(result.conflicts).toHaveLength(1)
        expect(result.conflicts[0]).toStartWith(`${squadRoot()}: could not move ${LEGACY_WORKSPACE_DOT_DIR}: EACCES`)
        expect(readFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe(ENV_BYTES)
        expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
      } finally {
        chmodSync(squadRoot(), 0o755)
      }
      expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 1, conflicts: [] })
      expectNoBridge(squadRoot())
    }
  )

  test('a writer holding an open file keeps writing after the directory move', async () => {
    legacyWorkspace(squadRoot(), 'current.log', 'line 1\n')
    const fd = openSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, 'current.log'), 'a')
    try {
      await migrateWorkspaceDotDirs(home)
      writeSync(fd, 'line 2\n')
    } finally {
      closeSync(fd)
    }
    writeFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, 'later.txt'), 'by path\n')

    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, 'current.log'), 'utf8')).toBe('line 1\nline 2\n')
    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, 'later.txt'), 'utf8')).toBe('by path\n')
  })
})

describe('migrateWorkspaceDotDir (one work root, used lazily by Core before it touches the dir)', () => {
  test('a second caller after the first has moved the dir sees it done and moves nothing', () => {
    legacyWorkspace(squadRoot())

    const first = migrateWorkspaceDotDir(squadRoot())
    const second = migrateWorkspaceDotDir(squadRoot())

    expect(first).toEqual({ moved: true })
    expect(second).toEqual({ moved: false })
    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe(ENV_BYTES)
  })

  test('losing the race to a process that already renamed AND linked is not a conflict', () => {
    legacyWorkspace(squadRoot())
    const legacy = join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR)
    const target = join(squadRoot(), WORKSPACE_DOT_DIR)
    let calls = 0
    // Our lstat saw the real legacy dir; before our rename, the other process moves it and links it.
    // Our rename then moves the winner's symlink onto a directory, which the OS refuses (EISDIR).
    const rename = (from: string, to: string) => {
      if (calls++ === 0) {
        renameSync(legacy, target)
        symlinkSync(WORKSPACE_DOT_DIR, legacy)
      }
      renameSync(from, to)
    }

    expect(migrateWorkspaceDotDir(squadRoot(), { rename })).toEqual({ moved: false })
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe(ENV_BYTES)
    expectNoBridge(squadRoot())
  })

  test('a rename that keeps failing after the re-read is still reported', () => {
    legacyWorkspace(squadRoot())
    const rename = () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }

    expect(migrateWorkspaceDotDir(squadRoot(), { rename })).toEqual({
      moved: false,
      conflict: `could not move ${LEGACY_WORKSPACE_DOT_DIR}: EBUSY`,
    })
    expect(lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
  })

  test('a later pass never recreates the removed link', () => {
    legacyWorkspace(squadRoot())
    migrateWorkspaceDotDir(squadRoot())

    expect(migrateWorkspaceDotDir(squadRoot())).toEqual({ moved: false })
    expectNoBridge(squadRoot())
  })
})

describe('ensureWorkspaceDotDir', () => {
  test('creates only .ficus in a fresh work root and returns the dir', () => {
    mkdirSync(squadRoot(), { recursive: true })

    expect(ensureWorkspaceDotDir(squadRoot())).toBe(join(squadRoot(), WORKSPACE_DOT_DIR))
    expect(lstatSync(join(squadRoot(), WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expectNoBridge(squadRoot())
  })

  test('moves a legacy dir first instead of creating a second one beside it', () => {
    legacyWorkspace(squadRoot())

    const dir = ensureWorkspaceDotDir(squadRoot())

    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(ENV_BYTES)
    expectNoBridge(squadRoot())
  })
})

describe('workspaceDotDirsLogLine', () => {
  test('is the exact line the F4 runbook greps for', () => {
    expect(workspaceDotDirsLogLine({ moved: 3, conflicts: [] })).toBe('migrateWorkspaceDotDirs moved=3 conflicts=[]')
    expect(workspaceDotDirsLogLine({ moved: 0, conflicts: ['/h/w: both'] })).toBe(
      'migrateWorkspaceDotDirs moved=0 conflicts=["/h/w: both"]'
    )
  })
})

describe('fail closed: Core never uses .ficus beside an unresolved conflict', () => {
  /** Asserts the conflict kind, and that the message is actionable and names no path beyond the workspace id. */
  function expectConflict(
    run: () => unknown,
    kind: WorkspaceDotDirConflictKind,
    root = squadRoot()
  ): WorkspaceDotDirConflictError {
    let thrown: unknown
    try {
      run()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WorkspaceDotDirConflictError)
    const error = thrown as WorkspaceDotDirConflictError
    expect(error.kind).toBe(kind)
    expect(error.code).toBe('workspace_dot_dir_conflict')
    expect(error.message).toStartWith(`Workspace ${basename(root)} needs a manual fix to its settings dir: `)
    expect(error.message).not.toContain(home)
    return error
  }

  test('both real dirs: prepare throws and nothing changes', () => {
    legacyWorkspace(squadRoot(), '.env', 'OLD=1\n')
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR))

    const error = expectConflict(() => prepareWorkspaceDotDir(squadRoot()), 'both-present')
    expect(error.message).toContain(
      `Merge anything still needed from ${LEGACY_WORKSPACE_DOT_DIR}/ into ${WORKSPACE_DOT_DIR}/, then remove ${LEGACY_WORKSPACE_DOT_DIR}/`
    )
    expect(readFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe('OLD=1\n')
  })

  test('a legacy link elsewhere: ensure throws and does not create .ficus beside it', () => {
    const outside = join(home, 'outside')
    mkdirSync(outside)
    mkdirSync(squadRoot(), { recursive: true })
    symlinkSync(outside, join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))

    const error = expectConflict(() => ensureWorkspaceDotDir(squadRoot()), 'legacy-link-elsewhere')
    expect(error.message).toContain('then remove the link')
    expect(error.message).not.toContain(outside)
    expect(error.detail).toBe(`${LEGACY_WORKSPACE_DOT_DIR} is a link to ${outside}`)
    expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
  })

  test('a .ficus symlink: ensure throws instead of writing through it', () => {
    const outside = join(home, 'outside')
    mkdirSync(outside)
    mkdirSync(squadRoot(), { recursive: true })
    symlinkSync(outside, join(squadRoot(), WORKSPACE_DOT_DIR))

    expect(expectConflict(() => ensureWorkspaceDotDir(squadRoot()), 'ficus-not-a-directory').message).toContain(
      'Replace it with a directory'
    )
    expect(existsSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)('a legacy dir that could not be moved: ensure throws, no .ficus', () => {
    legacyWorkspace(squadRoot())
    chmodSync(squadRoot(), 0o555)
    try {
      expectConflict(() => ensureWorkspaceDotDir(squadRoot()), 'legacy-not-moved')
      expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
    } finally {
      chmodSync(squadRoot(), 0o755)
    }
  })

  test('a symlinked workspace that still holds the legacy dir throws; one without it is usable', () => {
    const elsewhere = join(home, 'elsewhere')
    legacyWorkspace(elsewhere)
    mkdirSync(join(home, 'workspaces', 'squads'), { recursive: true })
    symlinkSync(elsewhere, squadRoot())
    expect(expectConflict(() => prepareWorkspaceDotDir(squadRoot()), 'symlinked-workspace').message).toContain(
      `In the target, move ${LEGACY_WORKSPACE_DOT_DIR}/ to ${WORKSPACE_DOT_DIR}/`
    )

    const clean = join(home, 'clean')
    mkdirSync(clean)
    symlinkSync(clean, squadRoot(OTHER_SQUAD))
    expect(() => prepareWorkspaceDotDir(squadRoot(OTHER_SQUAD))).not.toThrow()
  })

  test('the agent identity path refuses a conflicted private dir, so no second key is minted', () => {
    const sandboxId = `agent_dotdir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const root = join(getHomeDir(), 'private', sandboxId)
    try {
      mkdirSync(join(root, LEGACY_WORKSPACE_DOT_DIR), { recursive: true })
      writeFileSync(join(root, LEGACY_WORKSPACE_DOT_DIR, 'identity.pem'), 'OLD KEY')
      mkdirSync(join(root, WORKSPACE_DOT_DIR))

      expect(() => preparedAgentIdentityHostPath(sandboxId)).toThrow(WorkspaceDotDirConflictError)
      expect(existsSync(join(root, WORKSPACE_DOT_DIR, 'identity.pem'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
