import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cliHome } from './home-move'

let home: string
let ficus: string
let legacy: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-move-')))
  ficus = join(home, '.ficus')
  legacy = join(home, '.tau')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('cliHome', () => {
  it('is ~/.ficus when neither home exists (a fresh install)', () => {
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('uses the canonical home even when only the old home exists', () => {
    mkdirSync(legacy)
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('is ~/.ficus when only it exists', () => {
    mkdirSync(ficus)
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('is ~/.ficus when both exist (moved: the legacy one is the link left behind)', () => {
    mkdirSync(ficus)
    symlinkSync('.ficus', legacy)
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('is ~/.ficus when both exist as real directories', () => {
    mkdirSync(ficus)
    mkdirSync(legacy)
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('asks the injected exists, never the real filesystem, when one is given', () => {
    const seen: string[] = []
    const exists = (p: string) => {
      seen.push(p)
      return p === join('/nowhere', '.tau')
    }
    expect(cliHome({ homedir: '/nowhere', exists })).toBe(join('/nowhere', '.ficus'))
    expect(seen).toEqual([])
  })
})
