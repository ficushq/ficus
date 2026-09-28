import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { BOOTSTRAP_INSTALLED_FLAG, BOOTSTRAP_STALE_FLAG } from '../services/updates/dependency-install'
import { bootstrapOfflineUpdate, USAGE, type BootstrapProcess } from './update-offline-bootstrap'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const BOOTSTRAP = join(import.meta.dir, 'update-offline-bootstrap.ts')
const DEPENDENCY_INSTALL = join(import.meta.dir, '../services/updates/dependency-install.ts')
const FROM = 'a'.repeat(40)
const UPDATE = ['bun', 'update-offline.ts']

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((m) => (m[1] ?? m[2])!)
}

describe('the bootstrap loads nothing the previous release may not have installed', () => {
  it('imports only built-ins and the import-free dependency-install module', () => {
    const specifiers = importSpecifiers(readFileSync(BOOTSTRAP, 'utf8'))
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:') || specifier === '../services/updates/dependency-install').toBe(true)
    }
    expect(readFileSync(BOOTSTRAP, 'utf8')).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })
  it('dependency-install.ts imports nothing', () => {
    const source = readFileSync(DEPENDENCY_INSTALL, 'utf8')
    expect(importSpecifiers(source)).toEqual([])
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })
  it('reads no environment, so the legacy-env bridge in update-offline.ts still runs first', () => {
    expect(readFileSync(BOOTSTRAP, 'utf8')).not.toContain('process.env')
  })
  it('is what the root update:offline script runs', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts
    expect(scripts['update:offline']).toBe('bun apps/core/src/scripts/update-offline-bootstrap.ts')
  })
})

describe('bootstrapOfflineUpdate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-offline-bootstrap-'))
    write(join(root, 'package.json'), JSON.stringify({ name: 'ficus', workspaces: ['apps/*', 'packages/*'] }))
    write(join(root, 'packages/shared/package.json'), JSON.stringify({ name: '@ficus/shared' }))
    write(join(root, 'apps/core/package.json'), JSON.stringify({ name: 'core' }))
    mkdirSync(join(root, 'packages/no-package'), { recursive: true })
    // Dependencies installed by the previous release: its scope only.
    write(join(root, 'node_modules/@tau/shared/package.json'), JSON.stringify({ name: '@tau/shared' }))
    mkdirSync(join(root, 'node_modules/core'), { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A fake process runner: `bun install` links the workspace packages, the update checks it can load them. */
  function fakeRun(diff: string, opts: { installCode?: number; installLinks?: boolean } = {}) {
    const calls: Array<{ command: string[]; ficusShared: boolean; tauScope: boolean }> = []
    const run: BootstrapProcess = async (command, { cwd }) => {
      expect(cwd).toBe(root)
      calls.push({
        command,
        ficusShared: existsSync(join(root, 'node_modules/@ficus/shared')),
        tauScope: existsSync(join(root, 'node_modules/@tau')),
      })
      if (command[0] === 'git') return { code: 0, stdout: diff }
      if (command[1] === 'install') {
        if (opts.installLinks !== false) mkdirSync(join(root, 'node_modules/@ficus/shared'), { recursive: true })
        return { code: opts.installCode ?? 0, stdout: '' }
      }
      return { code: 0, stdout: '' }
    }
    return { run, calls }
  }

  it('installs before running the update when the workspace packages are not installed', async () => {
    const { run, calls } = fakeRun('apps/core/src/x.ts\n')
    const code = await bootstrapOfflineUpdate({
      root,
      args: ['--from', FROM],
      run,
      updateCommand: UPDATE,
      log: () => {},
    })
    expect(code).toBe(0)
    expect(calls.map((c) => c.command)).toEqual([
      ['git', 'diff', '--name-only', `${FROM}..HEAD`],
      ['bun', 'install', '--frozen-lockfile'],
      [...UPDATE, '--from', FROM, BOOTSTRAP_INSTALLED_FLAG, BOOTSTRAP_STALE_FLAG],
    ])
    // The install ran while only the old scope was there; the update (the first
    // workspace import) ran after it, with the new scope and without the old one.
    expect(calls[1]).toMatchObject({ ficusShared: false, tauScope: true })
    expect(calls[2]).toMatchObject({ ficusShared: true, tauScope: false })
  })

  it('installs when the diff changes the dependencies, without calling the tree stale', async () => {
    mkdirSync(join(root, 'node_modules/@ficus/shared'), { recursive: true })
    rmSync(join(root, 'node_modules/@tau'), { recursive: true })
    const { run, calls } = fakeRun('bun.lock\napps/core/src/x.ts\n')
    expect(
      await bootstrapOfflineUpdate({ root, args: ['--from', FROM], run, updateCommand: UPDATE, log: () => {} })
    ).toBe(0)
    expect(calls.map((c) => c.command.join(' '))).toEqual([
      `git diff --name-only ${FROM}..HEAD`,
      'bun install --frozen-lockfile',
      `bun update-offline.ts --from ${FROM} ${BOOTSTRAP_INSTALLED_FLAG}`,
    ])
  })

  it('skips the install when nothing about the dependencies changed', async () => {
    mkdirSync(join(root, 'node_modules/@ficus/shared'), { recursive: true })
    const { run, calls } = fakeRun('apps/core/src/x.ts\n')
    expect(
      await bootstrapOfflineUpdate({ root, args: ['--', '--from', FROM], run, updateCommand: UPDATE, log: () => {} })
    ).toBe(0)
    expect(calls.map((c) => c.command.join(' '))).toEqual([
      `git diff --name-only ${FROM}..HEAD`,
      `bun update-offline.ts -- --from ${FROM}`,
    ])
    // A leftover old scope is pruned even without an install.
    expect(existsSync(join(root, 'node_modules/@tau'))).toBe(false)
  })

  it('installs when the diff cannot be read, and lets the update report that', async () => {
    mkdirSync(join(root, 'node_modules/@ficus/shared'), { recursive: true })
    const calls: string[] = []
    const code = await bootstrapOfflineUpdate({
      root,
      args: ['--from', FROM],
      run: async (command) => {
        calls.push(command.join(' '))
        return command[0] === 'git' ? { code: 128, stdout: '' } : { code: command[1] === 'install' ? 0 : 1, stdout: '' }
      },
      updateCommand: UPDATE,
      log: () => {},
    })
    expect(code).toBe(1)
    expect(calls.slice(1)).toEqual([
      'bun install --frozen-lockfile',
      `bun update-offline.ts --from ${FROM} ${BOOTSTRAP_INSTALLED_FLAG}`,
    ])
  })

  it('stops, leaving node_modules alone, when the install fails', async () => {
    const { run, calls } = fakeRun('bun.lock\n', { installCode: 1, installLinks: false })
    const errors: string[] = []
    const code = await bootstrapOfflineUpdate({
      root,
      args: ['--from', FROM],
      run,
      updateCommand: UPDATE,
      log: () => {},
      error: (l) => errors.push(l),
    })
    expect(code).toBe(1)
    expect(calls.map((c) => c.command[1])).toEqual(['diff', 'install'])
    expect(errors).toEqual(['offline update failed: bun install --frozen-lockfile exited with 1'])
    expect(existsSync(join(root, 'node_modules/@tau'))).toBe(true)
  })

  it('stops when the install succeeds but the workspace packages are still missing', async () => {
    const { run, calls } = fakeRun('', { installLinks: false })
    const errors: string[] = []
    const code = await bootstrapOfflineUpdate({
      root,
      args: ['--from', FROM],
      run,
      updateCommand: UPDATE,
      log: () => {},
      error: (l) => errors.push(l),
    })
    expect(code).toBe(1)
    expect(calls.map((c) => c.command[1])).toEqual(['diff', 'install'])
    expect(errors[0]).toContain('@ficus/shared still not installed')
  })

  it('prints the usage and runs nothing without a valid --from', async () => {
    const { run, calls } = fakeRun('')
    const errors: string[] = []
    const code = await bootstrapOfflineUpdate({ root, args: ['--from', 'HEAD'], run, error: (l) => errors.push(l) })
    expect(code).toBe(2)
    expect(errors).toEqual([USAGE])
    expect(calls).toEqual([])
  })
})

describe('bun run update:offline across a package-scope rename (real processes)', () => {
  let root: string
  let bin: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-offline-rename-'))
    bin = mkdtempSync(join(tmpdir(), 'ficus-offline-bin-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  function git(...args: string[]): string {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }

  it('installs the new scope before the new release imports it', () => {
    // The previous release: `@tau/shared`, installed.
    write(join(root, '.gitignore'), 'node_modules\n')
    write(
      join(root, 'package.json'),
      JSON.stringify({ name: 'tau', workspaces: ['packages/*'], scripts: { 'update:offline': 'true' } })
    )
    write(join(root, 'packages/shared/package.json'), JSON.stringify({ name: '@tau/shared', main: 'index.ts' }))
    write(join(root, 'packages/shared/index.ts'), `export const scope = 'shared'\n`)
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'tau')
    const from = git('rev-parse', 'HEAD')
    mkdirSync(join(root, 'node_modules/@tau'), { recursive: true })
    symlinkSync('../../packages/shared', join(root, 'node_modules/@tau/shared'))

    // The new release renames the scope; its update script imports the new name.
    write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'ficus',
        workspaces: ['packages/*'],
        scripts: { 'update:offline': 'bun apps/core/src/scripts/update-offline-bootstrap.ts' },
      })
    )
    write(join(root, 'packages/shared/package.json'), JSON.stringify({ name: '@ficus/shared', main: 'index.ts' }))
    mkdirSync(join(root, 'apps/core/src/scripts'), { recursive: true })
    mkdirSync(join(root, 'apps/core/src/services/updates'), { recursive: true })
    copyFileSync(BOOTSTRAP, join(root, 'apps/core/src/scripts/update-offline-bootstrap.ts'))
    copyFileSync(DEPENDENCY_INSTALL, join(root, 'apps/core/src/services/updates/dependency-install.ts'))
    write(
      join(root, 'apps/core/src/scripts/update-offline.ts'),
      `import { scope } from '@ficus/shared'\nconsole.log('REAL UPDATE', scope, JSON.stringify(process.argv.slice(2)))\n`
    )
    git('add', '-A')
    git('commit', '-qm', 'ficus')

    // Loading the new release's update directly is the reported crash.
    const direct = Bun.spawnSync([process.execPath, 'apps/core/src/scripts/update-offline.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(direct.exitCode).not.toBe(0)
    expect(direct.stderr.toString()).toContain("Cannot find module '@ficus/shared'")

    // A `bun` on PATH whose install links the renamed package (a real install needs the network).
    const log = join(bin, 'install.log')
    write(
      join(bin, 'bun'),
      `#!/bin/sh\nif [ "$1" = install ]; then\n  echo "$@" >> '${log}'\n  mkdir -p node_modules/@ficus && ln -s ../../packages/shared node_modules/@ficus/shared\n  exit 0\nfi\nexec '${process.execPath}' "$@"\n`
    )
    chmodSync(join(bin, 'bun'), 0o755)

    const result = Bun.spawnSync([join(bin, 'bun'), 'run', 'update:offline', '--', '--from', from], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    const out = result.stdout.toString()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(readFileSync(log, 'utf8').trim()).toBe('install --frozen-lockfile')
    expect(out).toContain('Installing dependencies before loading this release (not installed: @ficus/shared)')
    expect(out).toContain('Removing stale node_modules/@tau')
    expect(out).toContain(
      `REAL UPDATE shared ["--from","${from}","${BOOTSTRAP_INSTALLED_FLAG}","${BOOTSTRAP_STALE_FLAG}"]`
    )
    expect(out.indexOf('Installing dependencies')).toBeLessThan(out.indexOf('REAL UPDATE'))
    expect(existsSync(join(root, 'node_modules/@tau'))).toBe(false)
  })
})
