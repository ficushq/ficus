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
