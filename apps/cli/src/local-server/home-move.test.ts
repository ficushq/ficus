import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_HOME_DIR_NAME } from '@ficus/shared/node'
import { cliHome, finalizeCliHome, moveCliHome } from './home-move'

let home: string
let ficus: string
let legacy: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-move-')))
  ficus = join(home, '.ficus')
  legacy = join(home, LEGACY_HOME_DIR_NAME)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const notRunning = async () => false

describe('cliHome', () => {
  it('is ~/.ficus when neither home exists (a fresh install)', () => {
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('is the legacy home when only it exists (not moved yet)', () => {
    mkdirSync(legacy)
    expect(cliHome({ homedir: home })).toBe(legacy)
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
      return p === join('/nowhere', LEGACY_HOME_DIR_NAME)
    }
    expect(cliHome({ homedir: '/nowhere', exists })).toBe(join('/nowhere', LEGACY_HOME_DIR_NAME))
    expect(seen).toContain('/nowhere/.ficus')
  })
})

describe('moveCliHome', () => {
  it('moves the legacy home to ~/.ficus and leaves a relative link that resolves to it', async () => {
    mkdirSync(join(legacy, 'cli'), { recursive: true })
    writeFileSync(join(legacy, 'cli', 'auth.json'), '{"backends":{}}')
    expect(await moveCliHome({ homedir: home, running: notRunning })).toBe('moved')
    expect(lstatSync(ficus).isDirectory()).toBe(true)
    expect(readFileSync(join(ficus, 'cli', 'auth.json'), 'utf8')).toBe('{"backends":{}}')
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
    expect(readlinkSync(legacy)).toBe('.ficus')
    expect(realpathSync(legacy)).toBe(ficus)
    // Old paths keep working through the link.
    expect(readFileSync(join(legacy, 'cli', 'auth.json'), 'utf8')).toBe('{"backends":{}}')
    expect(cliHome({ homedir: home })).toBe(ficus)
  })
  it('refuses while the local server is running, and leaves both homes as they were', async () => {
    mkdirSync(legacy)
    await expect(moveCliHome({ homedir: home, running: async () => true })).rejects.toThrow(/running/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
    expect(existsSync(ficus)).toBe(false)
  })
  it('refuses when ~/.ficus already exists', async () => {
    mkdirSync(legacy)
    mkdirSync(ficus)
    await expect(moveCliHome({ homedir: home, running: notRunning })).rejects.toThrow(/already exists/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
  })
  it('reports already on a second run', async () => {
    mkdirSync(legacy)
    expect(await moveCliHome({ homedir: home, running: notRunning })).toBe('moved')
    expect(await moveCliHome({ homedir: home, running: notRunning })).toBe('already')
    expect(readlinkSync(legacy)).toBe('.ficus')
  })
  it('reports none when there is no legacy home to move', async () => {
    expect(await moveCliHome({ homedir: home, running: notRunning })).toBe('none')
    expect(existsSync(ficus)).toBe(false)
  })
  it('refuses a legacy link that points somewhere else', async () => {
    mkdirSync(join(home, 'elsewhere'))
    symlinkSync('elsewhere', legacy)
    await expect(moveCliHome({ homedir: home, running: notRunning })).rejects.toThrow(/symlink/)
  })
})

describe('finalizeCliHome', () => {
  it('keeps the link while ~/.ficus/bin is not on PATH', async () => {
    mkdirSync(ficus)
    symlinkSync('.ficus', legacy)
    expect(await finalizeCliHome({ homedir: home, path: '/usr/bin:/bin' })).toBe('kept-not-on-path')
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
  })
  it('removes the link once ~/.ficus/bin is on PATH', async () => {
    mkdirSync(ficus)
    symlinkSync('.ficus', legacy)
    expect(await finalizeCliHome({ homedir: home, path: `/usr/bin:${join(ficus, 'bin')}/:/bin` })).toBe('removed')
    expect(existsSync(legacy)).toBe(false)
    expect(lstatSync(ficus).isDirectory()).toBe(true)
  })
  it('reports absent when there is no legacy home', async () => {
    expect(await finalizeCliHome({ homedir: home, path: join(ficus, 'bin') })).toBe('absent')
  })
  it('never removes a legacy home that is not the link a move left', async () => {
    mkdirSync(legacy)
    await expect(finalizeCliHome({ homedir: home, path: join(ficus, 'bin') })).rejects.toThrow(/not the link/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
  })
})
