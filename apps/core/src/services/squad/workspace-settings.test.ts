import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path, { join } from 'path'
import type { BashResponse } from '../sandbox/client/http-client'
import {
  buildSandboxWorkspaceSearchCommand,
  isWorkspaceSettingsDirName,
  isWorkspaceSettingsPath,
  resolveLocalWorkspaceTarget,
  resolveLocalWorkspaceWriteTarget,
  resolveSandboxWorkspaceTarget,
  type SandboxPathClient,
} from './workspace-settings'

let base: string
let workspace: string
let outside: string

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-settings-')))
  workspace = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(join(workspace, '.ficus', 'monitors', 'm1'), { recursive: true })
  mkdirSync(join(workspace, 'docs', '.ficus'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workspace, '.ficus', '.env'), 'SYNTHETIC_SETTING=1\n')
  writeFileSync(join(workspace, '.ficus', 'monitors', 'm1', 'token'), 'synthetic-token')
  writeFileSync(join(workspace, 'docs', 'readme.md'), 'hello')
  writeFileSync(join(workspace, 'docs', '.ficus', 'config.json'), '{}')
  writeFileSync(join(workspace, 'notes.txt'), 'notes')
  writeFileSync(join(outside, 'other.txt'), 'other')
  symlinkSync('.ficus', join(workspace, 'settings-link'))
  symlinkSync('.ficus/.env', join(workspace, 'env-link'))
  symlinkSync('../.ficus/.env', join(workspace, 'docs', 'nested-env-link'))
  symlinkSync('.', join(workspace, 'self-link'))
  symlinkSync(join(workspace, '.ficus', '.env'), join(workspace, 'absolute-env-link'))
  symlinkSync(outside, join(workspace, 'outside-link'))
  symlinkSync('docs/readme.md', join(workspace, 'readme-link'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('isWorkspaceSettingsDirName', () => {
  it('matches the settings directory name regardless of case and trailing dots or spaces', () => {
    for (const name of ['.ficus', '.FICUS', '.Ficus', '.ficus.', '.ficus..', '.ficus ', '.ficus. ']) {
      expect(isWorkspaceSettingsDirName(name)).toBe(true)
    }
  })

  it('does not match other names', () => {
    for (const name of ['', '.', '..', 'ficus', '.ficusx', '.ficus-old', 'x.ficus', '.env']) {
      expect(isWorkspaceSettingsDirName(name)).toBe(false)
    }
  })
})

describe('isWorkspaceSettingsPath', () => {
  it('covers the root settings directory and everything below it', () => {
    expect(isWorkspaceSettingsPath('/w', '/w/.ficus')).toBe(true)
    expect(isWorkspaceSettingsPath('/w', '/w/.ficus/.env')).toBe(true)
    expect(isWorkspaceSettingsPath('/w', '/w/.FICUS./monitors/x/token')).toBe(true)
  })

  it('leaves the root itself, nested settings-named directories and outside paths alone', () => {
    expect(isWorkspaceSettingsPath('/w', '/w')).toBe(false)
    expect(isWorkspaceSettingsPath('/w', '/w/docs/.ficus/config.json')).toBe(false)
    expect(isWorkspaceSettingsPath('/w', '/other/.ficus/.env')).toBe(false)
    expect(isWorkspaceSettingsPath('/w', '/w/.ficusx/file')).toBe(false)
  })

  it('works with posix paths explicitly', () => {
    expect(isWorkspaceSettingsPath('/workspace/s', '/workspace/s/.ficus/.env', path.posix)).toBe(true)
    expect(isWorkspaceSettingsPath('/workspace/s', '/workspace/s/a/.ficus', path.posix)).toBe(false)
  })
})

/** Request paths that must all resolve to the settings directory or something inside it. */
const settingsRequests = [
  '.ficus',
  '.ficus/',
  '.ficus/.env',
  './.ficus/.env',
  '/.ficus/.env',
  '.ficus//.env',
  '//.ficus///.env',
  'docs/../.ficus/.env',
  'docs/./../.ficus/monitors/m1/token',
  '.FICUS/.env',
  '.Ficus/.env',
  '.ficus./.env',
  '.ficus /.env',
  'settings-link',
  'settings-link/.env',
  'settings-link/monitors/m1/token',
  'env-link',
  'docs/nested-env-link',
  'self-link/.ficus/.env',
  'self-link/self-link/.ficus',
  'absolute-env-link',
]

/** Requests that escape the workspace, lexically or through a symlink. */
const escapingRequests = ['../outside/other.txt', '..', 'docs/../../outside', 'outside-link/other.txt', 'outside-link']

describe('resolveLocalWorkspaceTarget', () => {
  it('treats every form of the settings directory as not found', () => {
    for (const request of settingsRequests) {
      // On the Core's own filesystem a leading slash names an absolute path (outside this
      // temporary workspace), which is refused as invalid instead; either way nothing is served.
      const expected = request.startsWith('/') ? 'invalid' : 'not-found'
      expect([request, resolveLocalWorkspaceTarget(workspace, request)]).toEqual([
        request,
        { ok: false, reason: expected },
      ])
    }
    expect(resolveLocalWorkspaceTarget(workspace, join(workspace, '.ficus', '.env'))).toEqual({
      ok: false,
      reason: 'not-found',
    })
  })

  it('refuses paths that escape the workspace', () => {
    for (const request of escapingRequests) {
      expect([request, resolveLocalWorkspaceTarget(workspace, request)]).toEqual([
        request,
        { ok: false, reason: 'invalid' },
      ])
    }
  })

  it('reports a missing path as not found', () => {
    expect(resolveLocalWorkspaceTarget(workspace, 'missing.txt')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveLocalWorkspaceTarget(workspace, '.ficus%2F.env')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('still resolves ordinary files, nested settings-named directories and in-workspace links', () => {
    expect(resolveLocalWorkspaceTarget(workspace, 'notes.txt')).toEqual({
      ok: true,
      path: join(workspace, 'notes.txt'),
      isRoot: false,
    })
    expect(resolveLocalWorkspaceTarget(workspace, 'docs/.ficus/config.json')).toEqual({
      ok: true,
      path: join(workspace, 'docs', '.ficus', 'config.json'),
      isRoot: false,
    })
    expect(resolveLocalWorkspaceTarget(workspace, 'readme-link')).toEqual({
      ok: true,
      path: join(workspace, 'docs', 'readme.md'),
      isRoot: false,
    })
  })

  it('flags the workspace root, however it is reached', () => {
    for (const request of ['', '.', 'docs/..', 'self-link', workspace]) {
      expect([request, resolveLocalWorkspaceTarget(workspace, request)]).toEqual([
        request,
        { ok: true, path: workspace, isRoot: true },
      ])
    }
  })
})

describe('resolveLocalWorkspaceWriteTarget', () => {
  // New files under the settings directory, reached through every spelling and link.
  const settingsWriteRequests = [
    ...settingsRequests,
    '.ficus/new.txt',
    '.ficus/new-dir/new.txt',
    'docs/../.ficus/new.txt',
    '.FICUS./new.txt',
    'settings-link/new.txt',
    'settings-link/new-dir/new.txt',
    'self-link/.ficus/new.txt',
    'self-link/settings-link/new.txt',
  ]

  it('refuses every form of the settings directory, including files that do not exist yet', () => {
    for (const request of settingsWriteRequests) {
      const expected = request.startsWith('/') ? 'invalid' : 'not-found'
      expect([request, resolveLocalWorkspaceWriteTarget(workspace, request)]).toEqual([
        request,
        { ok: false, reason: expected },
      ])
    }
  })

  it('refuses a dangling link and a symlinked parent that resolve into the settings directory', () => {
    const scratch = join(workspace, 'write-links')
    mkdirSync(scratch, { recursive: true })
    try {
      symlinkSync('../.ficus/not-yet.txt', join(scratch, 'dangling'))
      symlinkSync('../.ficus/missing-dir', join(scratch, 'dangling-dir'))
      symlinkSync('../settings-link', join(scratch, 'chained'))
      for (const request of [
        'write-links/dangling',
        'write-links/dangling-dir/new.txt',
        'write-links/chained/new.txt',
        'write-links/chained/monitors/new.txt',
      ]) {
        expect([request, resolveLocalWorkspaceWriteTarget(workspace, request)]).toEqual([
          request,
          { ok: false, reason: 'not-found' },
        ])
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('refuses paths that escape the workspace, through a link or a link loop', () => {
    const scratch = join(workspace, 'write-loops')
    mkdirSync(scratch, { recursive: true })
    try {
      symlinkSync('loop-b', join(scratch, 'loop-a'))
      symlinkSync('loop-a', join(scratch, 'loop-b'))
      symlinkSync('../../outside/new.txt', join(scratch, 'dangling-outside'))
      for (const request of [
        ...escapingRequests,
        'outside-link/new.txt',
        'write-loops/loop-a',
        'write-loops/loop-a/new.txt',
        'write-loops/dangling-outside',
      ]) {
        expect([request, resolveLocalWorkspaceWriteTarget(workspace, request)]).toEqual([
          request,
          { ok: false, reason: 'invalid' },
        ])
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('allows new and existing ordinary files, nested settings-named directories and in-workspace links', () => {
    for (const [request, expected] of [
      ['new.txt', join(workspace, 'new.txt')],
      ['new-dir/deeper/new.txt', join(workspace, 'new-dir', 'deeper', 'new.txt')],
      ['notes.txt', join(workspace, 'notes.txt')],
      ['docs/.ficus/new.json', join(workspace, 'docs', '.ficus', 'new.json')],
      ['.ficus%2Fnew.txt', join(workspace, '.ficus%2Fnew.txt')],
      ['.ficus-notes/new.txt', join(workspace, '.ficus-notes', 'new.txt')],
      ['self-link/new.txt', join(workspace, 'self-link', 'new.txt')],
      ['readme-link', join(workspace, 'readme-link')],
    ]) {
      expect([request, resolveLocalWorkspaceWriteTarget(workspace, request)]).toEqual([
        request,
        { ok: true, path: expected, isRoot: false },
      ])
    }
  })
})

/**
 * A sandbox client whose `bash` runs the command on this machine, so the
 * box-side realpath and search commands are exercised for real.
 */
function localBashClient(): SandboxPathClient & { commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    bash: ({ command, cwd }) => {
      commands.push(command)
      const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
      const emitter = {
        on(event: string, listener: (arg?: never) => void) {
          ;(listeners[event] ??= []).push(listener as (arg?: unknown) => void)
          return emitter
        },
      }
      queueMicrotask(() => {
        const result = Bun.spawnSync(['bash', '-c', command], { cwd })
        const data: BashResponse = { stdout: Buffer.from(result.stdout).toString('base64'), exitCode: result.exitCode }
        for (const listener of listeners.data ?? []) listener(data)
        for (const listener of listeners.end ?? []) listener()
      })
      return emitter as ReturnType<SandboxPathClient['bash']>
    },
  }
}

describe('resolveSandboxWorkspaceTarget', () => {
  it('treats every form of the settings directory as not found', async () => {
    const client = localBashClient()
    for (const request of settingsRequests) {
      expect([request, await resolveSandboxWorkspaceTarget(client, workspace, request)]).toEqual([
        request,
        { ok: false, reason: 'not-found' },
      ])
    }
  })

  it('refuses write targets that do not exist yet but resolve into the settings directory', async () => {
    const client = localBashClient()
    const scratch = join(workspace, 'box-write-links')
    mkdirSync(scratch, { recursive: true })
    try {
      symlinkSync('../.ficus/not-yet.txt', join(scratch, 'dangling'))
      symlinkSync('../.ficus/missing-dir', join(scratch, 'dangling-dir'))
      symlinkSync('../settings-link', join(scratch, 'chained'))
      for (const request of [
        'settings-link/new.txt',
        'settings-link/new-dir/new.txt',
        'self-link/settings-link/new.txt',
        'box-write-links/dangling',
        'box-write-links/dangling-dir/new.txt',
        'box-write-links/chained/new.txt',
      ]) {
        expect([request, await resolveSandboxWorkspaceTarget(client, workspace, request)]).toEqual([
          request,
          { ok: false, reason: 'not-found' },
        ])
      }
      expect(await resolveSandboxWorkspaceTarget(client, workspace, 'new-dir/new.txt')).toEqual({
        ok: true,
        path: join(workspace, 'new-dir', 'new.txt'),
        isRoot: false,
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('answers lexical settings paths without a round trip to the box', async () => {
    const client = localBashClient()
    for (const request of ['.ficus/.env', 'docs/../.ficus', '.FICUS./x']) {
      expect(await resolveSandboxWorkspaceTarget(client, workspace, request)).toEqual({
        ok: false,
        reason: 'not-found',
      })
    }
    expect(client.commands).toEqual([])
  })

  it('refuses paths that escape the workspace', async () => {
    const client = localBashClient()
    for (const request of escapingRequests) {
      expect([request, await resolveSandboxWorkspaceTarget(client, workspace, request)]).toEqual([
        request,
        { ok: false, reason: 'invalid' },
      ])
    }
  })

  it('serves the lexical path of ordinary files and flags the root', async () => {
    const client = localBashClient()
    expect(await resolveSandboxWorkspaceTarget(client, workspace, '/docs//readme.md')).toEqual({
      ok: true,
      path: join(workspace, 'docs', 'readme.md'),
      isRoot: false,
    })
    expect(await resolveSandboxWorkspaceTarget(client, workspace, 'docs/.ficus/config.json')).toEqual({
      ok: true,
      path: join(workspace, 'docs', '.ficus', 'config.json'),
      isRoot: false,
    })
    expect(await resolveSandboxWorkspaceTarget(client, workspace, 'self-link')).toEqual({
      ok: true,
      path: join(workspace, 'self-link'),
      isRoot: true,
    })
    expect(await resolveSandboxWorkspaceTarget(client, workspace, '')).toEqual({
      ok: true,
      path: workspace,
      isRoot: true,
    })
  })

  it('quotes request paths so they are never read as shell syntax', async () => {
    const client = localBashClient()
    const marker = join(base, 'quoted-marker')
    const request = `x'; touch '${marker}'; echo '$(touch ${marker})`
    expect(await resolveSandboxWorkspaceTarget(client, workspace, request)).toMatchObject({ ok: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('fails closed when the box cannot resolve the path', async () => {
    const failing: SandboxPathClient = {
      bash: () => {
        const emitter = {
          on(event: string, listener: (arg?: never) => void) {
            if (event === 'data')
              queueMicrotask(() => (listener as unknown as (data: BashResponse) => void)({ exitCode: 3 }))
            if (event === 'end') queueMicrotask(() => queueMicrotask(() => (listener as () => void)()))
            return emitter
          },
        }
        return emitter as ReturnType<SandboxPathClient['bash']>
      },
    }
    await expect(resolveSandboxWorkspaceTarget(failing, workspace, 'notes.txt')).rejects.toThrow(
      'Could not resolve the workspace path'
    )
  })
})

describe('buildSandboxWorkspaceSearchCommand', () => {
  const search = (query: string) =>
    Bun.spawnSync(['bash', '-c', buildSandboxWorkspaceSearchCommand(workspace, query)], { cwd: workspace })
      .stdout.toString()
      .split('\n')
      .filter(Boolean)
      .map((file) => file.replace(`${workspace}/`, ''))

  it('finds ordinary files, including under nested settings-named directories', () => {
    expect(search('readme').sort()).toEqual(['docs/readme.md', 'readme-link'])
    expect(search('config')).toEqual(['docs/.ficus/config.json'])
  })

  it('never visits the settings directory at the workspace root', () => {
    expect(search('token')).toEqual([])
    expect(search('.env')).toEqual([])
    expect(search('')).not.toContain('.ficus/.env')
    expect(search('').some((file) => file.startsWith('.ficus'))).toBe(false)
  })

  it('treats hostile input as a file-name pattern, never as shell syntax', () => {
    const marker = join(base, 'search-marker')
    for (const query of [
      `'; touch '${marker}'; echo '`,
      `\\'; touch ${marker}; echo \\'`,
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `x" ; touch ${marker} ; "`,
      `x\ntouch ${marker}\n`,
    ]) {
      expect(search(query)).toEqual([])
      expect(existsSync(marker)).toBe(false)
    }
  })
})
