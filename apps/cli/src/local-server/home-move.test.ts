import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cliHome, finalizeCliHome, LEGACY_CLI_HOME_LINK } from './home-move'

let home: string
let ficus: string
let legacy: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-move-')))
  ficus = join(home, '.ficus')
  legacy = join(home, LEGACY_CLI_HOME_LINK)
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
      return p === join('/nowhere', LEGACY_CLI_HOME_LINK)
    }
    expect(cliHome({ homedir: '/nowhere', exists })).toBe(join('/nowhere', '.ficus'))
    expect(seen).toEqual([])
  })
})

describe('finalizeCliHome', () => {
  let link: string
  beforeEach(() => {
    link = join(home, LEGACY_CLI_HOME_LINK)
  })
  it('retains the old-home link name until Apple finalization', () => {
    expect(LEGACY_CLI_HOME_LINK).toBe('.tau') // ficus-p5-apple
  })
  it('keeps the link while ~/.ficus/bin is not on PATH', async () => {
    mkdirSync(ficus)
    symlinkSync('.ficus', link)
    expect(await finalizeCliHome({ homedir: home, path: '/usr/bin:/bin' })).toBe('kept-not-on-path')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
  it('removes the link once ~/.ficus/bin is on PATH', async () => {
    mkdirSync(ficus)
    symlinkSync('.ficus', link)
    expect(await finalizeCliHome({ homedir: home, path: `/usr/bin:${join(ficus, 'bin')}/:/bin` })).toBe('removed')
    expect(existsSync(link)).toBe(false)
    expect(lstatSync(ficus).isDirectory()).toBe(true)
  })
  it('reports absent when there is no legacy home', async () => {
    expect(await finalizeCliHome({ homedir: home, path: join(ficus, 'bin') })).toBe('absent')
  })
  it('never removes a legacy home that is not the link a move left', async () => {
    mkdirSync(link)
    await expect(finalizeCliHome({ homedir: home, path: join(ficus, 'bin') })).rejects.toThrow(/not the link/)
    expect(lstatSync(link).isDirectory()).toBe(true)
  })
})
