import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_HOME_DIR_NAME } from '@ficus/shared/node'
import { apiGet, apiPatch, apiPost } from '../client'
import { output, outputError, setOutputOptions } from '../output'
import { upsertInstance } from '../local-server/state'
import { defaultUpdateDeps, registerUpdateCommands } from './update'

describe('update CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPatch as ReturnType<typeof mock>).mockClear()
  })
  async function run(args: string[]) {
    const program = new Command()
    program.exitOverride()
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerUpdateCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }
  it('posts check', async () => {
    await run(['update', 'check'])
    expect(apiPost).toHaveBeenCalledWith('/api/updates/check')
  })
  it('posts apply', async () => {
    await run(['update', 'apply'])
    expect(apiPost).toHaveBeenCalledWith('/api/updates/apply')
  })
  it('gets status', async () => {
    await run(['update', 'status'])
    expect(apiGet).toHaveBeenCalledWith('/api/updates/status')
  })
  it('patches toggle', async () => {
    await run(['update', 'toggle', 'on'])
    expect(apiPatch).toHaveBeenCalledWith('/api/updates/settings', { enabled: true })
  })
})

describe('update apply offline fallback', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
  })
  /** Deps for a CLI pointed at the local checkout's own instance (loopback, matching port). */
  function localDeps(
    offline: Parameters<typeof registerUpdateCommands>[1]['offlineUpdate'],
    overrides: Partial<Parameters<typeof registerUpdateCommands>[1]> = {}
  ): Parameters<typeof registerUpdateCommands>[1] {
    return {
      resolveRoot: () => '/r',
      apiUrl: () => 'http://localhost:3100',
      localPort: () => 3100,
      offlineUpdate: offline,
      log: () => {},
      ...overrides,
    }
  }
  async function runWith(deps: Parameters<typeof registerUpdateCommands>[1], args: string[]) {
    const program = new Command()
    program.exitOverride()
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerUpdateCommands(program, deps)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }
  it('falls back to the offline path on a transport failure', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')))
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline), ['update', 'apply'])
    expect(offline).toHaveBeenCalledWith(expect.objectContaining({ root: '/r' }))
  })
  it('never falls back when the API target is not the local instance', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }))
    )
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline, { apiUrl: () => 'https://demo.ficus.sh' }), ['update', 'apply'])
    expect(offline).not.toHaveBeenCalled()
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toContain('https://demo.ficus.sh is unreachable')
    expect(error.message).toContain('ficus server update')
  })
  it("never falls back when the loopback port is not the checkout's port", async () => {
    ;(apiPost as ReturnType<typeof mock>).mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')))
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline, { apiUrl: () => 'http://localhost:3000', localPort: () => 3100 }), [
      'update',
      'apply',
    ])
    expect(offline).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })
  it('announces the target on both paths', async () => {
    const lines: string[] = []
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline, { log: (l) => lines.push(l) }), ['update', 'apply'])
    expect(lines).toContain('Updating http://localhost:3100 via the API')
    await runWith(localDeps(offline, { log: (l) => lines.push(l) }), ['update', 'apply', '--offline'])
    expect(lines).toContain('Updating the local checkout /r (offline)')
  })
  it('does not fall back on an HTTP error', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockImplementationOnce(() => Promise.reject(new Error('Unauthorized')))
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline), ['update', 'apply'])
    expect(offline).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })
  it('--offline skips the API entirely and passes --ref', async () => {
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline), ['update', 'apply', '--offline', '--ref', 'v2'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(offline).toHaveBeenCalledWith(expect.objectContaining({ root: '/r', ref: 'v2' }))
  })
  it('rejects --ref without --offline before calling the API', async () => {
    const offline = mock(async () => ({ before: 'a', after: 'b' }))
    await runWith(localDeps(offline), ['update', 'apply', '--ref', 'v2'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(offline).not.toHaveBeenCalled()
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toBe('--ref only applies to the offline path — pass --offline')
  })
  // <root>/.ficus/local-update-status.json, or the pre-rename dir while a checkout still has only that one.
  for (const [where, dirName] of [
    ['.ficus', '.ficus'],
    ['the legacy dir', LEGACY_HOME_DIR_NAME],
  ] as const) {
    it(`status --offline reads the persisted run file from ${where}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ficus-upd-'))
      mkdirSync(join(dir, dirName))
      writeFileSync(
        join(dir, dirName, 'local-update-status.json'),
        JSON.stringify({ id: 'r1', status: 'succeeded', mode: 'offline' })
      )
      await runWith(
        localDeps(async () => ({ before: '', after: '' }), { resolveRoot: () => dir }),
        ['update', 'status', '--offline']
      )
      expect(apiGet).not.toHaveBeenCalled()
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          latest: dirName === '.ficus' ? expect.objectContaining({ id: 'r1' }) : null,
          source: join(dir, '.ficus', 'local-update-status.json'),
        }),
        expect.any(String)
      )
      rmSync(dir, { recursive: true, force: true })
    })
  }
})

describe('defaultUpdateDeps localPort', () => {
  it("takes the port from the registry entry that owns the root, else that checkout's .env PORT", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-upd-port-'))
    const root = join(tmp, 'smoke')
    const other = join(tmp, 'other')
    for (const d of [root, other]) mkdirSync(d, { recursive: true })
    // A stale PORT line: the registry is what the running instance was started with.
    writeFileSync(join(root, '.env'), 'PORT=4000\n')
    writeFileSync(join(other, '.env'), 'PORT=4321\n')
    const statePath = join(tmp, 'registry.json')
    // The DEFAULT instance is a different checkout: looking the root up by
    // label would answer for the wrong one.
    upsertInstance(
      'ficus',
      { root: join(tmp, 'default'), port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't' },
      {},
      statePath
    )
    upsertInstance('smoke', { root, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't' }, {}, statePath)
    const saved = process.env.FICUS_LOCAL_SERVER_STATE
    process.env.FICUS_LOCAL_SERVER_STATE = statePath
    try {
      expect(defaultUpdateDeps().localPort(root)).toBe(3100)
      expect(() => defaultUpdateDeps().offlineUpdate({ root, log: () => {} })).toThrow('ficus-host-layout-bridge')
      expect(defaultUpdateDeps().localPort(other)).toBe(4321)
      expect(defaultUpdateDeps().localPort(join(tmp, 'nope'))).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.FICUS_LOCAL_SERVER_STATE
      else process.env.FICUS_LOCAL_SERVER_STATE = saved
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

it('refuses standalone offline update when only the old home registry exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'ficus-update-old-home-'))
  const oldDir = join(home, LEGACY_HOME_DIR_NAME, 'cli')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'local-server.json'), JSON.stringify({ version: 3, instances: {} }))
  const savedHome = process.env.HOME
  const savedState = process.env.FICUS_LOCAL_SERVER_STATE
  try {
    process.env.HOME = home
    delete process.env.FICUS_LOCAL_SERVER_STATE
    expect(() => defaultUpdateDeps().resolveRoot()).toThrow('ficus-host-layout-bridge')
    expect(() => defaultUpdateDeps().offlineUpdate({ root: home, log: () => {} })).toThrow('ficus-host-layout-bridge')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedState === undefined) delete process.env.FICUS_LOCAL_SERVER_STATE
    else process.env.FICUS_LOCAL_SERVER_STATE = savedState
    rmSync(home, { recursive: true, force: true })
  }
})
