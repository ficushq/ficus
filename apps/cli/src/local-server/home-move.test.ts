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
import {
  recoveryCliHome,
  cliHome,
  finalizeCliHome,
  LEGACY_CLI_HOME_LINK,
  moveCliHome,
  unmoveCliHome,
} from './home-move'

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
    expect(cliHome({ homedir: home })).toBe(ficus)
    expect(recoveryCliHome(home)).toBe(legacy)
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
    expect(cliHome({ homedir: '/nowhere', exists })).toBe(join('/nowhere', '.ficus'))
    expect(seen).toEqual([])
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
  it('refuses when ~/.ficus appears while the running check is answering', async () => {
    mkdirSync(legacy)
    const running = async () => {
      mkdirSync(join(ficus, 'cli'), { recursive: true })
      return false
    }
    await expect(moveCliHome({ homedir: home, running })).rejects.toThrow(/already exists/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
  })
  it('refuses to move across filesystems, touching nothing', async () => {
    mkdirSync(legacy)
    const statDev = (p: string) => (p === legacy ? 1 : 2)
    await expect(moveCliHome({ homedir: home, running: notRunning, statDev })).rejects.toThrow(/different filesystem/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
    expect(existsSync(ficus)).toBe(false)
  })
  it('moves the home back and rethrows when the link cannot be created', async () => {
    mkdirSync(join(legacy, 'cli'), { recursive: true })
    const symlink = () => {
      throw new Error('link refused')
    }
    await expect(moveCliHome({ homedir: home, running: notRunning, symlink })).rejects.toThrow('link refused')
    expect(lstatSync(legacy).isDirectory()).toBe(true)
    expect(existsSync(join(legacy, 'cli'))).toBe(true)
    expect(existsSync(ficus)).toBe(false)
  })
  it('names both paths when the link fails and the legacy home was recreated meanwhile', async () => {
    mkdirSync(join(legacy, 'cli'), { recursive: true })
    writeFileSync(join(legacy, 'cli', 'auth.json'), '{}')
    const symlink = (_target: string, path: string) => {
      // Another process recreates the legacy home (non-empty) between the rename and the link.
      mkdirSync(join(path, 'cli'), { recursive: true })
      throw new Error('link refused')
    }
    const error = (await moveCliHome({ homedir: home, running: notRunning, symlink }).catch((e) => e)) as Error
    expect(error.message).toContain(`the data is in ${ficus}`)
    expect(error.message).toContain(`${legacy} was recreated by another process`)
    expect(error.message).toContain('link refused')
    expect(readFileSync(join(ficus, 'cli', 'auth.json'), 'utf8')).toBe('{}')
  })
  it('refuses a legacy link that points somewhere else', async () => {
    mkdirSync(join(home, 'elsewhere'))
    symlinkSync('elsewhere', legacy)
    await expect(moveCliHome({ homedir: home, running: notRunning })).rejects.toThrow(/symlink/)
  })
})

describe('unmoveCliHome', () => {
  it('puts a moved home back: the link goes and the directory returns to the legacy name', async () => {
    mkdirSync(join(legacy, 'cli'), { recursive: true })
    writeFileSync(join(legacy, 'cli', 'auth.json'), '{}')
    await moveCliHome({ homedir: home, running: notRunning })
    expect(unmoveCliHome({ homedir: home })).toBe('moved-back')
    expect(lstatSync(legacy).isDirectory()).toBe(true)
    expect(readFileSync(join(legacy, 'cli', 'auth.json'), 'utf8')).toBe('{}')
    expect(existsSync(ficus)).toBe(false)
    // Idempotent: a home that is already back is left alone.
    expect(unmoveCliHome({ homedir: home })).toBe('none')
  })
  it('finishes an inverse cut short after the link was removed', () => {
    mkdirSync(ficus)
    expect(unmoveCliHome({ homedir: home })).toBe('moved-back')
    expect(lstatSync(legacy).isDirectory()).toBe(true)
  })
  it('refuses any other shape and changes nothing', () => {
    mkdirSync(legacy)
    mkdirSync(ficus)
    expect(() => unmoveCliHome({ homedir: home })).toThrow(/by hand/)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
    expect(lstatSync(ficus).isDirectory()).toBe(true)
  })
})

describe('finalizeCliHome', () => {
  let link: string
  beforeEach(() => {
    link = join(home, LEGACY_CLI_HOME_LINK)
  })
  it('names the same legacy home as the bridge constant while both exist', () => {
    expect(LEGACY_CLI_HOME_LINK).toBe(LEGACY_HOME_DIR_NAME)
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
