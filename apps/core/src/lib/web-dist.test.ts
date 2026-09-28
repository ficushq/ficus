import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { resolveWebDist } from './web-dist'

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
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tau-web-dist-')))
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
    process.env.FICUS_WEB_DIST = '~/tau-web-dist-fixture'
    expect(resolveWebDist(rootless)).toBe(join(homedir(), 'tau-web-dist-fixture'))
  })

  it('prefers the repo root discovered by walking up from the module directory', () => {
    delete process.env.FICUS_WEB_DIST
    const repoRoot = join(tmp, 'repo')
    const dist = join(repoRoot, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'tau' }))
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
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'tau' }))
    process.chdir(repoRoot)
    expect(resolveWebDist(rootless)).toBe(dist)
  })

  it('returns undefined when nothing is found', () => {
    delete process.env.FICUS_WEB_DIST
    process.chdir(tmp)
    expect(resolveWebDist(rootless)).toBeUndefined()
  })
})
