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
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEGACY_WORKSPACE_DOT_DIR,
  WORKSPACE_DOT_DIR,
  ensureWorkspaceDotDir,
  migrateWorkspaceDotDir,
  migrateWorkspaceDotDirs,
  workspaceDotDirsLogLine,
  workspaceDotPath,
} from './dot-dir'

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

function expectBridgeLink(root: string): void {
  const legacy = join(root, LEGACY_WORKSPACE_DOT_DIR)
  expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
  // Relative, so it resolves the same from inside a container that mounts the workspace elsewhere.
  expect(readlinkSync(legacy)).toBe(WORKSPACE_DOT_DIR)
}

describe('workspaceDotPath', () => {
  test('joins segments under the work root dot dir', () => {
    expect(WORKSPACE_DOT_DIR).toBe('.ficus')
    expect(workspaceDotPath('/workspace/sq', '.env')).toBe('/workspace/sq/.ficus/.env')
    expect(workspaceDotPath('/private', 'monitors', 'm1')).toBe('/private/.ficus/monitors/m1')
    expect(workspaceDotPath('/w')).toBe('/w/.ficus')
  })
})

describe('migrateWorkspaceDotDirs', () => {
  test('a legacy dot dir moves to .ficus with the same bytes and a relative legacy link left behind', async () => {
    legacyWorkspace(squadRoot())

    const result = await migrateWorkspaceDotDirs(home)

    expect(result).toEqual({ moved: 1, conflicts: [] })
    const envPath = join(squadRoot(), WORKSPACE_DOT_DIR, '.env')
    expect(lstatSync(join(squadRoot(), WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expect(readFileSync(envPath, 'utf8')).toBe(ENV_BYTES)
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600)
    expectBridgeLink(squadRoot())
    // A reader still on the legacy name (a rolled-back Core, a running agent) finds the same file.
    expect(readFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe(ENV_BYTES)
  })

  test('a second run moves nothing and changes nothing', async () => {
    legacyWorkspace(squadRoot())
    await migrateWorkspaceDotDirs(home)

    const second = await migrateWorkspaceDotDirs(home)

    expect(second).toEqual({ moved: 0, conflicts: [] })
    expect(readFileSync(join(squadRoot(), WORKSPACE_DOT_DIR, '.env'), 'utf8')).toBe(ENV_BYTES)
    expectBridgeLink(squadRoot())
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
    expectBridgeLink(squadRoot(OTHER_SQUAD))
  })

  test('a fresh workspace (neither dir) is left as it is', async () => {
    mkdirSync(squadRoot(), { recursive: true })

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expect(existsSync(join(squadRoot(), WORKSPACE_DOT_DIR))).toBe(false)
    expect(() => lstatSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))).toThrow()
  })

  test('a workspace that has only .ficus gets the legacy link, and is not counted as moved', async () => {
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR), { recursive: true })

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expectBridgeLink(squadRoot())
  })

  test('a legacy link that already points at .ficus is accepted as migrated', async () => {
    mkdirSync(join(squadRoot(), WORKSPACE_DOT_DIR), { recursive: true })
    symlinkSync(WORKSPACE_DOT_DIR, join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))

    expect(await migrateWorkspaceDotDirs(home)).toEqual({ moved: 0, conflicts: [] })
    expectBridgeLink(squadRoot())
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
    expectBridgeLink(privateRoot('agent_a1'))
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
      expectBridgeLink(squadRoot())
    }
  )

  test('a writer holding an open file, or writing by the legacy path afterwards, lands in .ficus', async () => {
    legacyWorkspace(squadRoot(), 'current.log', 'line 1\n')
    const fd = openSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, 'current.log'), 'a')
    try {
      await migrateWorkspaceDotDirs(home)
      writeSync(fd, 'line 2\n')
    } finally {
      closeSync(fd)
    }
    writeFileSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR, 'later.txt'), 'by path\n')

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

  test('a link deleted after the move (a crash between rename and link) is recreated', () => {
    legacyWorkspace(squadRoot())
    migrateWorkspaceDotDir(squadRoot())
    rmSync(join(squadRoot(), LEGACY_WORKSPACE_DOT_DIR))

    expect(migrateWorkspaceDotDir(squadRoot())).toEqual({ moved: false })
    expectBridgeLink(squadRoot())
  })
})

describe('ensureWorkspaceDotDir', () => {
  test('creates .ficus and the legacy link in a fresh work root and returns the dir', () => {
    mkdirSync(squadRoot(), { recursive: true })

    expect(ensureWorkspaceDotDir(squadRoot())).toBe(join(squadRoot(), WORKSPACE_DOT_DIR))
    expect(lstatSync(join(squadRoot(), WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    expectBridgeLink(squadRoot())
  })

  test('moves a legacy dir first instead of creating a second one beside it', () => {
    legacyWorkspace(squadRoot())

    const dir = ensureWorkspaceDotDir(squadRoot())

    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(ENV_BYTES)
    expectBridgeLink(squadRoot())
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
