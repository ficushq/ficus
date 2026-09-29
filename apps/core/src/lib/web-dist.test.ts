import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { resolveFarmDist, resolveWebDist } from './web-dist'

describe('resolveWebDist', () => {
  const origEnv = process.env.FICUS_WEB_DIST
  const origCwd = process.cwd()
  let tmp: string
  // A walk-up origin with no package.json above it, so the repo-root step finds
  // nothing and the later search steps are the ones under test. Without this the
  // developer's OWN repo (which has a real apps/web/dist whenever the web app or
  // a core artifact has been built) would answer first and mask the fallbacks.
  let rootless: string

  beforeEach(() => {
    // Resolve symlinks (e.g. macOS /var -> /private/var) so expected paths match
    // the realpath-resolved cwd that resolveWebDist derives from process.cwd().
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-web-dist-')))
    rootless = join(tmp, 'rootless')
    mkdirSync(rootless, { recursive: true })
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.FICUS_WEB_DIST
    else process.env.FICUS_WEB_DIST = origEnv
    process.chdir(origCwd)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('honours FICUS_WEB_DIST when set', () => {
    const explicit = join(tmp, 'custom')
    mkdirSync(explicit, { recursive: true })
    process.env.FICUS_WEB_DIST = explicit
    expect(resolveWebDist(rootless)).toBe(explicit)
  })

  it('expands a leading ~ in FICUS_WEB_DIST', () => {
    // resolve() alone turns `~/web` into `<cwd>/~/web` — a directory literally
    // named `~`. Expansion has to happen before resolution.
    process.env.FICUS_WEB_DIST = '~/ficus-web-dist-fixture'
    expect(resolveWebDist(rootless)).toBe(join(homedir(), 'ficus-web-dist-fixture'))
  })

  it('prefers the repo root discovered by walking up from the module directory', () => {
    delete process.env.FICUS_WEB_DIST
    const repoRoot = join(tmp, 'repo')
    const dist = join(repoRoot, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'ficus' }))
    // cwd deliberately elsewhere: only the walk-up can produce this answer.
    process.chdir(tmp)
    expect(resolveWebDist(join(repoRoot, 'apps', 'core', 'src', 'lib'))).toBe(dist)
  })

  it('finds a repo root whose package.json is named ficus', () => {
    delete process.env.FICUS_WEB_DIST
    const repoRoot = join(tmp, 'repo')
    const dist = join(repoRoot, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'ficus' }))
    // cwd deliberately elsewhere: only the walk-up can produce this answer.
    process.chdir(tmp)
    expect(resolveWebDist(join(repoRoot, 'apps', 'core', 'src', 'lib'))).toBe(dist)
  })

  it('falls back to <cwd>/apps/web/dist', () => {
    delete process.env.FICUS_WEB_DIST
    const repoRoot = join(tmp, 'repo')
    const dist = join(repoRoot, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'ficus' }))
    process.chdir(repoRoot)
    expect(resolveWebDist(rootless)).toBe(dist)
  })

  it('returns undefined when nothing is found', () => {
    delete process.env.FICUS_WEB_DIST
    process.chdir(tmp)
    expect(resolveWebDist(rootless)).toBeUndefined()
  })
})

describe('resolveFarmDist', () => {
  const origEnv = process.env.FICUS_FARM_DIST
  let tmp: string

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-farm-dist-')))
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.FICUS_FARM_DIST
    else process.env.FICUS_FARM_DIST = origEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  it('honours FICUS_FARM_DIST when set', () => {
    process.env.FICUS_FARM_DIST = join(tmp, 'custom')
    expect(resolveFarmDist(tmp)).toBe(join(tmp, 'custom'))
  })

  it('prefers the farm the web build placed inside the web dist', () => {
    delete process.env.FICUS_FARM_DIST
    const origWeb = process.env.FICUS_WEB_DIST
    const webDist = join(tmp, 'web-dist')
    mkdirSync(join(webDist, 'farm'), { recursive: true })
    writeFileSync(join(webDist, 'farm', 'index.html'), 'farm')
    process.env.FICUS_WEB_DIST = webDist
    try {
      expect(resolveFarmDist(tmp)).toBe(join(webDist, 'farm'))
    } finally {
      if (origWeb === undefined) delete process.env.FICUS_WEB_DIST
      else process.env.FICUS_WEB_DIST = origWeb
    }
  })

  it('finds apps/farm/dist under the discovered repo root', () => {
    delete process.env.FICUS_FARM_DIST
    const repoRoot = join(tmp, 'repo')
    const dist = join(repoRoot, 'apps', 'farm', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'ficus' }))
    expect(resolveFarmDist(join(repoRoot, 'apps', 'core', 'src', 'lib'))).toBe(dist)
  })
})
