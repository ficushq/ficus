import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  devboxHasPackages,
  prepareDevboxShellEnv,
  cacheDevboxShellEnv,
  getDevboxShellEnv,
  refreshDevboxShellEnvIfDirty,
  shouldSelfCacheDevboxEnvOnBoot,
  selfCacheDevboxEnvOnBoot,
  cacheManagedToolchainEnv,
  ManagedToolchainTimeoutError,
  clearManagedToolchainEnv,
} from './devbox-env'

function writeDevbox(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devbox-env-'))
  const path = join(dir, 'devbox.json')
  writeFileSync(path, contents)
  return path
}

describe('devboxHasPackages', () => {
  test('empty package array → false (the agent light box default)', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":[]}'))).toBe(false)
  })

  test('populated package array → true', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":["nodejs_24@latest"]}'))).toBe(true)
  })

  test('missing packages key → false', () => {
    expect(devboxHasPackages(writeDevbox('{}'))).toBe(false)
  })

  test('populated package MAP → true (devbox rewrites devbox.json into map form after `devbox add --outputs`)', () => {
    expect(
      devboxHasPackages(
        writeDevbox('{"packages":{"nodejs_24":"latest","zlib":{"version":"latest","outputs":["dev"]}}}')
      )
    ).toBe(true)
  })

  test('empty package map → false (nothing to shellenv, same as an empty array)', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":{}}'))).toBe(false)
  })

  test('non-collection packages value → false', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":"nodejs"}'))).toBe(false)
    expect(devboxHasPackages(writeDevbox('{"packages":null}'))).toBe(false)
  })

  test('missing file or malformed JSON → false (never throws)', () => {
    expect(devboxHasPackages('/no/such/devbox.json')).toBe(false)
    expect(devboxHasPackages(writeDevbox('{ not json'))).toBe(false)
  })
})

describe('cacheDevboxShellEnv skip paths (no event-loop-blocking devbox shellenv)', () => {
  const prevWorkspace = process.env.WORKSPACE_PATH
  const prevDevboxDir = process.env.FICUS_DEVBOX_DIR

  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = prevWorkspace
    if (prevDevboxDir === undefined) delete process.env.FICUS_DEVBOX_DIR
    else process.env.FICUS_DEVBOX_DIR = prevDevboxDir
  })

  test('empty-packages devbox.json is skipped — cache stays empty, no shellenv run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-env-ws-'))
    writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
    process.env.WORKSPACE_PATH = dir
    delete process.env.FICUS_DEVBOX_DIR

    // Must return promptly without invoking `devbox shellenv` (which would hang
    // ~30s against an un-realized empty devbox and block the server event loop).
    const start = performance.now()
    cacheDevboxShellEnv()
    const elapsedMs = performance.now() - start

    expect(getDevboxShellEnv()).toBe('')
    expect(elapsedMs).toBeLessThan(1000)
    rmSync(dir, { recursive: true, force: true })
  })

  test('missing devbox.json is skipped — cache stays empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-env-ws-'))
    process.env.WORKSPACE_PATH = dir
    delete process.env.FICUS_DEVBOX_DIR
    cacheDevboxShellEnv()
    expect(getDevboxShellEnv()).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('managed toolchain shellenv cache', () => {
  const previousToolchainDir = process.env.FICUS_TOOLCHAIN_DIR
  const dirs: string[] = []

  afterEach(() => {
    clearManagedToolchainEnv()
    if (previousToolchainDir === undefined) delete process.env.FICUS_TOOLCHAIN_DIR
    else process.env.FICUS_TOOLCHAIN_DIR = previousToolchainDir
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('appends managed activation after the existing cache when Core requests it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.FICUS_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    const existingCache = getDevboxShellEnv()

    await cacheManagedToolchainEnv(false, undefined, () => 'should not run')
    expect(getDevboxShellEnv()).toBe(existingCache)

    await cacheManagedToolchainEnv(true, undefined, () => 'export MANAGED=1')
    expect(getDevboxShellEnv()).toContain(existingCache)
    expect(
      execFileSync('/bin/bash', ['-c', `${getDevboxShellEnv()}\nprintf '%s' "$MANAGED"`], { encoding: 'utf8' })
    ).toBe('1')
    clearManagedToolchainEnv()
    expect(getDevboxShellEnv()).toBe(existingCache)
  })

  test('reuses the active environment for an unchanged fingerprint and re-resolves a new one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.FICUS_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    let runs = 0
    const shellenv = () => `export MANAGED=${++runs}`
    expect(await cacheManagedToolchainEnv(true, 'fp-1', shellenv)).toBe('refreshed')
    // Core confirms readiness before every turn; an unchanged toolchain must not re-run devbox.
    expect(await cacheManagedToolchainEnv(true, 'fp-1', shellenv)).toBe('cached')
    expect(runs).toBe(1)
    expect(await cacheManagedToolchainEnv(true, 'fp-2', shellenv)).toBe('refreshed')
    expect(getDevboxShellEnv()).toContain('MANAGED=2')
    // A request without a fingerprint (older Core) always re-resolves.
    expect(await cacheManagedToolchainEnv(true, undefined, shellenv)).toBe('refreshed')
    expect(runs).toBe(3)
    // Clearing forgets the fingerprint, so the next activation resolves again.
    await cacheManagedToolchainEnv(false)
    expect(await cacheManagedToolchainEnv(true, 'fp-2', shellenv)).toBe('refreshed')
    clearManagedToolchainEnv()
  })

  test('a timed-out activation is reported as a timeout and leaves no stale environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.FICUS_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    await expect(
      cacheManagedToolchainEnv(true, 'fp', () => Promise.reject(new ManagedToolchainTimeoutError()))
    ).rejects.toBeInstanceOf(ManagedToolchainTimeoutError)
    expect(getDevboxShellEnv()).not.toContain('MANAGED')
  })

  test('clears stale activation when files disappear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.FICUS_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    writeFileSync(join(dir, '.ready'), 'fingerprint')
    await cacheManagedToolchainEnv(true, undefined, () => 'export MANAGED=1')
    rmSync(join(dir, 'devbox.json'))
    await expect(cacheManagedToolchainEnv(true, undefined, () => 'should not run')).rejects.toThrow()
    expect(getDevboxShellEnv()).not.toContain('MANAGED')
  })
})

describe('combined Devbox PATH', () => {
  test('keeps comfort tools discoverable with managed tools taking precedence', async () => {
    const previousDevbox = process.env.FICUS_DEVBOX_DIR
    const previousToolchain = process.env.FICUS_TOOLCHAIN_DIR
    const dir = mkdtempSync(join(tmpdir(), 'devbox-path-'))
    const comfort = join(dir, 'comfort tools')
    const managed = join(dir, 'managed tools')
    try {
      for (const path of [comfort, managed]) {
        mkdirSync(path)
        writeFileSync(join(path, 'devbox.json'), '{"packages":["fixture"]}')
        writeFileSync(join(path, 'node'), '#!/bin/sh\n', { mode: 0o755 })
      }
      writeFileSync(join(comfort, 'gh'), '#!/bin/sh\n', { mode: 0o755 })
      process.env.FICUS_DEVBOX_DIR = comfort
      process.env.FICUS_TOOLCHAIN_DIR = managed
      // Use only fixture directories: CI may have its own gh in /usr/bin.
      // The absolute shell and its command/printf builtins need no system PATH.
      cacheDevboxShellEnv(() => `export PATH='${comfort}'`)
      await cacheManagedToolchainEnv(true, undefined, () => `export PATH='${managed}'`)
      const resolve = () =>
        execFileSync('/bin/bash', ['-c', `${getDevboxShellEnv()}\ncommand -v gh; command -v node`], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
      expect(resolve()).toEqual([join(comfort, 'gh'), join(managed, 'node')])
      clearManagedToolchainEnv()
      expect(resolve()).toEqual([join(comfort, 'gh'), join(comfort, 'node')])
    } finally {
      clearManagedToolchainEnv()
      writeFileSync(join(comfort, 'devbox.json'), '{"packages":[]}')
      prepareDevboxShellEnv()
      if (previousDevbox === undefined) delete process.env.FICUS_DEVBOX_DIR
      else process.env.FICUS_DEVBOX_DIR = previousDevbox
      if (previousToolchain === undefined) delete process.env.FICUS_TOOLCHAIN_DIR
      else process.env.FICUS_TOOLCHAIN_DIR = previousToolchain
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshDevboxShellEnvIfDirty', () => {
  const previousBoxHome = process.env.FICUS_BOX_HOME
  const previousDevboxDir = process.env.FICUS_DEVBOX_DIR
  afterEach(() => {
    if (previousBoxHome === undefined) delete process.env.FICUS_BOX_HOME
    else process.env.FICUS_BOX_HOME = previousBoxHome
    if (previousDevboxDir === undefined) delete process.env.FICUS_DEVBOX_DIR
    else process.env.FICUS_DEVBOX_DIR = previousDevboxDir
  })

  test('consumes VM dirty markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')

    refreshDevboxShellEnvIfDirty()

    expect(existsSync(marker)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('replaces the cached shellenv from a non-empty VM devbox after consuming a marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["cowsay@latest"]}')

    cacheDevboxShellEnv(() => 'export CACHED_TOOL=before')
    expect(getDevboxShellEnv()).toContain('CACHED_TOOL=before')

    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')
    refreshDevboxShellEnvIfDirty(() => 'export CACHED_TOOL=after')

    expect(existsSync(marker)).toBe(false)
    expect(getDevboxShellEnv()).toContain('CACHED_TOOL=after')
    rmSync(dir, { recursive: true, force: true })
  })

  test('does not consume markers outside VM boxes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    delete process.env.FICUS_BOX_HOME
    process.env.FICUS_DEVBOX_DIR = dir
    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')

    refreshDevboxShellEnvIfDirty()

    expect(existsSync(marker)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('shouldSelfCacheDevboxEnvOnBoot (vm box boot self-cache gate)', () => {
  const prevBoxHome = process.env.FICUS_BOX_HOME
  const prevDevboxDir = process.env.FICUS_DEVBOX_DIR
  const prevWorkspace = process.env.WORKSPACE_PATH
  const dirs: string[] = []

  function restore(name: string, prev: string | undefined): void {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }

  afterEach(() => {
    restore('FICUS_BOX_HOME', prevBoxHome)
    restore('FICUS_DEVBOX_DIR', prevDevboxDir)
    restore('WORKSPACE_PATH', prevWorkspace)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function devboxDirWith(contents: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-boot-'))
    dirs.push(dir)
    if (contents !== null) writeFileSync(join(dir, 'devbox.json'), contents)
    return dir
  }

  test('FICUS_BOX_HOME set + devbox.json declaring packages → true (vm box, seeded)', () => {
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(true)
  })

  test('boot self-cache reports success only when shellenv was actually cached', () => {
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(selfCacheDevboxEnvOnBoot(() => 'export PATH=/realized/bin')).toBe(true)
    expect(
      selfCacheDevboxEnvOnBoot(() => {
        throw new Error('not realized')
      })
    ).toBe(false)
  })

  test('FICUS_BOX_HOME set + empty-packages devbox.json → false (un-realized; shellenv would hang)', () => {
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = devboxDirWith('{"packages":[]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })

  test('FICUS_BOX_HOME set + missing devbox.json → false (nothing to cache)', () => {
    process.env.FICUS_BOX_HOME = '/home/box_x'
    process.env.FICUS_DEVBOX_DIR = devboxDirWith(null)
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })

  test('FICUS_BOX_HOME UNSET → false even with a packaged devbox.json (k8s/docker boot parity)', () => {
    delete process.env.FICUS_BOX_HOME
    process.env.FICUS_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })
})

describe('prepareDevboxShellEnv readiness proof', () => {
  test('accepts empty global-profile config and rejects unrealized populated config', () => {
    const previous = process.env.FICUS_DEVBOX_DIR
    const dir = mkdtempSync(join(tmpdir(), 'devbox-prepare-'))
    try {
      process.env.FICUS_DEVBOX_DIR = dir
      writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
      expect(
        prepareDevboxShellEnv(() => {
          throw new Error('must not run')
        })
      ).toBe(true)
      writeFileSync(join(dir, 'devbox.json'), '{"packages":["nodejs"]}')
      expect(
        prepareDevboxShellEnv(() => {
          throw new Error('not realized')
        })
      ).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.FICUS_DEVBOX_DIR
      else process.env.FICUS_DEVBOX_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('map-form packages are a real environment: empty map is ready, populated map runs shellenv', () => {
    const previous = process.env.FICUS_DEVBOX_DIR
    const dir = mkdtempSync(join(tmpdir(), 'devbox-prepare-map-'))
    try {
      process.env.FICUS_DEVBOX_DIR = dir
      writeFileSync(join(dir, 'devbox.json'), '{"packages":{}}')
      expect(
        prepareDevboxShellEnv(() => {
          throw new Error('must not run')
        })
      ).toBe(true)
      writeFileSync(
        join(dir, 'devbox.json'),
        '{"packages":{"nodejs_24":"latest","zlib":{"version":"latest","outputs":["dev"]}}}'
      )
      let ran = 0
      expect(
        prepareDevboxShellEnv(() => {
          ran += 1
          return 'export PATH=/nix/store/abc/bin:$PATH'
        })
      ).toBe(true)
      expect(ran).toBe(1)
      expect(getDevboxShellEnv()).toContain('/nix/store/abc/bin')
    } finally {
      if (previous === undefined) delete process.env.FICUS_DEVBOX_DIR
      else process.env.FICUS_DEVBOX_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
