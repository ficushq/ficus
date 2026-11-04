/**
 * The workspace browsing, download and search routes on a runtime where Core
 * reads the workspace from its own filesystem (host here; docker takes the
 * same branch). The settings directory at the workspace root is never listed,
 * served, archived or searched, however the request spells it, while ordinary
 * files keep working. The sandbox-backed branch is covered in
 * squads-sandbox-paths.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { squadsRouter } from './squads'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { clearHostWorkspaceOverrides, setHostWorkspaceOverride } from '../services/sandbox/host/workspace-overrides'
import { clearDirCache } from '../services/squad/workspace'
import { readSquadFile } from '../services/squad/read-file'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)

const prefix = `sq-ws-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SETTING_VALUE = 'SYNTHETIC_SETTING_VALUE_7f3a'
const TOKEN_VALUE = 'synthetic-monitor-token-91c2'
let admin: TestUser
let squadId: string
let base: string
let workspace: string
let prevRuntime: string | undefined

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  squadId = (await Squad.create({ name: `${prefix} Settings`, purpose: 'boundary' })).id
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(() => {
  prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
  process.env.FICUS_SANDBOX_RUNTIME = 'host'
  base = realpathSync(mkdtempSync(join(tmpdir(), 'squad-ws-settings-')))
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, '.ficus', 'monitors', 'm1'), { recursive: true })
  mkdirSync(join(workspace, 'docs', '.ficus'), { recursive: true })
  mkdirSync(join(base, 'outside'), { recursive: true })
  writeFileSync(join(workspace, '.ficus', '.env'), `${SETTING_VALUE}=1\n`)
  writeFileSync(join(workspace, '.ficus', 'monitors', 'm1', 'token'), TOKEN_VALUE)
  writeFileSync(join(workspace, 'docs', 'readme.md'), 'hello')
  writeFileSync(join(workspace, 'docs', '.ficus', 'config.json'), '{"nested":true}')
  writeFileSync(join(workspace, 'notes.txt'), 'notes')
  writeFileSync(join(base, 'outside', 'other.txt'), 'outside')
  symlinkSync('.ficus', join(workspace, 'settings-link'))
  symlinkSync('../.ficus/.env', join(workspace, 'docs', 'env-link'))
  symlinkSync('.', join(workspace, 'self-link'))
  symlinkSync(join(base, 'outside'), join(workspace, 'outside-link'))
  setHostWorkspaceOverride(squadId, workspace)
  clearDirCache()
})

afterEach(() => {
  clearHostWorkspaceOverrides()
  if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
  rmSync(base, { recursive: true, force: true })
})

function get(route: string, path: string, extra = '') {
  return app.request(`/api/squads/${squadId}/workspace/${route}?path=${encodeURIComponent(path)}${extra}`, {
    headers: authHeaders(admin.token),
  })
}

const settingsPaths = [
  '.ficus',
  '.ficus/',
  '.ficus/.env',
  './.ficus/.env',
  '.ficus//.env',
  'docs/../.ficus/.env',
  'docs/./../.ficus/monitors/m1/token',
  '.FICUS/.env',
  '.ficus./.env',
  'settings-link',
  'settings-link/.env',
  'settings-link/monitors/m1/token',
  'docs/env-link',
  'self-link/.ficus/.env',
]

async function expectNoSecret(res: Response) {
  const body = await res.text()
  expect(body).not.toContain(SETTING_VALUE)
  expect(body).not.toContain(TOKEN_VALUE)
  return body
}

describe('local workspace routes never expose the workspace settings directory', () => {
  for (const [route, notFound] of [
    ['file', 'File not found'],
    ['download', 'Path not found'],
    ['tree', 'Path not found'],
  ] as const) {
    it(`${route} answers the existing not-found shape for every spelling of the settings directory`, async () => {
      for (const path of settingsPaths) {
        const res = await get(route, path)
        expect([path, res.status]).toEqual([path, 404])
        expect(JSON.parse(await expectNoSecret(res))).toEqual({ error: notFound })
      }
    })

    it(`${route} still refuses paths that escape the workspace, including through a link`, async () => {
      for (const path of ['../outside/other.txt', 'outside-link', 'outside-link/other.txt']) {
        const res = await get(route, path)
        expect([path, res.status]).toEqual([path, 400])
        expect(await res.json()).toEqual({ error: 'Invalid path' })
      }
    })
  }

  it('file still serves ordinary files, nested settings-named directories and in-workspace links', async () => {
    const readme = await get('file', 'docs/readme.md')
    expect(readme.status).toBe(200)
    expect(((await readme.json()) as { content: string }).content).toBe('hello')

    const nested = await get('file', 'docs/.ficus/config.json')
    expect(nested.status).toBe(200)
    expect(((await nested.json()) as { content: string }).content).toBe('{"nested":true}')

    const viaLink = await get('file', 'self-link/notes.txt')
    expect(viaLink.status).toBe(200)
    expect(((await viaLink.json()) as { content: string }).content).toBe('notes')
  })

  it('tree lists the root without the settings directory and still lists nested ones', async () => {
    const root = await get('tree', '', '&depth=3')
    expect(root.status).toBe(200)
    const rootBody = (await root.json()) as { children: Array<{ name: string; children?: Array<{ name: string }> }> }
    expect(rootBody.children.map((child) => child.name)).not.toContain('.ficus')
    expect(rootBody.children.map((child) => child.name)).toContain('docs')

    const viaSelfLink = await get('tree', 'self-link')
    expect(viaSelfLink.status).toBe(200)
    const selfLinkBody = JSON.parse(await expectNoSecret(viaSelfLink)) as { children: Array<{ name: string }> }
    const names = selfLinkBody.children.map((child) => child.name)
    expect(names).not.toContain('.ficus')
  })

  it('download archives the root without the settings directory, as zip and tar.gz', async () => {
    for (const path of ['.', 'self-link']) {
      const tgz = await get('download', path, '&archive=tar.gz')
      expect(tgz.status).toBe(200)
      const archivePath = join(base, 'root.tar.gz')
      writeFileSync(archivePath, Buffer.from(await tgz.arrayBuffer()))
      const listing = Bun.spawnSync(['tar', '-tzf', archivePath]).stdout.toString().split('\n').filter(Boolean)
      expect(listing.some((entry) => /^[^/]+\/\.ficus(\/|$)/.test(entry))).toBe(false)
      expect(listing.some((entry) => entry.endsWith('/docs/.ficus/config.json'))).toBe(true)
      expect(listing.some((entry) => entry.endsWith('/notes.txt'))).toBe(true)
      const contents = Bun.spawnSync(['tar', '-xzOf', archivePath]).stdout.toString()
      expect(contents).not.toContain(SETTING_VALUE)
      expect(contents).not.toContain(TOKEN_VALUE)
    }

    const zip = await get('download', '.')
    expect(zip.status).toBe(200)
    const zipPath = join(base, 'root.zip')
    writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()))
    // Names, then every entry's stored bytes (links are stored as links, never followed).
    const inspect = Bun.spawnSync([
      'python3',
      '-c',
      'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint("\\n".join(z.namelist()))\nprint("".join(z.read(n).decode("utf-8","replace") for n in z.namelist()))',
      zipPath,
    ])
    expect(inspect.exitCode).toBe(0)
    const zipText = inspect.stdout.toString()
    expect(zipText.split('\n').some((entry) => /^\.ficus(\/|$)/.test(entry))).toBe(false)
    expect(zipText).toContain('docs/.ficus/config.json')
    expect(zipText).not.toContain(SETTING_VALUE)
    expect(zipText).not.toContain(TOKEN_VALUE)
  })

  it('download still serves an ordinary file', async () => {
    const res = await get('download', 'docs/readme.md')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })

  it('search never returns files from the settings directory', async () => {
    for (const q of ['token', '.env', 'ficus', '']) {
      const res = await app.request(`/api/squads/${squadId}/workspace/search?q=${encodeURIComponent(q)}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const files = ((await res.json()) as { files: string[] }).files
      expect([q, files.filter((file) => /^\.ficus(\/|$)/i.test(file))]).toEqual([q, []])
    }
  })

  it('the assistant file reader refuses the settings directory and reads ordinary files', async () => {
    const identity = { type: 'user' as const, userId: admin.id }
    for (const path of ['.ficus/.env', 'docs/../.ficus/.env', '.FICUS/.env', 'settings-link/.env', 'docs/env-link']) {
      await expect(readSquadFile(identity, { squadId, path })).rejects.toThrow('File not found')
    }
    expect((await readSquadFile(identity, { squadId, path: 'docs/readme.md' })).content).toBe('hello')
  })
})
